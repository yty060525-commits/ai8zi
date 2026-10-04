import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiAuth, apiRecords, getServerSession, runTaskOnServer, ServerError, serverFetch, setServerSession, setServerUrl } from '../data/serverClient';
import { analyzeBazi } from '../data/deepseekAdapter';
import type { BaziRecord } from '../types/domain';

const record: BaziRecord = {
  id: 'r1', name: '测试', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: { zodiac: '鼠', dayMaster: '庚' } as BaziRecord['nonAiResult'], aiStatus: 'not_started',
};

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const out = await handler(String(url), init);
    return { ok: true, status: 200, json: async () => out } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
afterEach(() => {
  vi.unstubAllGlobals();
  try { localStorage.clear(); } catch {}
});

describe('服务器客户端(默认通道)', () => {
  it('登录请求发往服务器并保存会话(token=记住此设备)', async () => {
    const fn = mockFetch(async (url, init) => {
      expect(url).toContain('/api/auth/login');
      expect(JSON.parse(String(init?.body))).toEqual({ username: '主人', password: 'pw123456' });
      return { token: 'tok-1', user: { username: '主人', role: 'admin' } };
    });
    setServerUrl('http://127.0.0.1:8787');
    const data = await apiAuth.login('主人', 'pw123456');
    setServerSession({ token: data.token, username: data.user.username, role: data.user.role });
    expect(getServerSession()?.username).toBe('主人');
    expect(fn).toHaveBeenCalled();
  });

  it('runTaskOnServer 携带 task/tone/record 并映射结果', async () => {
    const fn = mockFetch(async (url, init) => {
      expect(url).toContain('/api/records/r1/ai/task');
      const body = JSON.parse(String(init?.body));
      expect(body.tone).toBe(60);
      expect(body.task.type).toBe('baseline');
      expect(body.record.id).toBe('r1');
      return { result: { status: 'completed', analysis: { pattern: 'p', strength: '强', usefulElements: [], avoidElements: [], explanation: 'ok' } } };
    });
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'u', role: 'user' });
    const out = await runTaskOnServer(record, { taskId: 'task-01', type: 'baseline' }, 60);
    expect(out.status).toBe('completed');
    expect(fn).toHaveBeenCalled();
  });

  it('服务器不可达时 serverFetch 抛 ServerError(status 0)', async () => {
    mockFetch(async () => { throw new TypeError('fetch failed'); });
    setServerUrl('http://127.0.0.1:1');
    await expect(serverFetch('/records')).rejects.toMatchObject({ status: 0 });
    await expect(serverFetch('/records')).rejects.toBeInstanceOf(ServerError);
  });

  it('配置服务器并登录后 analyzeBazi 默认走服务器(不走直连)', async () => {
    mockFetch(async (url) => {
      expect(url).toContain('/api/records/r1/ai/task');
      return { result: { status: 'completed', analysis: { pattern: 'p', strength: '弱', usefulElements: [], avoidElements: [], explanation: '服务器分析' } } };
    });
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'u', role: 'user' });
    const out = await analyzeBazi(record, { taskId: 'task-01', type: 'baseline' }, { tone: 80 });
    expect(out.status).toBe('completed');
    expect(out).toMatchObject({ analysis: { explanation: '服务器分析' } });
  });

  /* 「清缓存」按钮在网页版走的是这条没被任何用例碰过的路径：真发 POST、把服务器的
     removed 计数原样交给界面播报。旧实现这里读 data.count —— 服务器回的是 removed，
     于是每次清理都在界面上报「零条」(假回执)。下面三条钉住方法、响应字段与非200分支。 */
  it('清缓存请求用 POST 发出，并把服务器删掉的条数原样返回', async () => {
    const seen: { method?: string; body?: unknown }[] = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method, body: init?.body });
      expect(String(url)).toBe('http://127.0.0.1:8787/api/records/r1/ai/cache-clear');
      // 必须是 JSON 请求体：Content-Type 是 application/json 而 body 为 undefined 时，
      // 部分服务器侧的读取会当成坏请求；这里按实现钉成 '{}'。
      expect(String(init?.body)).toBe('{}');
      return { ok: true, status: 200, json: async () => ({ removed: 7 }) } as Response;
    });
    vi.stubGlobal('fetch', fn);
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'u', role: 'user' });
    const removed = await apiRecords.clearChartCache({ id: record.id });
    expect(removed).toBe(7);
    expect(seen).toEqual([{ method: 'POST', body: '{}' }]);
  });

  it('服务器回非200 → 抛 ServerError 带上状态码，界面才不会把失败播报成「已清 0 条」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({ error: '不属于你' }),
    } as Response)));
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'u', role: 'user' });
    await expect(apiRecords.clearChartCache({ id: record.id })).rejects.toMatchObject({ status: 403, message: '不属于你' });
  });

  it('离线删除也走 DELETE 单一路径：URL 带编码后的 id，不回读服务器落库行', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe('DELETE');
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }));
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'u', role: 'user' });
    await apiRecords.remove('a b/斜杠');
    expect(urls).toEqual(['http://127.0.0.1:8787/api/records/' + encodeURIComponent('a b/斜杠')]);
  });
});
