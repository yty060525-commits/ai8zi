/* 极简缓存：让 PWA 可离线启动 */
const CACHE = 'mingli-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== CACHE).map((n) => caches.delete(n))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => { const copy = res.clone(); if (res.ok && e.request.url.startsWith(self.location.origin)) caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => hit)));
});
