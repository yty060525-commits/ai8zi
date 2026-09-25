/* PWA 缓存：页面(导航)网络优先=每次打开自动取最新版；资源文件缓存优先以支持离线。
   CACHE 里的 1790338287791 由 vite.config.ts 在构建时替换成当次构建的时间戳 ——
   必须有这一层：CACHE 若是写死的常量，旧缓存在任何一次发版后都不会被清掉，
   装了 PWA 的手机就永远停在旧版本(资源是缓存优先，命中就直接用、根本不联网)。 */
const CACHE = 'mingli-1790338287791';

self.addEventListener('install', (e) => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // 同源但**不归本站管**的请求一律放行不碰：主要是本机后端 API(如 /api/…)。
  // 这些请求若被下面的「缓存优先」命中，会拿到一次旧回包 —— 对 POST 转 GET 的接口、
  // 或刚写入就回读的列表来说就是数据错乱；网络失败时又会被兜到 index.html，
  // 让前端把一段 HTML 当 JSON 解析，报出莫名其妙的「分析失败」。
  if (url.startsWith(self.location.origin) && /\/api\//.test(url)) return;
  if (e.request.mode === 'navigate' || url.indexOf('/index.html') >= 0) {
    // 页面入口：网络优先(在线必是新版)；断网回退到最近缓存的页面。
    // cache: 'no-store' 是关键：GitHub Pages 给 index.html 也发 max-age=600，
    // 默认的 fetch 会吃这份 HTTP 缓存，于是「网络优先」取回的仍是旧页面。
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
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
