import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { unlockFromLocation } from './data/localSystem';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element is missing');
}

/* 旧页面动态 import 已不存在的带哈希 chunk(Vite 的 preloadError)：
   直接重载一次，让页面回到当前版本，而不是把「Failed to fetch dynamically imported module」抛给用户。
   用 sessionStorage 打标，避免服务器持续异常时反复刷新。 */
window.addEventListener('vite:preloadError', () => {
  if (sessionStorage.getItem('mingli.chunk.reloaded') === '1') return;
  sessionStorage.setItem('mingli.chunk.reloaded', '1');
  reloadFresh();
});

/* 新 SW 装好接管后自动重载一次，用户不用杀进程重开。
   为什么必须主动查：浏览器只在「页面导航」时才自动去取 sw.js，而 GitHub Pages
   给 sw.js 发了 Cache-Control: max-age=600，十分钟内连这次的取回都吃本地缓存。
   手机从主屏图标打开(尤其 iOS)根本不产生导航，更新检查可能永远不触发 ——
   这就是「装了 PWA 的手机一直停在旧版本」的根因。
   对策：注册后主动 update()、定时 update()、回到前台时 update()。update() 由浏览器
   发起，会带 no-cache，绕开那十分钟。 */
const SW_RELOAD_FLAG = 'mingli.sw.reloaded';
/* 定时复查间隔。太短会白耗流量与电池，太长则「一直开着不关」的页面迟迟不更新。 */
const SW_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/* 换版重载必须绕开缓存：普通 reload() 可能仍吃 HTTP 缓存里的旧 index.html，
   于是「重载了却还是旧版」。加时间戳参数让 URL 变成新资源，一定回源。 */
function reloadFresh(): void {
  const url = new URL(location.href);
  url.searchParams.set('_v', String(Date.now()));
  location.replace(url.toString());
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost','127.0.0.1'].includes(location.hostname)) && import.meta.env.MODE !== 'test') {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').then((registration) => {
      // 装好并接管后重载一次；用 sessionStorage 打标，避免极端情况下反复刷新。
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // 有 controller 才说明页面正被旧 SW 控着，需要重载换新；首次安装本页即新代码。
          if (installing.state !== 'installed' || !navigator.serviceWorker.controller) return;
          if (sessionStorage.getItem(SW_RELOAD_FLAG) === '1') return;
          sessionStorage.setItem(SW_RELOAD_FLAG, '1');
          reloadFresh();
        });
      });
      const check = () => { void registration.update().catch(() => { /* 离线时忽略 */ }); };
      check();
      setInterval(check, SW_CHECK_INTERVAL_MS);
      // 手机最有效的时机：从后台切回前台时查一次(此前可能几小时没导航过)。
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    }).catch(() => { /* 离线或禁用 SW 时不影响主流程 */ });
  });
}

/* 「本地系统」这一路在界面上不留任何入口：机主用地址栏 `?local=<解锁码>` 展开（见 localSystem.ts）。
   这里只把查询串里的这一段抹掉，让解锁码不留在地址栏、浏览历史或分享出去的链接里；
   页面本身不跳走 —— GitHub Pages 按**含查询串的完整路径**回源，删参数后硬跳 /ai8zi/ 之外的
   路径会 404，而 SPA 的首页状态本来就在内存里，留着当前视图最省事。 */
try {
  if (unlockFromLocation()) {
    const clean = new URL(location.href);
    clean.searchParams.delete('local');
    history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
  }
} catch { /* 非浏览器环境（构建期）忽略 */ }

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
);