// ============================================================
// TikTok LIVE 配信ツール (マルチユーザー版)
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
const multer = require('multer');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

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
        tts: { enabled: true, readComments: true, readGifts: true, lang: 'ja-JP', rate: 1.1, maxLength: 60, gender: 'auto', pitch: 1, volume: 1 },
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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// ---- 検索エンジン避け ----
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet'); next(); });
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

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
        if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect('/login');
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
app.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const key = verifyUser(username, password);
    if (!key) return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
    const tok = signToken(key);
    res.set('Set-Cookie', `sid=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 864e5 / 1000}`);
    getTenant(key);
    res.json({ ok: true });
});
app.post('/logout', (req, res) => {
    res.set('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
});

// ============================================================
// ダッシュボード (要ログイン)。ユーザー情報を注入
// ============================================================
function serveDashboard(req, res) {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf8');
    const sess = { username: req.user.username, key: req.userKey, isAdmin: !!req.user.isAdmin };
    html = html.replace('</head>', `<script>window.__SESSION__=${JSON.stringify(sess)};</script>\n</head>`);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
}
app.get('/dashboard', requireUser, serveDashboard);
app.get('/dashboard.html', requireUser, serveDashboard);
app.get('/', (req, res) => res.redirect('/dashboard'));

// ============================================================
// 管理者API: ユーザーの作成・削除・一覧・パスワード変更
// ============================================================
app.get('/admin/users', requireAdmin, (req, res) => {
    const list = Object.keys(users).map(k => ({ key: k, username: users[k].username, isAdmin: !!users[k].isAdmin, createdAt: users[k].createdAt || 0 }));
    res.json({ users: list });
});
app.post('/admin/users', requireAdmin, (req, res) => {
    try {
        const { username, password, isAdmin } = req.body || {};
        if (users[normKey(username)]) return res.status(400).json({ error: 'そのユーザー名は既にあります' });
        const u = createUser(username, password, !!isAdmin);
        res.json({ ok: true, user: { key: normKey(username), username: u.username, isAdmin: u.isAdmin } });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/admin/users/:name/password', requireAdmin, (req, res) => {
    try {
        const key = normKey(req.params.name);
        if (!users[key]) return res.status(404).json({ error: 'ユーザーがいません' });
        setPassword(key, (req.body || {}).password);
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/admin/users/:name', requireAdmin, (req, res) => {
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
app.get('/s/:user/lib/:file', (req, res) => sendSound(res, req.params.user, path.join('lib', path.basename(req.params.file))));
app.get('/s/:user/:file', (req, res) => sendSound(res, req.params.user, path.basename(req.params.file)));

// ---- 静的 & オーバーレイ ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('/overlay', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// ============================================================
// ユーザー別データAPI (要ログイン。自分のテナントを操作)
// ============================================================
app.get('/config', requireUser, (req, res) => res.json(getTenant(req.userKey).config));
app.post('/config', requireUser, (req, res) => {
    const t = getTenant(req.userKey);
    t.config = { ...t.config, ...req.body };
    saveTenantConfig(t);
    io.to(t.key).emit('config', t.config);
    res.json({ ok: true });
});
app.get('/soundboard', requireUser, (req, res) => res.json(getTenant(req.userKey).soundboard));
app.get('/gift-catalog', requireUser, (req, res) => res.json(getTenant(req.userKey).giftCatalog));

// アラート効果音をライブラリのサウンドに設定 (soundId空でビープ音)
app.post('/set-sound/:type', requireUser, (req, res) => {
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
app.post('/soundboard/upload', requireUser, (req, res) => {
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
app.delete('/soundboard/library/:id', requireUser, (req, res) => {
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

// ギフト→サウンドの割当
app.post('/soundboard/rule', requireUser, (req, res) => {
    const t = getTenant(req.userKey);
    const gift = (req.body.gift || '').toString().trim();
    const soundId = (req.body.soundId || '').toString().trim();
    if (!gift) return res.status(400).json({ error: 'ギフト名が必要です' });
    t.soundboard.giftRules = t.soundboard.giftRules.filter(r => r.gift.toLowerCase() !== gift.toLowerCase());
    if (soundId && t.soundboard.library.some(l => l.id === soundId)) t.soundboard.giftRules.push({ gift, soundId });
    saveTenantSoundboard(t);
    io.to(t.key).emit('soundboard', t.soundboard);
    res.json({ ok: true, giftRules: t.soundboard.giftRules });
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
app.get('/myinstants/search', requireUser, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.status(400).json({ error: '2文字以上で検索してください' });
    try {
        const r = await fetch(`${MI_BASE}/ja/search/?name=${encodeURIComponent(q)}`, { headers: { 'User-Agent': MI_UA } });
        if (!r.ok) return res.status(502).json({ error: `myinstants取得失敗 (${r.status})` });
        res.json({ items: parseInstants(await r.text()) });
    } catch (e) { res.status(502).json({ error: '通信エラー: ' + e.message }); }
});
app.post('/soundboard/import', requireUser, async (req, res) => {
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
    console.log(`  TikTok LIVE ツール(マルチユーザー版) 起動 (${HOST}:${PORT})`);
    console.log(`  ユーザー数: ${Object.keys(users).length}`);
    console.log('==========================================');
});
