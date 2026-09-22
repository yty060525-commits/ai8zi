import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element is missing');
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost','127.0.0.1'].includes(location.hostname)) && import.meta.env.MODE !== 'test') {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').then((registration) => {
      /* 新 SW 装好接管后自动重载一次，用户不用杀进程重开。
         只在「页面本来就被旧 SW 控着」时重载：首次安装时页面本就是新代码，
         重载是多余的。用 sessionStorage 打标，避免极端情况下反复刷新。 */
      const hadController = Boolean(navigator.serviceWorker.controller);
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state !== 'installed' || !hadController) return;
          if (sessionStorage.getItem('mingli.sw.reloaded') === '1') return;
          sessionStorage.setItem('mingli.sw.reloaded', '1');
          location.reload();
        });
      });
    }).catch(() => { /* 离线或禁用 SW 时不影响主流程 */ });
  });
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
);