// TikTok LIVE ツール Service Worker (PWAインストール要件を満たす最小構成)
const CACHE = 'ttlive-v1';
const SHELL = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

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
    if (url.pathname.startsWith('/socket.io')) return;
    event.respondWith(fetch(req).catch(() => caches.match(req)));
});
