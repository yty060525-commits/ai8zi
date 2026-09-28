import type { BaziRecord, BaziAnalysisTask, BaziTaskResult } from '../types/domain';
import { getBrowserCredential } from './aiSettings';

/* ---------------- 服务器与账号会话(设备记住) ---------------- */
export interface ServerSession { token: string; username: string; role: 'admin' | 'user' }
const K_URL = 'mingli.server.url';
const K_SESSION = 'mingli.server.session';
const safeStorage = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* 忽略 */ } },
};
export const getServerUrl = (): string => (safeStorage.get(K_URL) || '').replace(/\/$/, '');
export const setServerUrl = (url: string) => { safeStorage.set(K_URL, (url || '').trim()); };
export const getServerSession = (): ServerSession | null => {
  const raw = safeStorage.get(K_SESSION);
  if (!raw) return null;
  try { return JSON.parse(raw) as ServerSession; } catch { return null; }
};
export const setServerSession = (s: ServerSession | null) => { if (s) safeStorage.set(K_SESSION, JSON.stringify(s)); else safeStorage.del(K_SESSION); };
export const isServerMode = (): boolean => !!getServerUrl() && !!getServerSession();

export class ServerError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** 统一的服务器请求；失败会抛 ServerError(网络错误 status=0)。 */
export async function serverFetch<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal; auth?: boolean } = {}): Promise<{ status: number; data: T }> {
  const base = getServerUrl();
  if (!base) throw new ServerError(0, '尚未设置服务器地址');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== false) {
    const session = getServerSession();
    if (session?.token) headers.Authorization = 'Bearer ' + session.token;
  }
  let res: Response;
  try {
    res = await fetch(base + '/api' + path, {
      method: opts.method ?? 'GET',
      headers,
      signal: opts.signal,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ServerError(0, '无法连接服务器（网络不可达）');
  }
  let data: T = undefined as T;
  try { data = (await res.json()) as T; } catch { /* 无 JSON */ }
  if (!res.ok) throw new ServerError(res.status, ((data as { error?: string })?.error) || ('HTTP ' + res.status));
  return { status: res.status, data };
}

/* ---------------- 账号 ---------------- */
export const apiAuth = {
  async register(username: string, password: string) {
    const { data } = await serverFetch<{ token: string; user: ServerSession['role'] extends never ? never : { username: string; role: 'admin' | 'user' } }>('/auth/register', { method: 'POST', body: { username, password } });
    return data;
  },
  async login(username: string, password: string) {
    const { data } = await serverFetch<{ token: string; user: { username: string; role: 'admin' | 'user' } }>('/auth/login', { method: 'POST', body: { username, password } });
    return data;
  },
  async me() {
    const { data } = await serverFetch<{ user: { username: string; role: 'admin' | 'user' } }>('/auth/me');
    return data.user;
  },
  async logout() { try { await serverFetch('/auth/logout', { method: 'POST' }); } catch { /* 离线也清除本地 */ } },
  async changePassword(oldPw: string, newPw: string) {
    await serverFetch('/auth/password', { method: 'POST', body: { old: oldPw, new: newPw } });
  },
};

/* ---------------- 记录(同步) ---------------- */
export const apiRecords = {
  list: async () => (await serverFetch<{ records: BaziRecord[] }>('/records')).data.records,
  get: async (id: string) => (await serverFetch<{ record: BaziRecord }>('/records/' + encodeURIComponent(id))).data.record,
  /** 整条覆盖(记录必须已在服务器上存在；新建请用 create)。不回读服务器那份落库行：
   *  它是瘦身 + 白名单列的产物，调用方拿它当「最新数据」会把本机的 toneUsed/AI 结果比没了。 */
  upsert: async (record: BaziRecord) => { await serverFetch('/records/' + encodeURIComponent(record.id), { method: 'PUT', body: record }); },
  /** 新建一盘。服务器的 PUT 对不存在的 id 直接回 404「记录不存在」，只有 POST 会建行，
   *  所以离线建的盘第一次上传必须走这里 —— 旧实现全用 PUT，结果每条都 404、永远标着未同步。 */
  create: async (record: BaziRecord) => { await serverFetch('/records', { method: 'POST', body: record }); },
  remove: async (id: string) => { await serverFetch('/records/' + encodeURIComponent(id), { method: 'DELETE' }); },
  /** 清掉服务器为该命盘(性别+四柱)缓存的 AI 结果。只需 id，签名由服务器按库内记录算。 */
  clearChartCache: async (record: Pick<BaziRecord, 'id'>) => {
    const { data } = await serverFetch<{ removed: number }>('/records/' + encodeURIComponent(record.id) + '/ai/cache-clear', { method: 'POST', body: {} });
    return data.removed;
  },
};

/* ---------------- 管理员 ---------------- */
export const apiAdmin = {
  listAll: async () => (await serverFetch<{ records: BaziRecord[] }>('/admin/records')).data.records,
  config: async () => (await serverFetch('/admin/config')).data,
  saveConfig: async (payload: { provider?: string; keys?: Record<string, string> }) => { await serverFetch('/admin/config', { method: 'POST', body: payload }); },
  test: async () => (await serverFetch('/admin/test', { method: 'POST' })).data,
};

/* ---------------- AI：默认走服务器；断网时退回本机备用密钥直接分析 ---------------- */
export async function runTaskOnServer(record: BaziRecord, task: BaziAnalysisTask, tone: number | undefined, signal?: AbortSignal): Promise<{ status: 'completed' | 'failed' | 'not_configured'; analysis?: unknown; error?: string }> {
  // 带上本机“当前使用通道”：服务器优先用它，未配置时才回退到服务器自己的顺序
  let provider: string | undefined;
  try { provider = localStorage.getItem('mingli.provider') ?? undefined; } catch { provider = undefined; }
  const { data } = await serverFetch<{ result: { status: string; analysis?: unknown; error?: string } }>(
    '/records/' + encodeURIComponent(record.id) + '/ai/task',
    { method: 'POST', body: { task, tone, record, provider }, signal },
  );
  return { status: data.result.status as 'completed' | 'failed' | 'not_configured', analysis: data.result.analysis, error: data.result.error };
}


/** 本机备用直连(无服务器 / 服务器断线时用)：优先 DeepSeek 浏览器凭据。 */
export async function runLocalFallback(record: BaziRecord, task: BaziAnalysisTask | undefined, tone: number | undefined, signal?: AbortSignal): Promise<{ ok: boolean } | { ok: false; reason: string }> {
  // 不再写死 DeepSeek：交给直连实现按“当前使用通道 → 其余已配置通道”依次尝试
  const { browserFallback } = await import('./deepseekAdapter');
  return browserFallback(record, task, tone, undefined, signal);
}
