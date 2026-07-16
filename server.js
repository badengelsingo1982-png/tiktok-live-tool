// ============================================================
// TikTok LIVE 配信ツール (自分用MVP)
// tiktok-live-connector v2 + Express + Socket.io
// 起動: node server.js
// オーバーレイ: http://localhost:8181/overlay  (OBSブラウザソースに登録)
// 管理画面    : http://localhost:8181/dashboard
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

// ---- 設定読み込み ----
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function saveConfig() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---- サウンドボード: ギフト別サウンド (ライブラリ + ギフト→サウンドの割当) ----
// soundboard.json 例: { "library":[{id,name,file}], "giftRules":[{gift,soundId}] }
const SOUNDBOARD_PATH = path.join(__dirname, 'soundboard.json');
let soundboard = { library: [], giftRules: [] };
try {
    const sb = JSON.parse(fs.readFileSync(SOUNDBOARD_PATH, 'utf8'));
    if (sb && Array.isArray(sb.library)) soundboard.library = sb.library;
    if (sb && Array.isArray(sb.giftRules)) soundboard.giftRules = sb.giftRules;
} catch (e) {}
function saveSoundboard() {
    fs.writeFileSync(SOUNDBOARD_PATH, JSON.stringify(soundboard, null, 2));
}

// ---- ギフトカタログ: 音の割当をプルダウンで選べるよう、ギフト名を蓄積 ----
// gift-catalog.json 例: [{ "name": "Rose", "image": "https://..." }, ...]
// 定番ギフトで初期化し、実際に受信したギフト名で自動的に育てる（手入力の打ち間違い=音が鳴らない、を防ぐ）
const GIFT_CATALOG_PATH = path.join(__dirname, 'gift-catalog.json');
const DEFAULT_GIFTS = [
    'Rose', 'TikTok', 'Heart', 'Heart Me', 'GG', 'Ice Cream Cone', 'Finger Heart',
    'Perfume', 'Doughnut', 'Rosa', 'Love you', 'Hand Hearts', 'Sunglasses', 'Hi',
    'Cheer You Up', 'Team Bracelet', 'Football', 'Music Play', 'Gamepad', 'Lion',
    'Universe', 'Rocket', 'Whale diving', 'Galaxy', 'Corgi', 'Confetti', 'Star',
    'Diamond', 'Coral', 'Falcon', 'Sports Car', 'Dragon', 'Interstellar',
    'Motorcycle', 'Private Jet', 'Yacht'
];
let giftCatalog = [];
try {
    const gc = JSON.parse(fs.readFileSync(GIFT_CATALOG_PATH, 'utf8'));
    if (Array.isArray(gc)) giftCatalog = gc;
} catch (e) {}
function saveGiftCatalog() {
    try { fs.writeFileSync(GIFT_CATALOG_PATH, JSON.stringify(giftCatalog, null, 2)); } catch (e) {}
}
// 既定ギフト名で不足分を補完（既存を消さない）
(function seedGiftCatalog() {
    const have = new Set(giftCatalog.map(g => (g.name || '').toLowerCase()));
    let added = false;
    for (const name of DEFAULT_GIFTS) {
        if (!have.has(name.toLowerCase())) {
            giftCatalog.push({ name, image: '' });
            have.add(name.toLowerCase());
            added = true;
        }
    }
    if (added) saveGiftCatalog();
})();
// 受信したギフトをカタログに記録（新規なら追加、画像が無ければ補完）
function rememberGift(name, image) {
    name = (name || '').toString().trim();
    if (!name) return;
    const existing = giftCatalog.find(g => (g.name || '').toLowerCase() === name.toLowerCase());
    if (existing) {
        if (image && !existing.image) {
            existing.image = image;
            saveGiftCatalog();
            io.emit('giftCatalog', giftCatalog);
        }
        return;
    }
    giftCatalog.push({ name, image: image || '' });
    saveGiftCatalog();
    io.emit('giftCatalog', giftCatalog);
}

// ---- 管理画面の認証 (auth.json があれば有効化) ----
// auth.json 例: { "user": "admin", "pass": "秘密のパスワード" }
// ※ auth.json は /config で配信されないので資格情報は漏れません
const AUTH_PATH = path.join(__dirname, 'auth.json');
let auth = null;
try {
    const a = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    if (a && a.user && a.pass) auth = a;
} catch (e) { auth = null; }
if (auth) console.log(`[認証] 管理画面はBasic認証で保護されています (user: ${auth.user})`);
else console.log('[認証] auth.json が無いため管理画面は未保護です');

// 管理socket用トークン (パスワードそのものはHTMLに埋め込まない)
const ADMIN_TOKEN = auth
    ? crypto.createHash('sha256').update(auth.user + ':' + auth.pass).digest('hex')
    : null;

function basicAuth(req, res, next) {
    if (!auth) return next(); // 認証未設定なら素通り (後方互換)
    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Basic (.+)$/);
    if (m) {
        const dec = Buffer.from(m[1], 'base64').toString('utf8');
        const i = dec.indexOf(':');
        const u = dec.slice(0, i), p = dec.slice(i + 1);
        if (u === auth.user && p === auth.pass) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="TikTok Tool Admin"');
    res.status(401).send('認証が必要です');
}

// ---- PWA: アプリアイコンを起動時に自動生成 (依存ライブラリ不要の純JS PNGエンコーダ) ----
const ICONS_DIR = path.join(__dirname, 'public', 'icons');
function pngCRC(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return (~c) >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCRC(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
}
function makeIcon(size) {
    // ダーク背景 + 中央に赤い丸 (アプリの●=ライブ表示に合わせる)
    const W = size, H = size, bg = [13, 16, 23], fg = [255, 45, 85];
    const cx = W / 2, cy = H / 2, r = W * 0.30;
    const raw = Buffer.alloc(H * (1 + W * 4));
    let p = 0;
    for (let y = 0; y < H; y++) {
        raw[p++] = 0; // filter byte
        for (let x = 0; x < W; x++) {
            const dx = x - cx + 0.5, dy = y - cy + 0.5;
            const col = (dx * dx + dy * dy) <= r * r ? fg : bg;
            raw[p++] = col[0]; raw[p++] = col[1]; raw[p++] = col[2]; raw[p++] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8bit深度, RGBA
    const idat = zlib.deflateSync(raw);
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))
    ]);
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

// ---- 効果音アップロード (multer) ----
const SOUNDS_DIR = path.join(__dirname, 'sounds');
if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });
const LIB_DIR = path.join(SOUNDS_DIR, 'lib'); // サウンドボード用ライブラリ
if (!fs.existsSync(LIB_DIR)) fs.mkdirSync(LIB_DIR, { recursive: true });
const SOUND_TYPES = ['gift', 'follow', 'share'];

function audioFilter(req, file, cb) {
    const ok = /^audio\//.test(file.mimetype) || /\.(mp3|wav|ogg|m4a|webm)$/i.test(file.originalname);
    cb(ok ? null : new Error('音声ファイルを選んでください'), ok);
}

// 既定の効果音 (gift.mp3 / follow.mp3 / share.mp3 固定名で上書き)
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, SOUNDS_DIR),
        filename: (req, file, cb) => cb(null, req.params.type + '.mp3')
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: audioFilter
});

// サウンドボードのライブラリ (ランダムIDで保存)
const libUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, LIB_DIR),
        filename: (req, file, cb) => cb(null, req._soundId + '.mp3')
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: audioFilter
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// ---- 検索エンジン避け: 全レスポンスに noindex を付与 + robots.txt で全拒否 ----
app.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    next();
});
app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// 管理画面: Basic認証 + socket用トークン注入。static より前に置いて直リンクも保護する
function serveDashboard(req, res) {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf8');
    html = html.replace('</head>',
        `<script>window.__ADMIN_TOKEN__=${JSON.stringify(ADMIN_TOKEN || '')};</script>\n</head>`);
    res.type('html').send(html);
}
app.get('/dashboard', basicAuth, serveDashboard);
app.get('/dashboard.html', basicAuth, serveDashboard);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));

app.get('/overlay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/config', (req, res) => res.json(config));
app.post('/config', basicAuth, (req, res) => {
    config = { ...config, ...req.body };
    saveConfig();
    io.emit('config', config);
    res.json({ ok: true });
});

// 効果音: どの種類が設定済みか
app.get('/sounds-status', basicAuth, (req, res) => {
    const out = {};
    for (const t of SOUND_TYPES) out[t] = fs.existsSync(path.join(SOUNDS_DIR, t + '.mp3'));
    res.json(out);
});

// 効果音アップロード (gift/follow/share)
app.post('/upload-sound/:type', basicAuth, (req, res) => {
    const type = (req.params.type || '').toLowerCase();
    if (!SOUND_TYPES.includes(type)) return res.status(400).json({ error: '種類が不正です' });
    req.params.type = type;
    upload.single('sound')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
        const rel = '/sounds/' + type + '.mp3';
        if (!config.alerts) config.alerts = {};
        if (!config.alerts[type]) config.alerts[type] = {};
        config.alerts[type].sound = rel;
        saveConfig();
        io.emit('config', config);
        console.log(`[効果音] ${type} を更新 (${req.file.size} bytes)`);
        res.json({ ok: true, path: rel });
    });
});

// 効果音を削除してビープ音に戻す
app.post('/delete-sound/:type', basicAuth, (req, res) => {
    const type = (req.params.type || '').toLowerCase();
    if (!SOUND_TYPES.includes(type)) return res.status(400).json({ error: '種類が不正です' });
    const f = path.join(SOUNDS_DIR, type + '.mp3');
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    if (config.alerts && config.alerts[type]) config.alerts[type].sound = '';
    saveConfig();
    io.emit('config', config);
    res.json({ ok: true });
});

// アラート効果音(gift/follow/share)をライブラリのサウンドに設定 (soundId空でビープ音に戻す)
app.post('/set-sound/:type', basicAuth, (req, res) => {
    const type = (req.params.type || '').toLowerCase();
    if (!SOUND_TYPES.includes(type)) return res.status(400).json({ error: '種類が不正です' });
    const soundId = (req.body.soundId || '').toString().trim();
    let sound = '';
    if (soundId) {
        const item = soundboard.library.find(l => l.id === soundId);
        if (!item) return res.status(400).json({ error: 'ライブラリに存在しません' });
        sound = item.file;
    }
    if (!config.alerts) config.alerts = {};
    if (!config.alerts[type]) config.alerts[type] = {};
    config.alerts[type].sound = sound;
    saveConfig();
    io.emit('config', config);
    console.log(`[効果音] ${type} をライブラリ音に設定: ${sound || '(なし/ビープ)'}`);
    res.json({ ok: true, sound });
});

// ---- サウンドボード API ----
// 現在の内容 (overlayも使うので公開)
app.get('/soundboard', (req, res) => res.json(soundboard));

// ギフトカタログ (割当プルダウン用)
app.get('/gift-catalog', basicAuth, (req, res) => res.json(giftCatalog));

// ライブラリに音を追加 (name + sound ファイル)
app.post('/soundboard/upload', basicAuth, (req, res) => {
    req._soundId = crypto.randomBytes(6).toString('hex');
    libUpload.single('sound')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
        const name = (req.body.name || '').toString().trim().slice(0, 40) || 'サウンド';
        const entry = { id: req._soundId, name, file: '/sounds/lib/' + req._soundId + '.mp3' };
        soundboard.library.push(entry);
        saveSoundboard();
        io.emit('soundboard', soundboard);
        console.log(`[サウンドボード] 追加: ${name} (${req.file.size} bytes)`);
        res.json({ ok: true, entry });
    });
});

// ライブラリから音を削除 (参照しているルールも除去)
app.delete('/soundboard/library/:id', basicAuth, (req, res) => {
    const id = req.params.id;
    const item = soundboard.library.find(l => l.id === id);
    if (item) {
        try {
            const f = path.join(LIB_DIR, id + '.mp3');
            if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (e) {}
    }
    soundboard.library = soundboard.library.filter(l => l.id !== id);
    soundboard.giftRules = soundboard.giftRules.filter(r => r.soundId !== id);
    saveSoundboard();
    io.emit('soundboard', soundboard);
    res.json({ ok: true });
});

// ギフト→サウンドの割当を追加/更新/削除 (soundId空で削除)
app.post('/soundboard/rule', basicAuth, (req, res) => {
    const gift = (req.body.gift || '').toString().trim();
    const soundId = (req.body.soundId || '').toString().trim();
    if (!gift) return res.status(400).json({ error: 'ギフト名が必要です' });
    soundboard.giftRules = soundboard.giftRules.filter(r => r.gift.toLowerCase() !== gift.toLowerCase());
    if (soundId && soundboard.library.some(l => l.id === soundId)) {
        soundboard.giftRules.push({ gift, soundId });
    }
    saveSoundboard();
    io.emit('soundboard', soundboard);
    res.json({ ok: true, giftRules: soundboard.giftRules });
});

// ---- myinstants (https://www.myinstants.com) からサウンドを取得 ----
const MI_BASE = 'https://www.myinstants.com';
const MI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function decodeHtmlEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// 検索結果HTMLから {name, mp3} の一覧を抽出
function parseInstants(html) {
    const items = [];
    const seen = new Set();
    // <button ... onclick="play('/media/sounds/xxx.mp3', ...)"> ... <a class="instant-link ...">名前</a>
    const re = /onclick="play\('(\/media\/sounds\/[^']+)'[\s\S]*?class="instant-link[^"]*">([^<]+)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 32) {
        const mp3 = m[1];
        if (seen.has(mp3)) continue;
        seen.add(mp3);
        const name = decodeHtmlEntities(m[2]).trim() || 'サウンド';
        items.push({ name, mp3 });
    }
    return items;
}

// キーワードで myinstants を検索
app.get('/myinstants/search', basicAuth, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.status(400).json({ error: '2文字以上で検索してください' });
    try {
        const r = await fetch(`${MI_BASE}/ja/search/?name=${encodeURIComponent(q)}`, {
            headers: { 'User-Agent': MI_UA }
        });
        if (!r.ok) return res.status(502).json({ error: `myinstants取得失敗 (${r.status})` });
        const html = await r.text();
        res.json({ items: parseInstants(html) });
    } catch (e) {
        res.status(502).json({ error: '通信エラー: ' + e.message });
    }
});

// myinstants のmp3をダウンロードしてライブラリに追加
app.post('/soundboard/import', basicAuth, async (req, res) => {
    let mp3 = (req.body.mp3 || '').toString().trim();
    const name = (req.body.name || '').toString().trim().slice(0, 40) || 'サウンド';
    if (!mp3) return res.status(400).json({ error: '音声URLがありません' });
    try {
        if (mp3.startsWith('/')) mp3 = MI_BASE + mp3;
        const u = new URL(mp3);
        // 取得先を myinstants の音声ファイルに限定 (SSRF/任意URL取得を防ぐ)
        if (u.hostname !== 'www.myinstants.com' && u.hostname !== 'myinstants.com')
            return res.status(400).json({ error: 'myinstantsのURLではありません' });
        if (!/\/media\/sounds\//.test(u.pathname))
            return res.status(400).json({ error: '音声URLではありません' });
        const r = await fetch(u.href, { headers: { 'User-Agent': MI_UA } });
        if (!r.ok) return res.status(502).json({ error: `ダウンロード失敗 (${r.status})` });
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) return res.status(502).json({ error: '空のファイルです' });
        if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'ファイルが大きすぎます(8MB上限)' });
        const id = crypto.randomBytes(6).toString('hex');
        fs.writeFileSync(path.join(LIB_DIR, id + '.mp3'), buf);
        const entry = { id, name, file: '/sounds/lib/' + id + '.mp3' };
        soundboard.library.push(entry);
        saveSoundboard();
        io.emit('soundboard', soundboard);
        console.log(`[サウンドボード] myinstantsから追加: ${name} (${buf.length} bytes)`);
        res.json({ ok: true, entry });
    } catch (e) {
        res.status(502).json({ error: '取得エラー: ' + e.message });
    }
});

// ---- TikTok LIVE 接続管理 ----
let connection = null;
let status = { connected: false, username: config.username, viewers: 0, likes: 0, diamonds: 0 };

// ---- 自動接続: 配信開始まで再試行し、配信終了後は次の配信を待機する ----
let connecting = false;
let autoTimer = null;
const AUTO_RETRY_MS = 30000; // 配信待ちの再確認間隔 (30秒)

function cancelAutoRetry() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}
function scheduleAutoRetry() {
    cancelAutoRetry();
    if (!config.autoConnect || !config.username) return;
    autoTimer = setTimeout(maintainConnection, AUTO_RETRY_MS);
}
async function maintainConnection() {
    cancelAutoRetry();
    if (!config.autoConnect || !config.username) return;
    if (status.connected || connecting) return;
    await connectTikTok(config.username);
}

function broadcast(type, payload) {
    io.emit('event', { type, time: Date.now(), ...payload });
}

function pushStatus() {
    io.emit('status', status);
}

function userInfo(u) {
    if (!u) return { userId: '', nickname: '不明', avatar: '' };
    return {
        userId: u.displayId || '',
        nickname: u.nickname || u.displayId || '不明',
        avatar: (u.avatarThumb && u.avatarThumb.urlList && u.avatarThumb.urlList[0]) || ''
    };
}

async function connectTikTok(username) {
    if (connection) {
        try { connection.disconnect(); } catch (e) {}
        connection = null;
    }
    connecting = true;
    status.username = username;
    console.log(`[接続開始] @${username}`);

    connection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: false,
        processInitialData: false
    });

    // --- コメント ---
    connection.on(WebcastEvent.CHAT, data => {
        const u = userInfo(data.user);
        // v2protoでは comment だが v3proto では content。両対応でundefined回避
        const comment = data.comment ?? data.content ?? '';
        console.log(`[コメント] ${u.nickname}: ${comment}`);
        broadcast('chat', { ...u, comment });
    });

    // --- ギフト ---
    connection.on(WebcastEvent.GIFT, data => {
        // 連打(ストリーク)ギフトは終了時のみ確定。type 1 = ストリーク可能ギフト
        const g = data.gift || {};
        const isStreakable = g.type === 1;
        if (isStreakable && data.repeatEnd !== 1) return; // 連打中はスキップ

        const u = userInfo(data.user);
        const count = data.repeatCount || 1;
        const diamonds = (g.diamondCount || 0) * count;
        status.diamonds += diamonds;

        const giftImage = (g.image && g.image.urlList && g.image.urlList[0]) || '';
        console.log(`[ギフト] ${u.nickname} → ${g.name} x${count} (${diamonds}💎)`);
        rememberGift(g.name, giftImage);
        broadcast('gift', {
            ...u,
            giftName: g.name || 'ギフト',
            giftImage,
            count,
            diamonds
        });
        pushStatus();
    });

    // --- フォロー・シェア (socialイベント) ---
    connection.on(WebcastEvent.FOLLOW, data => {
        const u = userInfo(data.user);
        console.log(`[フォロー] ${u.nickname}`);
        broadcast('follow', u);
    });
    connection.on(WebcastEvent.SHARE, data => {
        const u = userInfo(data.user);
        console.log(`[シェア] ${u.nickname}`);
        broadcast('share', u);
    });

    // --- いいね ---
    connection.on(WebcastEvent.LIKE, data => {
        status.likes = data.totalCount || status.likes + (data.count || 1);
        const u = userInfo(data.user);
        broadcast('like', { ...u, count: data.count || 1, total: status.likes });
        pushStatus();
    });

    // --- 入室 ---
    connection.on(WebcastEvent.MEMBER, data => {
        const u = userInfo(data.user);
        broadcast('member', u);
    });

    // --- 視聴者数 ---
    connection.on(WebcastEvent.ROOM_USER, data => {
        status.viewers = data.viewerCount || 0;
        pushStatus();
    });

    // --- 配信終了 ---
    connection.on(WebcastEvent.STREAM_END, () => {
        console.log('[配信終了]');
        status.connected = false;
        pushStatus();
        broadcast('system', { message: '配信が終了しました' });
        if (config.autoConnect) {
            broadcast('system', { message: '自動接続ON: 次の配信開始を待機します' });
            scheduleAutoRetry();
        }
    });

    connection.on('error', err => {
        console.error('[エラー]', err && err.message ? err.message : err);
    });

    try {
        const state = await connection.connect();
        status.connected = true;
        console.log(`[接続成功] roomId: ${state.roomId}`);
        pushStatus();
        broadcast('system', { message: `@${username} のLIVEに接続しました` });
    } catch (err) {
        status.connected = false;
        pushStatus();
        console.error('[接続失敗]', err.message);
        if (config.autoConnect) {
            // 配信していないだけのことが多いので、エラー表示せず静かに再確認
            broadcast('system', { message: `@${username} は配信中ではありません。${AUTO_RETRY_MS / 1000}秒後に再確認します` });
            scheduleAutoRetry();
        } else {
            broadcast('system', { message: `接続失敗: ${err.message}` });
        }
    } finally {
        connecting = false;
    }
}

function disconnectTikTok() {
    if (connection) {
        try { connection.disconnect(); } catch (e) {}
        connection = null;
    }
    status.connected = false;
    pushStatus();
    console.log('[切断しました]');
}

// ---- socket認証: 正しいトークンを持つ接続のみ管理操作を許可 ----
io.use((socket, next) => {
    const token = (socket.handshake.auth && socket.handshake.auth.token) || '';
    // 認証未設定なら全員操作可 (後方互換)。設定時はトークン一致した接続のみ管理者
    socket.isAdmin = !auth || (!!ADMIN_TOKEN && token === ADMIN_TOKEN);
    next();
});

// ---- ダッシュボードからの操作 ----
io.on('connection', socket => {
    socket.emit('status', status);
    socket.emit('config', config);
    socket.emit('soundboard', soundboard);
    socket.emit('giftCatalog', giftCatalog);

    socket.on('connectLive', username => {
        if (!socket.isAdmin) return; // 認証済み管理者のみ
        const name = (username || config.username || '').replace(/^@/, '').trim();
        if (!name) return;
        config.username = name;
        saveConfig();
        cancelAutoRetry();
        connectTikTok(name);
    });

    socket.on('disconnectLive', () => {
        if (!socket.isAdmin) return; // 認証済み管理者のみ
        config.autoConnect = false; // 手動切断は自動接続も停止する
        saveConfig();
        io.emit('config', config);
        cancelAutoRetry();
        disconnectTikTok();
    });

    // 自動接続 ON/OFF (配信開始まで自動で繋ぐ)
    socket.on('setAutoConnect', payload => {
        if (!socket.isAdmin) return; // 認証済み管理者のみ
        const enabled = !!(payload && payload.enabled);
        const name = ((payload && payload.username) || config.username || '').replace(/^@/, '').trim();
        config.autoConnect = enabled;
        if (name) config.username = name;
        saveConfig();
        io.emit('config', config);
        if (enabled && config.username) {
            broadcast('system', { message: `自動接続ON: @${config.username} の配信開始を待機します` });
            maintainConnection();
        } else {
            cancelAutoRetry();
            broadcast('system', { message: '自動接続OFF' });
        }
    });

    // テスト発火 (配信していなくてもオーバーレイ動作確認できる)
    socket.on('test', type => {
        if (!socket.isAdmin) return; // 認証済み管理者のみ
        const dummy = { userId: 'test_user', nickname: 'テスト太郎', avatar: '' };
        if (type === 'gift') {
            broadcast('gift', { ...dummy, giftName: 'ローズ', giftImage: '', count: 5, diamonds: 5 });
        } else if (type === 'chat') {
            broadcast('chat', { ...dummy, comment: 'こんにちは!テストコメントです' });
        } else if (type === 'follow') {
            broadcast('follow', dummy);
        } else if (type === 'like') {
            status.likes += 10;
            broadcast('like', { ...dummy, count: 10, total: status.likes });
            pushStatus();
        }
    });
});

const PORT = config.port || 8181;
// 127.0.0.1 のみで待受: 外部からの平文アクセスを遮断し、必ずCaddy(HTTPS)経由にする
const HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
    console.log('==========================================');
    console.log(`  TikTok LIVE ツール 起動しました (${HOST}:${PORT})`);
    console.log(`  ※ 外部公開はCaddy(HTTPS)経由`);
    console.log('==========================================');
    if (config.autoConnect && config.username) {
        console.log(`[自動接続] @${config.username} の配信開始を待機します`);
        maintainConnection();
    }
});
