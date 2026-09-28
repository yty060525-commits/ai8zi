import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setServerUrl, setServerSession } from '../data/serverClient';
import { configureBaziRepository, memoryBaziRepository, hydrateRecord, flushPendingPruneWrites, __assumeOnServerForTests } from '../data/clientRepository';
import type { BaziRecord } from '../types/domain';

const year = new Date().getFullYear();
const ID = 'prune-push-1';

/** 去年建的盘：任务里带着上一窗口的流年/流月，读取时会被清洗掉两条。 */
function staleRecord(): BaziRecord {
  const mk = (id: string, task: Record<string, unknown>) => [id, { task: { taskId: id, ...task }, status: 'not_configured' }];
  const staleTasks: Array<[string, Record<string, unknown>]> = [
    ['task-01', { type: 'baseline' }],
    ['task-02', { type: 'annual', year: year - 1 }],
    ['task-12', { type: 'monthly', year: year - 1, month: 3 }],
  ];
  return {
    id: ID, name: '回写推送', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: new Date(Date.UTC(year - 1, 2, 8, 12, 34, 56)).toISOString(),
    yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未',
    aiStatus: 'not_started',
    nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } as unknown as BaziRecord['nonAiResult'],
    aiTasks: Object.fromEntries(staleTasks.map(([id, task]) => mk(id, task))) as unknown as BaziRecord['aiTasks'],
  } as unknown as BaziRecord;
}

/* 服务器请求一律用 fetch 假实现拦下：既不会真联网(安全网)，又能看到方法与报文。 */
const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
function stubFetch(fail = false) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const rec = { method: String(init?.method ?? 'GET'), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(rec);
    if (fail) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response;
    return { ok: true, status: 200, json: async () => ({ record: rec.body }) } as Response;
  }));
}

const localTaskCount = async () => Object.keys((await memoryBaziRepository.getBaziRecord(ID))?.aiTasks ?? {}).length;
/** 只算「写某一条盘」的请求；GET /records 的同步拉取不算。 */
const pushCalls = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  configureBaziRepository(memoryBaziRepository);
  calls.length = 0;
  localStorage.clear();
  // 服务器模式由「填了地址 + 有会话」决定，这里走真实入口置位，而不是再 mock 一层布尔
  setServerUrl('http://127.0.0.1:8787');
  setServerSession({ token: 't', username: 'probe_a', role: 'user' });
  // 这条盘服务器已经有了(测试里直接写进本地库)：推送该走 PUT 覆盖，不是 POST 建行
  __assumeOnServerForTests([ID]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('过期任务清洗后必须推回服务器(B2)', () => {
  it('本机清洗掉旧时段 → 同一份清洗结果推上服务器，否则换设备会拉回旧任务', async () => {
    stubFetch();
    await memoryBaziRepository.saveBaziRecord(staleRecord());
    expect(await localTaskCount()).toBe(3);

    await hydrateRecord(staleRecord()); // 触发 pruneOnRead → queuePruneWrite
    await flushPendingPruneWrites();

    expect(await localTaskCount()).toBeLessThan(3);
    const push = pushCalls().at(-1);
    expect(push, '清洗结果没有推给服务器：另一台设备同步时会把过期时段拉回来').toBeTruthy();
    expect(push!.url).toBe('http://127.0.0.1:8787/api/records/' + ID);
    // 推上去的必须就是清洗后的那份：三条旧时段只剩本命一条
    expect(Object.keys((push!.body?.aiTasks ?? {}) as object)).toEqual(['task-01']);
  });

  it('推送被拒时留待推送标记，下轮补推(不静默丢掉清洗结果)', async () => {
    stubFetch(true);
    await memoryBaziRepository.saveBaziRecord(staleRecord());
    await hydrateRecord(staleRecord());
    await flushPendingPruneWrites();
    expect(pushCalls().length).toBeGreaterThan(0);
    // dirty 键带账号命名空间(无账号时是 mingli.pwa.records.dirty)，按后缀找，别把键名写死第二份
    const key = Object.keys(localStorage).find((k) => k.endsWith('.dirty'));
    expect(JSON.parse(localStorage.getItem(key ?? '') ?? '[]')).toContain(ID);
  });
});
