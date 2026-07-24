// TikTok LIVE ツール Service Worker (PWAインストール要件を満たす最小構成)
// アイコンを差し替えたらこの番号を上げる。古いキャッシュはactivateで削除される
const CACHE = 'ttlive-v3';
// サブパス配信対応: 自分(sw.js)の位置からベースパスを割り出す (例 /tiktok/sw.js → /tiktok)
const B = self.location.pathname.replace(/\/sw\.js$/, '');
const SHELL = [B + '/manifest.webmanifest', B + '/icons/icon-192.png', B + '/icons/icon-512.png'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    );
    self.clients.claim();
});

// ネットワーク優先 + オフライン時のみキャッシュ。socket.io と非GETは素通し
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.pathname.startsWith(B + '/socket.io')) return;
    event.respondWith(fetch(req).catch(() => caches.match(req)));
});
