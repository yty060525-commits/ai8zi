import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRecords, setServerUrl } from '../data/serverClient';

/** 服务器的 PUT /api/records/:id 对**不存在**的 id 直接回 404「记录不存在」，只有 POST /api/records
 *  会建行。客户端曾一律用 PUT 推送离线建的盘：每条都撞 404，于是永远标着「未同步」、聊天也永远查不到。
 *  这条锁住「新建走 create(POST)」这一层契约，防止有人把上传又改回单一 upsert。 */
describe('记录上传的方法选择', () => {
  afterEach(() => { vi.unstubAllGlobals(); try { localStorage.clear(); } catch { /* 忽略 */ } });

  const stub = (calls: Array<{ method: string; url: string }>) => vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: String(init?.method ?? 'GET'), url: String(url) });
    return { ok: true, status: 200, json: async () => ({ record: { id: 'x1' } }) } as Response;
  });

  it('create 用 POST 到集合端点，upsert 用 PUT 到单条端点', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal('fetch', stub(calls));
    setServerUrl('http://127.0.0.1:8787');
    const record = { id: 'x1', name: '甲', gender: 'male', birthYear: 1990, birthMonth: 1, createdAt: '', yearPillar: '甲子', monthPillar: '乙丑', dayPillar: '丙寅', hourPillar: '丁卯', aiStatus: 'not_started' } as never;
    await apiRecords.create(record);
    await apiRecords.upsert(record);
    expect(calls[0]).toEqual({ method: 'POST', url: 'http://127.0.0.1:8787/api/records' });
    expect(calls[1].method).toBe('PUT');
    expect(calls[1].url).toBe('http://127.0.0.1:8787/api/records/x1');
  });
});
