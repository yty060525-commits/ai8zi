/* 测试环境的网络闸口：把全局 fetch 换成「外部一律拦、本机放行」的版本。

   为什么要有这一层：本仓库的测试一次都不该碰真实 AI API —— 那会花真钱、会因限流或
   额度而随机失败、还会把命主数据发到外部。光靠「每个用例都记得注入假 provider」不够，
   漏一个就是真金白银。所以不逐个调用点去加检查(那样会污染生产代码)，而是在测试启动时
   把 fetch 包一层：目标是外部主机就抛错并说明是谁在连，目标是 localhost 就照常走。

   用法：测试文件顶部 `import './netGuard.mjs';` 即生效(import 有副作用)。
   确实需要外网的极少数用例用 allowNetwork(reason, fn) 显式放行，理由会被记录便于审计。 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

const blocked = [];
let originalFetch;
let installed = false;

export function isLocalTarget(url) {
  const raw = String(url ?? '');
  // 相对地址(如 '/api/chat')由本地测试服务承接，属于放行范围
  if (raw.startsWith('/')) return true;
  try { return LOCAL_HOSTS.has(new URL(raw, 'http://localhost').hostname); } catch { return false; }
}

/** 本次会话内被拦下的出站请求，供测试断言「确实一次都没试图外连」。 */
export function blockedAttempts() { return blocked.slice(); }

export function enableNetworkGuard() {
  if (installed) return;
  originalFetch = globalThis.fetch;
  installed = true;
  globalThis.fetch = async function guardedFetch(input, init) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
    if (!isLocalTarget(url)) {
      const entry = { url, at: Date.now() };
      blocked.push(entry);
      throw new Error('测试环境禁止访问外部接口：' + url + '。请改用假的 provider/fetch；确需外网请用 allowNetwork() 显式放行。');
    }
    return originalFetch(input, init);
  };
}

export function disableNetworkGuard() {
  if (!installed) return;
  globalThis.fetch = originalFetch;
  installed = false;
}

/** 显式放行的逃生口。reason 必填，方便日后审计谁在用。 */
export async function allowNetwork(reason, fn) {
  if (!reason) throw new Error('allowNetwork 必须给出理由');
  blocked.push({ url: '(allowed) ' + reason, at: Date.now(), allowed: true });
  const wasInstalled = installed;
  disableNetworkGuard();
  try { return await fn(); } finally { if (wasInstalled) enableNetworkGuard(); }
}

// import 即生效：测试文件只要引了这个模块，外连就被封住。
enableNetworkGuard();
