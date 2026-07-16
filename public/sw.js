// TikTok LIVE ツール Service Worker (PWAインストール要件を満たす最小構成)
const CACHE = 'ttlive-v1';
const PAGE_CACHE = 'ttlive-page-v1';
const SHELL = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

// ダッシュボードのキャッシュ保持期間 (7日)
const PAGE_TTL = 7 * 24 * 60 * 60 * 1000;
const STAMP = 'X-SW-Cached-At';

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== CACHE && k !== PAGE_CACHE).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
});

// ログアウト時にダッシュボードのキャッシュを破棄する (同じ端末で別ユーザーが
// ログインした時に、前ユーザーの画面が出るのを防ぐ)
self.addEventListener('message', event => {
    if (event.data === 'clear-page-cache') {
        event.waitUntil(caches.delete(PAGE_CACHE));
    }
});

function isDashboard(url) {
    return url.origin === self.location.origin &&
        (url.pathname === '/dashboard' || url.pathname === '/dashboard.html');
}

// 保存時刻をヘッダーに埋めてキャッシュする
async function putStamped(req, res) {
    const body = await res.clone().blob();
    const headers = new Headers(res.headers);
    headers.set(STAMP, String(Date.now()));
    const cache = await caches.open(PAGE_CACHE);
    await cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }));
}

function isFresh(res) {
    const at = Number(res.headers.get(STAMP) || 0);
    return at > 0 && (Date.now() - at) < PAGE_TTL;
}

// 未ログインだと /login へリダイレクトされる。その応答はキャッシュしない
function isCacheable(res) {
    return !!res && res.ok && !res.redirected && res.type === 'basic';
}

// ダッシュボード: 7日以内のキャッシュを即返しつつ、裏で最新版を取得して次回に反映
async function dashboardSWR(event) {
    const req = event.request;
    const cache = await caches.open(PAGE_CACHE);
    const hit = await cache.match(req);
    const network = fetch(req)
        .then(async res => { if (isCacheable(res)) await putStamped(req, res); return res; })
        .catch(() => null);
    event.waitUntil(network); // 応答を返した後もSWを生かして裏の更新を完了させる

    if (hit && isFresh(hit)) return hit; // 裏の更新(network)は待たない
    const res = await network;
    if (res) return res;
    if (hit) return hit; // 期限切れでもオフラインなら出す
    return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ネットワーク優先 + オフライン時のみキャッシュ。socket.io と非GETは素通し
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.pathname.startsWith('/socket.io')) return;
    if (isDashboard(url)) { event.respondWith(dashboardSWR(event)); return; }
    event.respondWith(fetch(req).catch(() => caches.match(req)));
});
