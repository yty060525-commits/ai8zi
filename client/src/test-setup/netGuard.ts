/* vitest 全局前置：把对外部 AI 服务的真实请求封掉。

   客户端有两条出口会真花钱：deepseekAdapter 的 fetch(浏览器直连/服务器通道)，
   以及 Tauri 的 invoke。测试里一旦有人忘了注入假实现，就是真调用、真扣费、
   还会把命主数据发出去。这里在测试启动时统一上闸，用例无需各自记得处理。

   需要访问本机预览服务或确实要放行的用例，用 allowNetwork(reason, fn)。 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

const blocked: { url: string; at: number; allowed?: boolean }[] = [];
let originalFetch: typeof fetch | undefined;

export function isLocalTarget(url: unknown): boolean {
  const raw = String(url ?? '');
  if (raw.startsWith('/')) return true;
  try { return LOCAL_HOSTS.has(new URL(raw, 'http://localhost').hostname); } catch { return false; }
}

export function blockedAttempts() { return blocked.slice(); }

export function enableNetworkGuard(): void {
  if (originalFetch) return;
  originalFetch = globalThis.fetch;
  const real = originalFetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String((input as Request)?.url ?? '');
    if (!isLocalTarget(url)) {
      blocked.push({ url, at: Date.now() });
      throw new Error('测试环境禁止访问外部接口：' + url + '。请注入假的 provider/fetch；确需外网请用 allowNetwork() 显式放行。');
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
}

export function disableNetworkGuard(): void {
  if (!originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = undefined;
}

/** 显式放行的逃生口。reason 必填，便于审计谁在用。 */
export async function allowNetwork<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  if (!reason) throw new Error('allowNetwork 必须给出理由');
  blocked.push({ url: '(allowed) ' + reason, at: Date.now(), allowed: true });
  disableNetworkGuard();
  try { return await fn(); } finally { enableNetworkGuard(); }
}

enableNetworkGuard();
