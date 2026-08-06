// ============================================================
// Tiktok Infinity (マルチユーザー版)
// tiktok-live-connector v2 + Express + Socket.io
// 起動: node server.js
// ログイン : http://localhost:8181/login
// 管理画面 : http://localhost:8181/dashboard  (要ログイン)
// オーバーレイ: http://localhost:8181/overlay?u=<ユーザー名>  (OBSブラウザソースに登録)
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process'); // VOICEVOXコンテナの起動/停止に使用
const multer = require('multer');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

// ---- .env の読み込み ----
// APIキーなどを pm2 の環境変数に混ぜずに済ませるための最小実装。
// 既に環境変数がある場合はそちらを優先する(pm2側の BASE_PATH 等を壊さない)
try {
    const envFile = path.join(__dirname, '.env');
    if (fs.existsSync(envFile)) {
        for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (!m || line.trim().startsWith('#')) continue;
            if (!(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    }
} catch (e) { console.error('[.env 読み込み失敗]', e.message); }

// ---- 汎用: JSON読み書き ----
function readJSON(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(p, obj) {
    try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch (e) { console.error('[保存失敗]', p, e.message); }
}

// ---- パス構成 ----
const DATA_DIR = path.join(__dirname, 'data');       // ユーザーごとのデータ
const USERS_PATH = path.join(__dirname, 'users.json');
const SECRET_PATH = path.join(__dirname, 'session-secret');
const AUTH_PATH = path.join(__dirname, 'auth.json'); // 旧・管理者資格情報(移行に使用)
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function userDir(key) { return path.join(DATA_DIR, key); }
function userSoundsDir(key) { return path.join(userDir(key), 'sounds'); }
function userLibDir(key) { return path.join(userSoundsDir(key), 'lib'); }
function ensureUserDirs(key) { try { fs.mkdirSync(userLibDir(key), { recursive: true }); } catch (e) {} }

// ---- ユーザー名の正規化・検証 ----
function normKey(name) { return String(name || '').replace(/^@+/, '').trim().toLowerCase(); }
function validName(name) { return /^[a-z0-9._]{2,40}$/.test(normKey(name)); }

// ---- セッション秘密鍵 (署名Cookie用。無ければ生成) ----
let SECRET;
try { SECRET = fs.readFileSync(SECRET_PATH); }
catch (e) { SECRET = crypto.randomBytes(32); try { fs.writeFileSync(SECRET_PATH, SECRET); } catch (e2) {} }

// ---- パスワード(scryptで塩付きハッシュ) ----
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function safeEq(a, b) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ---- ユーザー管理 ----
let users = readJSON(USERS_PATH, null) || {}; // key -> {username, salt, hash, isAdmin, createdAt}
function saveUsers() { writeJSON(USERS_PATH, users); }
function createUser(username, password, isAdmin) {
    const key = normKey(username);
    if (!validName(key)) throw new Error('ユーザー名は英数字と . _ のみ、2〜40文字');
    if (!password || String(password).length < 4) throw new Error('パスワードは4文字以上');
    const salt = crypto.randomBytes(16).toString('hex');
    users[key] = { username: String(username).replace(/^@+/, '').trim(), salt, hash: hashPw(password, salt), isAdmin: !!isAdmin, createdAt: Date.now() };
    saveUsers();
    ensureUserDirs(key);
    const t = getTenant(key);
    if (t && !t.config.username) { t.config.username = users[key].username; saveTenantConfig(t); }
    return users[key];
}
function setPassword(key, password) {
    if (!users[key]) return false;
    if (!password || String(password).length < 4) throw new Error('パスワードは4文字以上');
    const salt = crypto.randomBytes(16).toString('hex');
    users[key].salt = salt; users[key].hash = hashPw(password, salt);
    saveUsers(); return true;
}
function verifyUser(username, password) {
    const key = normKey(username);
    const u = users[key];
    if (!u) return null;
    return safeEq(hashPw(password, u.salt), u.hash) ? key : null;
}

// ---- セッショントークン (HMAC署名。サーバー再起動でも有効) ----
function signToken(key) {
    const body = key + '.' + (Date.now() + 30 * 864e5); // 30日有効
    const mac = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    return body + '.' + mac;
}
function verifyTokenStr(tok) {
    if (!tok) return null;
    const parts = String(tok).split('.');
    if (parts.length !== 3) return null;
    const [key, exp, mac] = parts;
    const good = crypto.createHmac('sha256', SECRET).update(key + '.' + exp).digest('hex');
    if (!safeEq(mac, good)) return null;
    if (Date.now() > +exp) return null;
    if (!users[key]) return null;
    return key;
}
function cookieToken(cookieHeader) {
    const m = String(cookieHeader || '').match(/(?:^|;\s*)sid=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

// ============================================================
// テナント(ユーザーごとの状態)
// ============================================================
const AUTO_RETRY_MS = 30000; // 配信待ちの再確認間隔 (30秒)
const SOUND_TYPES = ['gift', 'follow', 'share'];
// ギフト→サウンドの割当上限。変更したら dashboard.html の MAX_GIFT_RULES も揃えること
const MAX_GIFT_RULES = 50;
const DEFAULT_GIFTS = [
    'Rose', 'TikTok', 'Heart', 'Heart Me', 'GG', 'Ice Cream Cone', 'Finger Heart',
    'Perfume', 'Doughnut', 'Rosa', 'Love you', 'Hand Hearts', 'Sunglasses', 'Hi',
    'Cheer You Up', 'Team Bracelet', 'Football', 'Music Play', 'Gamepad', 'Lion',
    'Universe', 'Rocket', 'Whale diving', 'Galaxy', 'Corgi', 'Confetti', 'Star',
    'Diamond', 'Coral', 'Falcon', 'Sports Car', 'Dragon', 'Interstellar',
    'Motorcycle', 'Private Jet', 'Yacht'
];

function defaultConfig(username) {
    return {
        username: username || '',
        autoConnect: false,
        // engine: 'browser'(端末内蔵) / 'voicevox' / 'azure'(いずれもサーバー合成)
        // voicevoxSpeaker はスタイルID(3=ずんだもん ノーマル)、azureVoice は音声名
        tts: { enabled: true, readComments: true, readGifts: true, lang: 'ja-JP', rate: 1.1, maxLength: 60, gender: 'auto', pitch: 1, volume: 1, engine: 'browser', voicevoxSpeaker: 3, azureVoice: 'ja-JP-NanamiNeural' },
        alerts: {
            gift: { enabled: true, sound: '', minDiamonds: 1, duration: 6000 },
            follow: { enabled: true, sound: '', duration: 4000 },
            share: { enabled: true, sound: '', duration: 4000 }
        },
        chatOverlay: { enabled: true, maxMessages: 8 },
        audio: { eqEnabled: false, eqLow: 0, eqMid: 0, eqHigh: 0, volume: 1 }
    };
}

const tenants = new Map(); // key -> tenant
function loadTenant(key) {
    ensureUserDirs(key);
    const username = (users[key] && users[key].username) || key;
    const t = {
        key, username,
        config: Object.assign(defaultConfig(username), readJSON(path.join(userDir(key), 'config.json'), {})),
        soundboard: readJSON(path.join(userDir(key), 'soundboard.json'), { library: [], giftRules: [] }),
        giftCatalog: readJSON(path.join(userDir(key), 'gift-catalog.json'), []),
        status: { connected: false, username: '', viewers: 0, likes: 0, diamonds: 0 },
        connection: null, connecting: false, autoTimer: null
    };
    if (!Array.isArray(t.soundboard.library)) t.soundboard.library = [];
    if (!Array.isArray(t.soundboard.giftRules)) t.soundboard.giftRules = [];
    if (!Array.isArray(t.giftCatalog)) t.giftCatalog = [];
    seedGiftCatalog(t);
    tenants.set(key, t);
    return t;
}
function getTenant(key) {
    if (tenants.has(key)) return tenants.get(key);
    if (users[key]) return loadTenant(key);
    return null;
}
function saveTenantConfig(t) { writeJSON(path.join(userDir(t.key), 'config.json'), t.config); }
function saveTenantSoundboard(t) { writeJSON(path.join(userDir(t.key), 'soundboard.json'), t.soundboard); }
function saveTenantCatalog(t) { writeJSON(path.join(userDir(t.key), 'gift-catalog.json'), t.giftCatalog); }

function seedGiftCatalog(t) {
    const have = new Set(t.giftCatalog.map(g => (g.name || '').toLowerCase()));
    let added = false;
    for (const name of DEFAULT_GIFTS) {
        if (!have.has(name.toLowerCase())) { t.giftCatalog.push({ name, image: '' }); have.add(name.toLowerCase()); added = true; }
    }
    if (added) saveTenantCatalog(t);
}
function rememberGift(t, name, image) {
    name = (name || '').toString().trim();
    if (!name) return;
    const existing = t.giftCatalog.find(g => (g.name || '').toLowerCase() === name.toLowerCase());
    if (existing) {
        if (image && !existing.image) { existing.image = image; saveTenantCatalog(t); io.to(t.key).emit('giftCatalog', t.giftCatalog); }
        return;
    }
    t.giftCatalog.push({ name, image: image || '' });
    saveTenantCatalog(t);
    io.to(t.key).emit('giftCatalog', t.giftCatalog);
}

// ============================================================
// 初回移行: users.json が無ければ、旧グローバルデータを管理者アカウントへ移す
// ============================================================
function migrateIfNeeded() {
    if (Object.keys(users).length > 0) return;
    const legacyAuth = readJSON(AUTH_PATH, null);
    let adminName = (legacyAuth && legacyAuth.user) || 'admin';
    let adminPass = (legacyAuth && legacyAuth.pass) || crypto.randomBytes(6).toString('hex');
    const key = normKey(adminName);
    if (!validName(key)) { adminName = 'admin'; }
    createUser(adminName, adminPass, true);
    const t = getTenant(normKey(adminName));

    // 旧グローバルファイルを取り込み(あれば)
    const oldConfig = readJSON(path.join(__dirname, 'config.json'), null);
    const oldSb = readJSON(path.join(__dirname, 'soundboard.json'), null);
    const oldGc = readJSON(path.join(__dirname, 'gift-catalog.json'), null);
    const rewrite = (u) => (typeof u === 'string' && u.startsWith('/sounds/')) ? ('/s/' + t.key + u.slice('/sounds'.length)) : u;

    if (oldConfig) {
        t.config = Object.assign(defaultConfig(t.username), oldConfig);
        if (t.config.alerts) for (const type of SOUND_TYPES) {
            if (t.config.alerts[type] && t.config.alerts[type].sound) t.config.alerts[type].sound = rewrite(t.config.alerts[type].sound);
        }
        saveTenantConfig(t);
    }
    if (oldSb && Array.isArray(oldSb.library)) {
        t.soundboard = {
            library: oldSb.library.map(l => ({ ...l, file: rewrite(l.file) })),
            giftRules: Array.isArray(oldSb.giftRules) ? oldSb.giftRules : []
        };
        saveTenantSoundboard(t);
    }
    if (Array.isArray(oldGc)) { t.giftCatalog = oldGc; seedGiftCatalog(t); saveTenantCatalog(t); }

    // 旧サウンドファイルをユーザーディレクトリへコピー
    try {
        const oldSoundsDir = path.join(__dirname, 'sounds');
        if (fs.existsSync(oldSoundsDir)) {
            for (const f of fs.readdirSync(oldSoundsDir)) {
                const src = path.join(oldSoundsDir, f);
                if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(userSoundsDir(t.key), f));
            }
            const oldLib = path.join(oldSoundsDir, 'lib');
            if (fs.existsSync(oldLib)) {
                for (const f of fs.readdirSync(oldLib)) {
                    const src = path.join(oldLib, f);
                    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(userLibDir(t.key), f));
                }
            }
        }
    } catch (e) { console.error('[移行] サウンドコピー失敗:', e.message); }

    console.log('==========================================');
    console.log(`[移行] 管理者アカウントを作成しました`);
    console.log(`   ログイン名: ${adminName}`);
    if (!legacyAuth) console.log(`   パスワード: ${adminPass}  (auth.json が無かったため自動生成。必ず控えてください)`);
    else console.log(`   パスワード: (auth.json の pass と同じ)`);
    console.log('==========================================');
}

// ============================================================
// 効果音アップロード (multer。保存先はリクエストユーザーのディレクトリ)
// ============================================================
function audioFilter(req, file, cb) {
    const ok = /^audio\//.test(file.mimetype) || /\.(mp3|wav|ogg|m4a|webm)$/i.test(file.originalname);
    cb(ok ? null : new Error('音声ファイルを選んでください'), ok);
}
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { ensureUserDirs(req.userKey); cb(null, userSoundsDir(req.userKey)); },
        filename: (req, file, cb) => cb(null, req.params.type + '.mp3')
    }),
    limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: audioFilter
});
const libUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { ensureUserDirs(req.userKey); cb(null, userLibDir(req.userKey)); },
        filename: (req, file, cb) => cb(null, req._soundId + '.mp3')
    }),
    limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: audioFilter
});

// ---- PWA: アプリアイコンを起動時に自動生成 (依存ライブラリ不要の純JS PNGエンコーダ) ----
const ICONS_DIR = path.join(__dirname, 'public', 'icons');
function pngCRC(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return (~c) >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCRC(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
}
function makeIcon(size) {
    const W = size, H = size, bg = [13, 16, 23], fg = [255, 45, 85];
    const cx = W / 2, cy = H / 2, r = W * 0.30;
    const raw = Buffer.alloc(H * (1 + W * 4));
    let p = 0;
    for (let y = 0; y < H; y++) {
        raw[p++] = 0;
        for (let x = 0; x < W; x++) {
            const dx = x - cx + 0.5, dy = y - cy + 0.5;
            const col = (dx * dx + dy * dy) <= r * r ? fg : bg;
            raw[p++] = col[0]; raw[p++] = col[1]; raw[p++] = col[2]; raw[p++] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
    const idat = zlib.deflateSync(raw);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function ensureIcons() {
    try {
        if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });
        for (const s of [192, 512]) {
            const f = path.join(ICONS_DIR, `icon-${s}.png`);
            if (!fs.existsSync(f)) fs.writeFileSync(f, makeIcon(s));
        }
    } catch (e) { console.error('[PWA] アイコン生成失敗:', e.message); }
}
ensureIcons();

// 起動ごとに変わるビルドID。オーバーレイ/ダッシュボードはこの変化で自動リロードする
const BUILD_ID = crypto.randomBytes(6).toString('hex');

// サブパス配信 (例: BASE_PATH=/tiktok → https://ホスト/tiktok/dashboard)。
// 未設定なら従来どおりルート直下。1台のサーバーに複数アプリを載せるための土台。
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: BASE + '/socket.io' });
const router = express.Router();

app.use(express.json());

// ---- 検索エンジン避け ----
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet'); next(); });
router.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// ============================================================
// 認証ミドルウェア
// ============================================================
function reqToken(req) {
    const c = cookieToken(req.headers.cookie);
    if (c) return c;
    const a = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    return a ? a[1] : '';
}
function requireUser(req, res, next) {
    const key = verifyTokenStr(reqToken(req));
    if (!key) {
        if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect(BASE + '/login');
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    req.userKey = key; req.user = users[key];
    next();
}
function requireAdmin(req, res, next) {
    requireUser(req, res, () => {
        if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: '管理者のみ操作できます' });
        next();
    });
}

// ============================================================
// ログイン / ログアウト
// ============================================================
// public/*.html を返す共通処理。クライアントがURLを組み立てられるよう BASE を注入する
function sendHtml(res, file, extraJS) {
    let html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
    const inject = `<script>window.__BASE__=${JSON.stringify(BASE)};${extraJS || ''}</script>\n</head>`;
    html = html.replace('</head>', inject);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
}

router.get('/login', (req, res) => sendHtml(res, 'login.html'));
router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const key = verifyUser(username, password);
    if (!key) return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
    const tok = signToken(key);
    res.set('Set-Cookie', `sid=${encodeURIComponent(tok)}; Path=${BASE || '/'}; HttpOnly; SameSite=Lax; Max-Age=${30 * 864e5 / 1000}`);
    getTenant(key);
    res.json({ ok: true });
});
router.post('/logout', (req, res) => {
    res.set('Set-Cookie', `sid=; Path=${BASE || '/'}; HttpOnly; Max-Age=0`);
    res.json({ ok: true });
});

// ============================================================
// ダッシュボード (要ログイン)。ユーザー情報を注入
// ============================================================
function serveDashboard(req, res) {
    const sess = { username: req.user.username, key: req.userKey, isAdmin: !!req.user.isAdmin };
    sendHtml(res, 'dashboard.html', `window.__SESSION__=${JSON.stringify(sess)};`);
}
router.get('/dashboard', requireUser, serveDashboard);
router.get('/dashboard.html', requireUser, serveDashboard);
router.get('/', (req, res) => res.redirect(BASE + '/dashboard'));

// ============================================================
// 管理者API: ユーザーの作成・削除・一覧・パスワード変更
// ============================================================
router.get('/admin/users', requireAdmin, (req, res) => {
    const list = Object.keys(users).map(k => ({ key: k, username: users[k].username, isAdmin: !!users[k].isAdmin, createdAt: users[k].createdAt || 0 }));
    res.json({ users: list });
});
router.post('/admin/users', requireAdmin, (req, res) => {
    try {
        const { username, password, isAdmin } = req.body || {};
        if (users[normKey(username)]) return res.status(400).json({ error: 'そのユーザー名は既にあります' });
        const u = createUser(username, password, !!isAdmin);
        res.json({ ok: true, user: { key: normKey(username), username: u.username, isAdmin: u.isAdmin } });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/admin/users/:name/password', requireAdmin, (req, res) => {
    try {
        const key = normKey(req.params.name);
        if (!users[key]) return res.status(404).json({ error: 'ユーザーがいません' });
        setPassword(key, (req.body || {}).password);
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/admin/users/:name', requireAdmin, (req, res) => {
    const key = normKey(req.params.name);
    if (!users[key]) return res.status(404).json({ error: 'ユーザーがいません' });
    if (key === req.userKey) return res.status(400).json({ error: '自分自身は削除できません' });
    // 接続中なら切断
    const t = tenants.get(key);
    if (t) { try { if (t.connection) t.connection.disconnect(); } catch (e) {} if (t.autoTimer) clearTimeout(t.autoTimer); tenants.delete(key); }
    delete users[key]; saveUsers();
    try { fs.rmSync(userDir(key), { recursive: true, force: true }); } catch (e) {}
    res.json({ ok: true });
});

// ============================================================
// ユーザー別サウンド配信 (オーバーレイが読むので公開。パストラバーサル対策)
// ============================================================
function sendSound(res, user, rel) {
    const key = normKey(user);
    const base = userSoundsDir(key);
    const target = path.normalize(path.join(base, rel));
    if (!target.startsWith(base)) return res.status(400).end();
    if (!fs.existsSync(target)) return res.status(404).end();
    res.sendFile(target);
}
router.get('/s/:user/lib/:file', (req, res) => sendSound(res, req.params.user, path.join('lib', path.basename(req.params.file))));
router.get('/s/:user/:file', (req, res) => sendSound(res, req.params.user, path.basename(req.params.file)));

// ---- 静的 & オーバーレイ ----
// PWA: ホーム画面に追加した時に ?u=<ユーザー名> を保持するため、manifest をユーザーごとに生成する。
// (静的配信より先に登録してこちらを優先させる)
router.get('/overlay.webmanifest', (req, res) => {
    const m = readJSON(path.join(__dirname, 'public', 'overlay.webmanifest'), {});
    const key = normKey(req.query.u);
    if (key) {
        const url = BASE + '/overlay?u=' + encodeURIComponent(key);
        const label = users[key] ? users[key].username : key;
        m.id = url;              // ユーザーごとに別アプリとしてインストールできるようにする
        m.start_url = url;
        m.name = `Tiktok Infinity 通知オーバーレイ (${label})`;
        m.short_name = `Infinity ${label}`;
    }
    res.set('Cache-Control', 'no-store');
    res.type('application/manifest+json').send(JSON.stringify(m));
});
router.use(express.static(path.join(__dirname, 'public')));
router.get('/overlay', (req, res) => {
    // manifest の参照先に ?u= を引き継ぐ。これが無いとインストール後に /overlay へ落ちる
    let html = fs.readFileSync(path.join(__dirname, 'public', 'overlay.html'), 'utf8');
    const key = normKey(req.query.u);
    if (key) {
        html = html.replace('href="overlay.webmanifest"',
            `href="overlay.webmanifest?u=${encodeURIComponent(key)}"`);
    }
    html = html.replace('</head>', `<script>window.__BASE__=${JSON.stringify(BASE)};</script>\n</head>`);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
});

// ============================================================
// ユーザー別データAPI (要ログイン。自分のテナントを操作)
// ============================================================
router.get('/config', requireUser, (req, res) => res.json(getTenant(req.userKey).config));
router.post('/config', requireUser, (req, res) => {
    const t = getTenant(req.userKey);
    t.config = { ...t.config, ...req.body };
    saveTenantConfig(t);
    io.to(t.key).emit('config', t.config);
    res.json({ ok: true });
});
router.get('/soundboard', requireUser, (req, res) => res.json(getTenant(req.userKey).soundboard));
router.get('/gift-catalog', requireUser, (req, res) => res.json(getTenant(req.userKey).giftCatalog));

// アラート効果音をライブラリのサウンドに設定 (soundId空でビープ音)
router.post('/set-sound/:type', requireUser, (req, res) => {
    const type = (req.params.type || '').toLowerCase();
    if (!SOUND_TYPES.includes(type)) return res.status(400).json({ error: '種類が不正です' });
    const t = getTenant(req.userKey);
    const soundId = (req.body.soundId || '').toString().trim();
    let sound = '';
    if (soundId) {
        const item = t.soundboard.library.find(l => l.id === soundId);
        if (!item) return res.status(400).json({ error: 'ライブラリに存在しません' });
        sound = item.file;
    }
    if (!t.config.alerts) t.config.alerts = {};
    if (!t.config.alerts[type]) t.config.alerts[type] = {};
    t.config.alerts[type].sound = sound;
    saveTenantConfig(t);
    io.to(t.key).emit('config', t.config);
    res.json({ ok: true, sound });
});

// ライブラリに音を追加 (ファイルアップロード)
router.post('/soundboard/upload', requireUser, (req, res) => {
    req._soundId = crypto.randomBytes(6).toString('hex');
    libUpload.single('sound')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
        const t = getTenant(req.userKey);
        const name = (req.body.name || '').toString().trim().slice(0, 40) || 'サウンド';
        const entry = { id: req._soundId, name, file: '/s/' + t.key + '/lib/' + req._soundId + '.mp3' };
        t.soundboard.library.push(entry);
        saveTenantSoundboard(t);
        io.to(t.key).emit('soundboard', t.soundboard);
        res.json({ ok: true, entry });
    });
});

// ライブラリから音を削除
router.delete('/soundboard/library/:id', requireUser, (req, res) => {
    const t = getTenant(req.userKey);
    const id = req.params.id;
    const item = t.soundboard.library.find(l => l.id === id);
    if (item) { try { const f = path.join(userLibDir(t.key), id + '.mp3'); if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} }
    t.soundboard.library = t.soundboard.library.filter(l => l.id !== id);
    t.soundboard.giftRules = t.soundboard.giftRules.filter(r => r.soundId !== id);
    saveTenantSoundboard(t);
    io.to(t.key).emit('soundboard', t.soundboard);
    res.json({ ok: true });
});

// ギフト→サウンドの割当 (soundId空で解除)。上限 MAX_GIFT_RULES 件
router.post('/soundboard/rule', requireUser, (req, res) => {
    const t = getTenant(req.userKey);
    const gift = (req.body.gift || '').toString().trim();
    const soundId = (req.body.soundId || '').toString().trim();
    if (!gift) return res.status(400).json({ error: 'ギフト名が必要です' });
    // 既存ギフトの音を差し替えるだけなら件数は増えないので上限チェックの対象外
    const isNew = !t.soundboard.giftRules.some(r => (r.gift || '').toLowerCase() === gift.toLowerCase());
    if (soundId && isNew && t.soundboard.giftRules.length >= MAX_GIFT_RULES) {
        return res.status(400).json({ error: `割当は${MAX_GIFT_RULES}個までです。不要な割当を解除してから追加してください`, max: MAX_GIFT_RULES });
    }
    t.soundboard.giftRules = t.soundboard.giftRules.filter(r => (r.gift || '').toLowerCase() !== gift.toLowerCase());
    if (soundId && t.soundboard.library.some(l => l.id === soundId)) t.soundboard.giftRules.push({ gift, soundId });
    saveTenantSoundboard(t);
    io.to(t.key).emit('soundboard', t.soundboard);
    res.json({ ok: true, giftRules: t.soundboard.giftRules, max: MAX_GIFT_RULES });
});

// ============================================================
// サーバー側の読み上げ合成 (VOICEVOX / Azure Speech)
// 合成した音声をディスクにキャッシュして返す。合成できなければエラーを返し、
// オーバーレイ側は端末内蔵の読み上げに切り替わる
// (= 導入前と同じ動作に戻るだけで、読み上げが止まることはない)
// ============================================================
const VOICEVOX_URL = (process.env.VOICEVOX_URL || 'http://127.0.0.1:50021').replace(/\/+$/, '');
// Azure Speech。キーが未設定ならAzureは使えない状態として扱う
const AZURE_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || 'japaneast';
const AZURE_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'; // mp3。wavの1/10の転送量で済む
const AZURE_DEFAULT_VOICE = 'ja-JP-NanamiNeural';
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
const TTS_TEXT_MAX = 120;      // 1回に合成する最大文字数
const TTS_CACHE_MAX = 1000;    // キャッシュ保持数(超えたら古い順に削除)
const TTS_TIMEOUT_MS = 10000;  // エンジン応答の待ち上限
const TTS_RATE_PER_MIN = 120;  // ユーザーごとの合成リクエスト上限/分
try { fs.mkdirSync(TTS_CACHE_DIR, { recursive: true }); } catch (e) {}

function clampNum(v, min, max, dflt) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// 画面の設定値(rate/pitch/volume)を、選ばれたエンジンのパラメータに翻訳する。
// VOICEVOX: pitch 0.5〜2 → pitchScale -0.15〜0.15 (VOICEVOXの可動域)
// Azure   : SSMLのprosodyへ。rate/pitchは%指定、volumeは0〜100
function ttsParams(tts) {
    const t = tts || {};
    const pitch = clampNum(t.pitch, 0.5, 2, 1);
    const rate = clampNum(t.rate, 0.5, 2, 1);
    const volume = clampNum(t.volume, 0, 2, 1);
    const engine = t.engine === 'azure' ? 'azure' : 'voicevox';
    return {
        engine,
        // VOICEVOX用
        speaker: Math.max(0, parseInt(t.voicevoxSpeaker, 10) || 0),
        speed: rate,
        pitch: +((pitch - 1) * 0.15).toFixed(3),
        volume,
        // Azure用
        // 音声名は英数字と - _ : のみ許可。ja-JP-Haruto:MAI-Voice-2-Flash のように
        // コロンや数字を含むものがあるため広めに取る(SSMLへはエスケープして埋め込む)
        voice: /^[A-Za-z0-9:_-]{3,64}$/.test(t.azureVoice || '') ? t.azureVoice : AZURE_DEFAULT_VOICE,
        azRate: Math.round((rate - 1) * 100),   // 1.0 → 0%
        azPitch: Math.round((pitch - 1) * 50),  // 1.0 → 0%
        azVolume: Math.min(100, Math.round(volume * 100)) // AzureのSSMLは0〜100。超えると400になる
    };
}

const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// テキスト→mp3。Azure Speech の REST API を SSML で叩く
async function azureSynth(text, p) {
    if (!AZURE_KEY) throw new Error('AZURE_SPEECH_KEY が未設定です');
    const sign = n => (n >= 0 ? '+' : '') + n + '%';
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ja-JP">`
        + `<voice name="${xmlEsc(p.voice)}">`
        + `<prosody rate="${sign(p.azRate)}" pitch="${sign(p.azPitch)}" volume="${p.azVolume}">`
        + xmlEsc(text) + `</prosody></voice></speak>`;
    const r = await fetch(`https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
            'Ocp-Apim-Subscription-Key': AZURE_KEY,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': AZURE_FORMAT,
            'User-Agent': 'tiktok-infinity'
        },
        body: ssml,
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS)
    });
    if (!r.ok) {
        // 429 は無料枠(20回/60秒)の上限。オーバーレイ側は端末内蔵に落ちる
        const detail = r.status === 429 ? 'リクエストが多すぎます(無料枠の上限)' : await r.text().catch(() => '');
        throw new Error('Azure が ' + r.status + ' ' + String(detail).slice(0, 120));
    }
    return Buffer.from(await r.arrayBuffer());
}

// 日本語の音声一覧。毎回問い合わせると遅いのでプロセス内に覚えておく
let azureVoiceCache = null;
async function azureVoices() {
    if (azureVoiceCache) return azureVoiceCache;
    if (!AZURE_KEY) throw new Error('AZURE_SPEECH_KEY が未設定です');
    const r = await fetch(`https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
        headers: { 'Ocp-Apim-Subscription-Key': AZURE_KEY }, signal: AbortSignal.timeout(TTS_TIMEOUT_MS)
    });
    if (!r.ok) throw new Error('音声一覧の取得に失敗: HTTP ' + r.status);
    const all = await r.json();
    azureVoiceCache = all
        .filter(v => (v.Locale || '').toLowerCase().startsWith('ja-'))
        .map(v => ({
            id: v.ShortName,
            name: v.LocalName || v.DisplayName || v.ShortName,
            gender: v.Gender === 'Female' ? '女性' : v.Gender === 'Male' ? '男性' : ''
        }));
    return azureVoiceCache;
}

function voicevoxFetch(url, opts) {
    return fetch(url, Object.assign({ signal: AbortSignal.timeout(TTS_TIMEOUT_MS) }, opts || {}));
}

// テキスト→wav。VOICEVOXは audio_query でパラメータを作ってから synthesis に渡す2段構え
async function voicevoxSynth(text, p) {
    const qr = await voicevoxFetch(`${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${p.speaker}`, { method: 'POST' });
    if (!qr.ok) throw new Error('audio_query が ' + qr.status);
    const query = await qr.json();
    query.speedScale = p.speed;
    query.pitchScale = p.pitch;
    query.volumeScale = p.volume;
    query.outputStereo = false; // モノラルにして転送量を半分にする
    const sr = await voicevoxFetch(`${VOICEVOX_URL}/synthesis?speaker=${p.speaker}&enable_interrogative_upspeak=true`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query)
    });
    if (!sr.ok) throw new Error('synthesis が ' + sr.status);
    return Buffer.from(await sr.arrayBuffer());
}

// キャッシュのキーは「エンジン+声+速さ/高さ/音量+本文」。どれかが変われば別ファイルになる
function ttsCachePath(text, p) {
    const seed = p.engine === 'azure'
        ? ['azure', p.voice, p.azRate, p.azPitch, p.azVolume, text]
        : ['voicevox', p.speaker, p.speed, p.pitch, p.volume, text];
    const h = crypto.createHash('sha1').update(seed.join('|')).digest('hex');
    return path.join(TTS_CACHE_DIR, h + (p.engine === 'azure' ? '.mp3' : '.wav'));
}
const ttsMime = p => (p.engine === 'azure' ? 'audio/mpeg' : 'audio/wav');

// 古いキャッシュを間引く(更新時刻の古い順)。毎回走らせると重いので書き込み50回に1度
let ttsWrites = 0;
function trimTtsCache() {
    if (++ttsWrites % 50 !== 0) return;
    try {
        const files = fs.readdirSync(TTS_CACHE_DIR)
            .map(f => path.join(TTS_CACHE_DIR, f))
            .map(f => ({ f, m: fs.statSync(f).mtimeMs }))
            .sort((a, b) => a.m - b.m);
        for (let i = 0; i < files.length - TTS_CACHE_MAX; i++) { try { fs.unlinkSync(files[i].f); } catch (e) {} }
    } catch (e) {}
}

// 同じ文言を同時に要求されても合成は1回で済ませる (ギフト定型文はほぼキャッシュに当たる)
const ttsInflight = new Map();
async function ttsAudioFile(text, p) {
    const file = ttsCachePath(text, p);
    if (fs.existsSync(file)) {
        try { const now = new Date(); fs.utimesSync(file, now, now); } catch (e) {} // 間引きの順序用に触る
        return file;
    }
    if (ttsInflight.has(file)) return ttsInflight.get(file);
    const job = (async () => {
        const buf = p.engine === 'azure' ? await azureSynth(text, p) : await voicevoxSynth(text, p);
        fs.writeFileSync(file, buf);
        trimTtsCache();
        return file;
    })();
    ttsInflight.set(file, job);
    try { return await job; } finally { ttsInflight.delete(file); }
}

// /tts は(オーバーレイが未ログインで開くため)認証なし。ユーザー単位で流量を絞る
const ttsHits = new Map();
function ttsRateOk(key) {
    const now = Date.now();
    const a = (ttsHits.get(key) || []).filter(t => now - t < 60000);
    a.push(now);
    ttsHits.set(key, a);
    return a.length <= TTS_RATE_PER_MIN;
}

// エンジンの死活確認 (ダッシュボードの表示用)
router.get('/tts/status', requireUser, async (req, res) => {
    try {
        const r = await voicevoxFetch(VOICEVOX_URL + '/version');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        res.json({ available: true, url: VOICEVOX_URL, version: (await r.text()).replace(/"/g, '') });
    } catch (e) {
        res.json({ available: false, url: VOICEVOX_URL, error: e.message });
    }
});

// 話者(キャラ×スタイル)一覧
router.get('/tts/speakers', requireUser, async (req, res) => {
    try {
        const r = await voicevoxFetch(VOICEVOX_URL + '/speakers');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const list = await r.json();
        res.json(list.map(s => ({ name: s.name, styles: (s.styles || []).map(st => ({ id: st.id, name: st.name })) })));
    } catch (e) {
        res.status(503).json({ error: 'VOICEVOX ENGINE に接続できません (' + VOICEVOX_URL + '): ' + e.message });
    }
});

// Azure の日本語音声一覧
router.get('/tts/azure-voices', requireUser, async (req, res) => {
    try {
        res.json({ region: AZURE_REGION, voices: await azureVoices() });
    } catch (e) {
        res.status(503).json({ error: 'Azure Speech に接続できません: ' + e.message });
    }
});

// ダッシュボードの試聴 (ログイン必須。声だけ差し替えて自分の設定で鳴らす)
router.get('/tts/preview', requireUser, async (req, res) => {
    const t = getTenant(req.userKey);
    const text = (req.query.text || 'テスト読み上げです。ギフトありがとう!').toString().trim().slice(0, TTS_TEXT_MAX);
    const p = ttsParams(t.config.tts);
    // 保存前でも試聴できるよう、画面で選択中の声をクエリで受け取る
    if (req.query.engine === 'azure' || req.query.voice) p.engine = 'azure';
    if (req.query.engine === 'voicevox' || req.query.speaker) p.engine = 'voicevox';
    if (req.query.speaker) p.speaker = Math.max(0, parseInt(req.query.speaker, 10) || 0);
    if (req.query.voice) p.voice = ttsParams({ azureVoice: req.query.voice }).voice;
    try {
        res.type(ttsMime(p)).sendFile(await ttsAudioFile(text, p));
    } catch (e) {
        res.status(503).json({ error: '合成に失敗: ' + e.message });
    }
});

// ------------------------------------------------------------
// VOICEVOX ENGINE の起動/停止 (Dockerコンテナの操作。管理者のみ)
// SSHに入らずダッシュボードのボタンで起動できるようにするためのもの。
// 実行するコマンドは固定で、画面からの入力は一切混ぜない
// ------------------------------------------------------------
const safeToken = s => /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(s);
const VOICEVOX_CONTAINER = safeToken(process.env.VOICEVOX_CONTAINER || '') ? process.env.VOICEVOX_CONTAINER : 'voicevox';
const VOICEVOX_IMAGE = safeToken(process.env.VOICEVOX_IMAGE || '') ? process.env.VOICEVOX_IMAGE : 'voicevox/voicevox_engine:cpu-latest';
const VOICEVOX_PORTMAP = '127.0.0.1:50021:50021'; // 外に晒さない。ここは固定

function dockerCmd(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile('docker', args, { timeout: timeoutMs || 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) { err.stderr = String(stderr || ''); return reject(err); }
            resolve(String(stdout || '').trim());
        });
    });
}
function dockerErr(e) {
    if (e && e.code === 'ENOENT') return 'docker コマンドが見つかりません（このサーバーにDockerが入っていないか、実行権限がありません）';
    if (e && e.killed) return 'docker コマンドがタイムアウトしました';
    const s = ((e && e.stderr) || (e && e.message) || '').trim();
    return s.slice(0, 300) || '不明なエラー';
}

// 起動処理の進捗。画面がポーリングして表示する
const vvJob = { running: false, phase: '', log: [], error: '' };
function vvLog(m) {
    vvJob.phase = m;
    vvJob.log.push(m);
    if (vvJob.log.length > 50) vvJob.log.shift();
    console.log('[VOICEVOX] ' + m);
}

async function voicevoxEnsureRunning() {
    vvLog('Docker を確認しています');
    await dockerCmd(['version', '--format', '{{.Server.Version}}'], 20000);
    let state = null;
    try { state = await dockerCmd(['inspect', '-f', '{{.State.Running}}', VOICEVOX_CONTAINER], 20000); } catch (e) { state = null; }
    if (state === 'true') {
        vvLog('コンテナはすでに動いています');
    } else if (state === 'false') {
        vvLog('停止していたコンテナを起動します');
        await dockerCmd(['start', VOICEVOX_CONTAINER], 120000);
    } else {
        // 初回はイメージ取得に数分かかる。ここが一番時間を食う
        vvLog('イメージを取得しています（初回は数分かかります）');
        await dockerCmd(['pull', VOICEVOX_IMAGE], 1800000);
        vvLog('コンテナを作成して起動します');
        await dockerCmd(['run', '-d', '--restart', 'always', '--name', VOICEVOX_CONTAINER,
            '-p', VOICEVOX_PORTMAP, VOICEVOX_IMAGE], 180000);
    }
    vvLog('エンジンの応答を待っています');
    for (let i = 0; i < 60; i++) { // 最大約2分待つ(モデル読み込みに時間がかかる)
        try {
            const r = await voicevoxFetch(VOICEVOX_URL + '/version');
            if (r.ok) return String(await r.text()).replace(/"/g, '');
        } catch (e) {}
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('コンテナは起動しましたが、エンジンが応答しません（' + VOICEVOX_URL + '）');
}

// エンジンとDockerの状態をまとめて返す
router.get('/voicevox/state', requireUser, async (req, res) => {
    const out = {
        url: VOICEVOX_URL, container: VOICEVOX_CONTAINER, image: VOICEVOX_IMAGE,
        engine: { available: false }, docker: { available: false, exists: false, running: false },
        job: { running: vvJob.running, phase: vvJob.phase, error: vvJob.error },
        canControl: !!(req.user && req.user.isAdmin)
    };
    try {
        const r = await voicevoxFetch(VOICEVOX_URL + '/version');
        if (r.ok) { out.engine.available = true; out.engine.version = String(await r.text()).replace(/"/g, ''); }
    } catch (e) {}
    try { await dockerCmd(['version', '--format', '{{.Server.Version}}'], 10000); out.docker.available = true; }
    catch (e) { out.docker.error = dockerErr(e); }
    if (out.docker.available) {
        try {
            const s = await dockerCmd(['inspect', '-f', '{{.State.Running}}', VOICEVOX_CONTAINER], 10000);
            out.docker.exists = true;
            out.docker.running = (s === 'true');
        } catch (e) {} // コンテナ未作成。exists=false のまま
    }
    res.json(out);
});

// 起動。時間がかかるので即座に返し、進捗は /voicevox/state で拾わせる
router.post('/voicevox/start', requireAdmin, (req, res) => {
    if (vvJob.running) return res.status(409).json({ error: '起動処理を実行中です' });
    vvJob.running = true; vvJob.error = ''; vvJob.log = []; vvJob.phase = '';
    res.json({ ok: true });
    voicevoxEnsureRunning()
        .then(v => vvLog('起動しました（v' + v + '）'))
        .catch(e => { vvJob.error = dockerErr(e); vvLog('失敗: ' + vvJob.error); })
        .finally(() => { vvJob.running = false; });
});

router.post('/voicevox/stop', requireAdmin, async (req, res) => {
    if (vvJob.running) return res.status(409).json({ error: '起動処理を実行中です' });
    try {
        await dockerCmd(['stop', VOICEVOX_CONTAINER], 120000);
        vvLog('停止しました');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: dockerErr(e) });
    }
});

// 合成本体。オーバーレイは未ログインで開くので u= でユーザーを指定させる
router.get('/tts', async (req, res) => {
    const key = normKey(req.query.u);
    const t = getTenant(key);
    if (!t) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    const text = (req.query.text || '').toString().trim().slice(0, TTS_TEXT_MAX);
    if (!text) return res.status(400).json({ error: 'text が必要です' });
    if (!ttsRateOk(key)) return res.status(429).json({ error: 'リクエストが多すぎます' });
    const p = ttsParams(t.config.tts);
    try {
        const file = await ttsAudioFile(text, p);
        res.set('Cache-Control', 'public, max-age=86400');
        res.type(ttsMime(p)).sendFile(file);
    } catch (e) {
        res.status(503).json({ error: '合成に失敗: ' + e.message });
    }
});

// ---- myinstants からサウンドを取得 ----
const MI_BASE = 'https://www.myinstants.com';
const MI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
function decodeHtmlEntities(s) {
    return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function parseInstants(html) {
    const items = [], seen = new Set();
    const re = /onclick="play\('(\/media\/sounds\/[^']+)'[\s\S]*?class="instant-link[^"]*">([^<]+)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 32) {
        const mp3 = m[1];
        if (seen.has(mp3)) continue;
        seen.add(mp3);
        items.push({ name: decodeHtmlEntities(m[2]).trim() || 'サウンド', mp3 });
    }
    return items;
}
router.get('/myinstants/search', requireUser, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.status(400).json({ error: '2文字以上で検索してください' });
    try {
        const r = await fetch(`${MI_BASE}/ja/search/?name=${encodeURIComponent(q)}`, { headers: { 'User-Agent': MI_UA } });
        if (!r.ok) return res.status(502).json({ error: `myinstants取得失敗 (${r.status})` });
        res.json({ items: parseInstants(await r.text()) });
    } catch (e) { res.status(502).json({ error: '通信エラー: ' + e.message }); }
});
router.post('/soundboard/import', requireUser, async (req, res) => {
    let mp3 = (req.body.mp3 || '').toString().trim();
    const name = (req.body.name || '').toString().trim().slice(0, 40) || 'サウンド';
    if (!mp3) return res.status(400).json({ error: '音声URLがありません' });
    try {
        if (mp3.startsWith('/')) mp3 = MI_BASE + mp3;
        const u = new URL(mp3);
        if (u.hostname !== 'www.myinstants.com' && u.hostname !== 'myinstants.com') return res.status(400).json({ error: 'myinstantsのURLではありません' });
        if (!/\/media\/sounds\//.test(u.pathname)) return res.status(400).json({ error: '音声URLではありません' });
        const r = await fetch(u.href, { headers: { 'User-Agent': MI_UA } });
        if (!r.ok) return res.status(502).json({ error: `ダウンロード失敗 (${r.status})` });
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) return res.status(502).json({ error: '空のファイルです' });
        if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'ファイルが大きすぎます(8MB上限)' });
        const t = getTenant(req.userKey);
        ensureUserDirs(t.key);
        const id = crypto.randomBytes(6).toString('hex');
        fs.writeFileSync(path.join(userLibDir(t.key), id + '.mp3'), buf);
        const entry = { id, name, file: '/s/' + t.key + '/lib/' + id + '.mp3' };
        t.soundboard.library.push(entry);
        saveTenantSoundboard(t);
        io.to(t.key).emit('soundboard', t.soundboard);
        res.json({ ok: true, entry });
    } catch (e) { res.status(502).json({ error: '取得エラー: ' + e.message }); }
});

// 全ルートをまとめて BASE 配下にぶら下げる
app.use(BASE || '/', router);

// ============================================================
// TikTok LIVE 接続 (テナントごと)
// ============================================================
function broadcast(t, type, payload) { io.to(t.key).emit('event', { type, time: Date.now(), ...payload }); }
function pushStatus(t) { io.to(t.key).emit('status', t.status); }
function userInfo(u) {
    if (!u) return { userId: '', nickname: '不明', avatar: '' };
    return {
        userId: u.displayId || '',
        nickname: u.nickname || u.displayId || '不明',
        avatar: (u.avatarThumb && u.avatarThumb.urlList && u.avatarThumb.urlList[0]) || ''
    };
}
function cancelAutoRetry(t) { if (t.autoTimer) { clearTimeout(t.autoTimer); t.autoTimer = null; } }
function scheduleAutoRetry(t) {
    cancelAutoRetry(t);
    if (!t.config.autoConnect || !t.config.username) return;
    t.autoTimer = setTimeout(() => maintainConnection(t), AUTO_RETRY_MS);
}
async function maintainConnection(t) {
    cancelAutoRetry(t);
    if (!t.config.autoConnect || !t.config.username) return;
    if (t.status.connected || t.connecting) return;
    await connectTikTok(t, t.config.username);
}

async function connectTikTok(t, username) {
    if (t.connection) { try { t.connection.disconnect(); } catch (e) {} t.connection = null; }
    t.connecting = true;
    t.status.username = username;
    console.log(`[${t.key}] 接続開始 @${username}`);

    const connection = new TikTokLiveConnection(username, { enableExtendedGiftInfo: false, processInitialData: false });
    t.connection = connection;

    connection.on(WebcastEvent.CHAT, data => {
        const u = userInfo(data.user);
        const comment = data.comment ?? data.content ?? '';
        broadcast(t, 'chat', { ...u, comment });
    });
    connection.on(WebcastEvent.GIFT, data => {
        const g = data.gift || {};
        const isStreakable = g.type === 1;
        if (isStreakable && data.repeatEnd !== 1) return;
        const u = userInfo(data.user);
        const count = data.repeatCount || 1;
        const diamonds = (g.diamondCount || 0) * count;
        t.status.diamonds += diamonds;
        const giftImage = (g.image && g.image.urlList && g.image.urlList[0]) || '';
        rememberGift(t, g.name, giftImage);
        broadcast(t, 'gift', { ...u, giftName: g.name || 'ギフト', giftImage, count, diamonds });
        pushStatus(t);
    });
    connection.on(WebcastEvent.FOLLOW, data => broadcast(t, 'follow', userInfo(data.user)));
    connection.on(WebcastEvent.SHARE, data => broadcast(t, 'share', userInfo(data.user)));
    connection.on(WebcastEvent.LIKE, data => {
        t.status.likes = data.totalCount || t.status.likes + (data.count || 1);
        broadcast(t, 'like', { ...userInfo(data.user), count: data.count || 1, total: t.status.likes });
        pushStatus(t);
    });
    connection.on(WebcastEvent.MEMBER, data => broadcast(t, 'member', userInfo(data.user)));
    connection.on(WebcastEvent.ROOM_USER, data => { t.status.viewers = data.viewerCount || 0; pushStatus(t); });
    connection.on(WebcastEvent.STREAM_END, () => {
        t.status.connected = false; pushStatus(t);
        broadcast(t, 'system', { message: '配信が終了しました' });
        if (t.config.autoConnect) { broadcast(t, 'system', { message: '自動接続ON: 次の配信開始を待機します' }); scheduleAutoRetry(t); }
    });
    connection.on('error', err => console.error(`[${t.key}] エラー`, err && err.message ? err.message : err));

    try {
        const state = await connection.connect();
        t.status.connected = true;
        console.log(`[${t.key}] 接続成功 roomId: ${state.roomId}`);
        pushStatus(t);
        broadcast(t, 'system', { message: `@${username} のLIVEに接続しました` });
    } catch (err) {
        t.status.connected = false;
        pushStatus(t);
        console.error(`[${t.key}] 接続失敗:`, err.message);
        if (t.config.autoConnect) {
            broadcast(t, 'system', { message: `@${username} は配信中ではありません。${AUTO_RETRY_MS / 1000}秒後に再確認します` });
            scheduleAutoRetry(t);
        } else {
            broadcast(t, 'system', { message: `接続失敗: ${err.message}` });
        }
    } finally { t.connecting = false; }
}
function disconnectTikTok(t) {
    if (t.connection) { try { t.connection.disconnect(); } catch (e) {} t.connection = null; }
    t.status.connected = false;
    pushStatus(t);
    console.log(`[${t.key}] 切断`);
}

// ============================================================
// Socket: Cookie(ダッシュボード)または {overlay:key}(オーバーレイ)で認証
// ============================================================
io.use((socket, next) => {
    const q = socket.handshake.auth || {};
    if (q.overlay) {
        const key = normKey(q.overlay);
        if (users[key]) { socket.userKey = key; socket.readonly = true; }
        return next();
    }
    const key = verifyTokenStr(cookieToken(socket.handshake.headers.cookie));
    if (key) { socket.userKey = key; socket.readonly = false; socket.isAdmin = !!(users[key] && users[key].isAdmin); }
    next();
});

io.on('connection', socket => {
    socket.emit('buildId', BUILD_ID);
    const key = socket.userKey;
    if (!key) return;
    const t = getTenant(key);
    if (!t) return;
    socket.join(key);
    socket.emit('status', t.status);
    socket.emit('config', t.config);
    socket.emit('soundboard', t.soundboard);
    socket.emit('giftCatalog', t.giftCatalog);

    if (socket.readonly) return; // オーバーレイは受信のみ

    socket.on('connectLive', username => {
        const name = (username || t.config.username || '').replace(/^@/, '').trim();
        if (!name) return;
        t.config.username = name;
        saveTenantConfig(t);
        io.to(t.key).emit('config', t.config);
        cancelAutoRetry(t);
        connectTikTok(t, name);
    });
    socket.on('disconnectLive', () => {
        t.config.autoConnect = false;
        saveTenantConfig(t);
        io.to(t.key).emit('config', t.config);
        cancelAutoRetry(t);
        disconnectTikTok(t);
    });
    socket.on('setAutoConnect', payload => {
        const enabled = !!(payload && payload.enabled);
        const name = ((payload && payload.username) || t.config.username || '').replace(/^@/, '').trim();
        t.config.autoConnect = enabled;
        if (name) t.config.username = name;
        saveTenantConfig(t);
        io.to(t.key).emit('config', t.config);
        if (enabled && t.config.username) {
            broadcast(t, 'system', { message: `自動接続ON: @${t.config.username} の配信開始を待機します` });
            maintainConnection(t);
        } else {
            cancelAutoRetry(t);
            broadcast(t, 'system', { message: '自動接続OFF' });
        }
    });
    socket.on('test', type => {
        const dummy = { userId: 'test_user', nickname: 'テスト太郎', avatar: '' };
        if (type === 'gift') broadcast(t, 'gift', { ...dummy, giftName: 'ローズ', giftImage: '', count: 5, diamonds: 5 });
        else if (type === 'chat') broadcast(t, 'chat', { ...dummy, comment: 'こんにちは!テストコメントです' });
        else if (type === 'follow') broadcast(t, 'follow', dummy);
        else if (type === 'like') { t.status.likes += 10; broadcast(t, 'like', { ...dummy, count: 10, total: t.status.likes }); pushStatus(t); }
    });
});

// ============================================================
// 起動
// ============================================================
migrateIfNeeded();
// 全ユーザーを読み込み、自動接続ONのユーザーは待機開始
for (const key of Object.keys(users)) {
    const t = getTenant(key);
    if (t && t.config.autoConnect && t.config.username) {
        console.log(`[${key}] 自動接続ON: @${t.config.username} を待機`);
        maintainConnection(t);
    }
}

const PORT = 8181;
const HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
    console.log('==========================================');
    console.log(`  Tiktok Infinity(マルチユーザー版) 起動 (${HOST}:${PORT})`);
    console.log(`  ユーザー数: ${Object.keys(users).length}`);
    console.log('==========================================');
    // 読み上げエンジンの死活を起動時に一度だけ確認して知らせる(どちらも無くても動く)
    voicevoxFetch(VOICEVOX_URL + '/version')
        .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(v => console.log(`  VOICEVOX ENGINE 検出: ${VOICEVOX_URL} (v${String(v).replace(/"/g, '')})`))
        .catch(e => console.log(`  VOICEVOX ENGINE 未検出: ${VOICEVOX_URL} (${e.message})`));
    if (!AZURE_KEY) {
        console.log('  Azure Speech 未設定 (AZURE_SPEECH_KEY 未指定)');
    } else {
        azureVoices()
            .then(v => console.log(`  Azure Speech 接続OK: ${AZURE_REGION} (日本語 ${v.length}音声)`))
            .catch(e => console.log(`  Azure Speech 接続失敗: ${AZURE_REGION} (${e.message})`));
    }
});
