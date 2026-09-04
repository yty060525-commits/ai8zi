/* PWA 缓存：页面(导航)网络优先=每次打开自动取最新版；资源文件缓存优先以支持离线 */
const CACHE = 'mingli-v2';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((name) => name !== CACHE).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (e.request.mode === 'navigate' || url.indexOf('/index.html') >= 0) {
    // 页面入口：网络优先(在线必是新版)；断网回退到最近缓存的页面
    e.respondWith(
      fetch(e.request)
        .then((res) => { if (res.ok) { const copy = res.clone(); if (url.startsWith(self.location.origin)) caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }
  // 其它静态资源(带内容哈希)：缓存优先，同时在后台更新缓存
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const network = fetch(e.request).then((res) => { if (res.ok && url.startsWith(self.location.origin)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; }).catch(() => hit);
      return hit || network;
    })
  );
});
