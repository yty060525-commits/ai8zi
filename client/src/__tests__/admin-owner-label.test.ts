import { afterEach, describe, expect, it, vi } from 'vitest';
import { listBaziRecords, saveBaziRecord, syncAdminAll } from '../data/clientRepository';
import { setServerSession, setServerUrl } from '../data/serverClient';
import type { BaziRecord } from '../types/domain';

/** 管理员列表页写着「本列表为服务器全部账号记录，含账号名」：/api/admin/records 确实每条带
 *  username，但普通同步(/api/records)不带。旧实现整条覆盖，标签永远显示不出来。 */
const record = (id: string, name: string): BaziRecord => ({
  id, name, gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_started',
});

let calls: string[];
function mockAdminThenPlain(adminRows: BaziRecord[]) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(u + ' ' + (init?.method ?? 'GET'));
    if (u.includes('/api/admin/records')) return { ok: true, status: 200, json: async () => ({ records: adminRows }) } as Response;
    // 普通列表(不带 username)；POST 是上传，回一条空壳即可
    if (u.endsWith('/api/records') && init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ record: {} }) } as Response;
    if (u.endsWith('/api/records')) return { ok: true, status: 200, json: async () => ({ records: adminRows.map(({ username: _u, ...rest }) => rest) }) } as Response;
    throw new Error('unexpected fetch: ' + u);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  try { localStorage.clear(); } catch {}
});

describe('管理员视图的所属账号名', () => {
  it('普通同步拉回不带 username 的同一批盘后，列表仍保留账号名', async () => {
    setServerUrl('http://127.0.0.1:8787');
    setServerSession({ token: 'tok', username: 'boss', role: 'admin' });
    mockAdminThenPlain([{ ...record('a1', '张三'), username: '客户甲' }, { ...record('a2', '李四'), username: '客户乙' }]);
    await saveBaziRecord(record('a1', '张三'));
    await saveBaziRecord(record('a2', '李四'));
    // 第一轮：管理员全量同步把 username 写进内存与账号表
    await syncAdminAll();
    expect(calls.some((u) => u.includes('/api/admin/records'))).toBe(true);
    expect((await listBaziRecords()).map((r) => r.username)).toEqual(['客户甲', '客户乙']);
    // 第二轮：普通同步(服务器不返回 username)覆盖之后，名字不能被抹掉
    calls = [];
    const second = await listBaziRecords();
    expect(calls.some((u) => /\/api\/records GET$/.test(u))).toBe(true);
    expect(second.map((r) => r.username)).toEqual(['客户甲', '客户乙']);
  });
});
