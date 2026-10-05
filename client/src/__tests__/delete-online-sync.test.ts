/* 联网状态下「删除数据」这条通道：详情页那句承诺是「四柱、排盘数据与全部批断结果一并清除，无法撤销」。
   此前全仓只有一处 DELETE 判据(server-client.test.ts:102)，它直接调 apiRecords.remove，
   等于只测了 fetch 包装层；clientRepository.deleteBaziRecord 里那道
   `if (serverActive() || …) { try { await apiRecords.remove(id); } catch {} }` 从未被执行过 ——
   唯一走导出函数的用例(sync-admin-ghost.test.ts:364)压根没设置服务器地址，那条 if 恒假。
   于是「删本机一条、服务器上原样留着」这种缺陷可以静默上线：界面没了，换台设备一同步又全回来，
   而且用户被告知「无法撤销」，没有任何补救入口。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __allowUnsyncedIdsForTests, __resetSyncStateForTests, __setOwnerKeyForTests, configureBaziRepository, deleteBaziRecord, listBaziRecords, saveBaziRecord, storageBackedBaziRepository } from '../data/clientRepository';
import { setServerSession, setServerUrl } from '../data/serverClient';
import type { BaziRecord } from '../types/domain';

const KEY = 'mingli.records.deltest';
const OWNER_KEY = 'mingli.record.owners.deltest';

const record = (id: string, name: string): BaziRecord => ({
  id, name, gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_started',
});

/** 一个极简的服务器桩：store 就是「服务器现在有哪些盘」，判据一律读它，不读请求日志之外的第二份状态。
 *  GET /api/records 会故意把被删的那条继续返回(除非 dropDeleted 为真) —— 这正是真实服务器的形态：
 *  客户端不发 DELETE，服务器那一行就永远在，下一轮拉取合并照单全收。 */
let store: Map<string, BaziRecord>;
let requests: Array<{ method: string; url: string }>;
function mockServer() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET');
    requests.push({ method, url: u });
    if (/\/api\/records$/.test(u) && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ records: [...store.values()] }) } as Response;
    }
    const single = /\/api\/records\/([^/?]+)$/.exec(u);
    if (single && method === 'DELETE') {
      store.delete(decodeURIComponent(single[1]));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if ((method === 'POST' || method === 'PUT')) {
      const rec = JSON.parse(String(init?.body)) as BaziRecord;
      store.set(rec.id, rec);
      return { ok: true, status: 200, json: async () => ({ record: rec }) } as Response;
    }
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  }));
}

beforeEach(() => {
  store = new Map();
  requests = [];
  __setOwnerKeyForTests(OWNER_KEY);
  __allowUnsyncedIdsForTests(true);
  __resetSyncStateForTests();
  configureBaziRepository(storageBackedBaziRepository(KEY));
  setServerUrl('http://127.0.0.1:8787');
  setServerSession({ token: 'tok', username: 'deltest', role: 'user' });
  mockServer();
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setOwnerKeyForTests(null);
  __allowUnsyncedIdsForTests(false);
  __resetSyncStateForTests();
  try { localStorage.clear(); } catch { /* jsdom 可能禁用 storage */ }
});

describe('联网删除：本机消失的同时，服务器那一行也要真的没了', () => {
  it('删一条已同步的盘：发出 DELETE，且服务器清单里不再返回它', async () => {
    await saveBaziRecord(record('gone', '待删'));
    await saveBaziRecord(record('stay', '自留'));
    /* 夹具前提自证：两条都进了服务器那份 store，否则下面的「不再返回」是在空集上永真。 */
    expect([...store.keys()].sort(), '夹具前提：服务器应有两条盘').toEqual(['gone', 'stay']);

    await deleteBaziRecord('gone');

    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.url),
      '联网删除没发 DELETE ⇒ 界面说清除了，服务器还留着整条命盘').toEqual(['http://127.0.0.1:8787/api/records/gone']);
    expect(store.has('gone'), '发了 DELETE 但桩里的行还在 ⇒ 请求根本没落到删除端点').toBe(false);

    /* 闭环：再读一次列表(它会重新拉服务器清单)。若实现只删本机不发请求，
       上一句已经红；这一句钉的是「删完立刻重读，那条不会复活」。 */
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids).not.toContain('gone');
    expect(ids, '只该带走那一条，其余记录不能被牵连').toContain('stay');
    /* 实测读数(逐条抓的，不是推算)：两次新建各发一条 POST /api/records(服务器没有这条盘，
       PUT 会 404，所以走建行那条)，删除发一条 DELETE，随后重读列表发一条 GET。
       钉的是「删除只多发这一条 DELETE」——若有人把删除改成整表重写(再发 POST/PUT)，这里会红。 */
    expect(requests.map((r) => r.method + ' ' + r.url.replace('http://127.0.0.1:8787', '')), '现状：一次联网删除的请求序列').toEqual(['POST /api/records', 'POST /api/records', 'DELETE /api/records/gone', 'GET /api/records']);
  });

  it('反向钉子：桩故意继续返回已删的那条时，重读列表确实会把它捞回来', async () => {
    /* 这条证明上面那句判据不是摆设：删除请求一旦不发出去，复活路径是真的会发生。
       做法是让 DELETE 变成空转(服务器"拒绝"但仍回 200)，其余与上一个用例一致。 */
    await saveBaziRecord(record('zombie', '诈尸'));
    // 换成一条「收到 DELETE 却什么都不删」的桩(等价于旧实现压根不发这条请求)。
    // vi.stubGlobal 本身可重复调用，后一次覆盖前一次；unstubAllGlobals 在 afterEach 收尾。
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      if (/\/api\/records$/.test(u) && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ records: [...store.values()] }) } as Response;
      }
      if ((method === 'POST' || method === 'PUT')) {
        const rec = JSON.parse(String(init?.body)) as BaziRecord;
        store.set(rec.id, rec);
        return { ok: true, status: 200, json: async () => ({ record: rec }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    await deleteBaziRecord('zombie');
    const ids = (await listBaziRecords()).map((r) => r.id);
    expect(ids, '删除请求没生效时本不该再看见它 —— 这条红了说明复活路径判据本身失效').toContain('zombie');
  });
});
