import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setServerUrl, setServerSession } from '../data/serverClient';
import { configureBaziRepository, memoryBaziRepository, saveBaziRecord, listBaziRecords, getBaziRecord, hydrateRecord, flushPendingPruneWrites, exportableRecords, __failRemoteForTests } from '../data/clientRepository';
import { parseBackupFile, importRecords } from '../data/sqlImport';
import type { BaziRecord } from '../types/domain';

const year = new Date().getFullYear();
const ID = 'roundtrip-1';

/** 一个「跑完分析」的盘：AI 正文 + 语气档 + 完整派生数组。 */
function fullRecord(): BaziRecord {
  const analysis = { pattern: '正官格', strength: '身弱', usefulElements: ['水'], avoidElements: ['火'], explanation: '这是一段已经生成好的 AI 正文，用于验证导入导出是否会把成果弄丢。' };
  return {
    id: ID, name: '往返甲', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: new Date(Date.UTC(2025, 2, 8, 12, 34, 56)).toISOString(),
    yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未',
    aiStatus: 'completed', toneUsed: 55, aiAnalysis: analysis as never,
    nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } as never,
    aiTasks: { 'task-01': { task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis } } as never,
  } as unknown as BaziRecord;
}

/* 全部服务器请求走 fetch 假实现：不联网，又能按方法+URL 还原出「换设备时服务器会发回什么」。 */
let store: Record<string, string>;
/** true = 当成还没 tone_used 列的老库(把该字段抹掉)，用来验证「老库里这条确实读不回语气」。 */
let dropTone = false;
/** 服务器那一行长什么样：列名白名单 + 时段数组瘦身，与 server/db.mjs 的 recordToRow 同构。 */
const serverRow = (rec: BaziRecord, withoutTone: boolean): BaziRecord => {
  const row = structuredClone(rec) as BaziRecord & Record<string, unknown>;
  delete row.userId;
  if (withoutTone) delete row.toneUsed;
  if (row.nonAiResult) {
    row.nonAiResult = { ...rec.nonAiResult, greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } as typeof row.nonAiResult;
  }
  return row as BaziRecord;
};
const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url: String(url), body });
    if (method === 'PUT' || method === 'POST') {
      const rec = body as unknown as BaziRecord;
      // 模拟服务器落库：只留白名单列(没有 tone_used 的老库会把它抹掉)，再瘦身时段数组。
      const stored = serverRow(rec, dropTone);
      store[rec.id] = JSON.stringify(stored);
      // 服务器回的是**落库行**，不是发过去的那份：老库里没有 tone_used，回包也就没有。
      // 生产代码只把这份回包当状态码用(uploadRecord 只发不收)，所以这里照实返回即可。
      return { ok: true, status: 200, json: async () => ({ record: stored }) } as Response;
    }
    if (method === 'DELETE') { delete store[url.split('/').pop()!]; return { ok: true, status: 200, json: async () => ({}) } as Response; }
    const id = url.split('/records/')[1];
    if (id && store[id]) return { ok: true, status: 200, json: async () => ({ record: JSON.parse(store[id]) }) } as Response;
    return { ok: true, status: 200, json: async () => ({ records: Object.values(store).map((s) => JSON.parse(s)) }) } as Response;
  }));
}

/** 轮询等异步回写落地，避免固定 sleep 在慢机器上假失败。 */
async function until(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  store = {};
  dropTone = false;
  calls.length = 0;
  localStorage.clear();
  configureBaziRepository(memoryBaziRepository);
  setServerUrl('http://127.0.0.1:8787');
  setServerSession({ token: 't', username: 'probe_a', role: 'user' });
  stubFetch();
  // 建盘 → 推服务器（与界面路径一致）
  await saveBaziRecord(fullRecord());
  await until(() => !!store[ID]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('导入/导出往返闭环(T1)', () => {
  it('导出 JSON 再导回来(dedupe)：同一条盘不得被服务器上的瘦身版覆盖掉 AI 正文与语气', async () => {
    const [exported] = await exportableRecords();
    expect(exported.toneUsed).toBe(55);
    expect(exported.aiTasks?.['task-01']?.analysis).toBeTruthy();

    // 换成另一台设备：本机库清空，只留服务器上那一份
    configureBaziRepository(memoryBaziRepository);
    const remote = JSON.parse(store[ID]) as BaziRecord;
    expect(remote.nonAiResult?.annualFortunes).toEqual([]); // 服务器存的是瘦身版，符合预期
    expect(remote.toneUsed, '语气档必须作为独立列存进服务器(见 server/db.mjs 的 tone_used)').toBe(55);

    const bytes = new TextEncoder().encode(JSON.stringify({ exportedAt: new Date().toISOString(), records: [exported] }));
    const parsed = await parseBackupFile(bytes, 'mingli-data.json');
    expect(parsed.records).toHaveLength(1);
    const summary = await importRecords(parsed.records, 'dedupe');
    expect({ ...summary }).toEqual({ added: 0, updated: 1, skipped: 0, total: 1 });

    await flushPendingPruneWrites();
    const back = await getBaziRecord(ID);
    expect(back?.name).toBe('往返甲');
    expect(back?.toneUsed, '语气档被服务器返回的瘦身记录抹掉了').toBe(55);
    expect(back?.aiTasks?.['task-01']?.analysis, '本命 AI 正文丢了').toBeTruthy();
    // 落库那份也必须是完整的：界面读它，推上服务器的更是它
    const storedRaw = await memoryBaziRepository.getBaziRecord(ID);
    expect(storedRaw?.toneUsed).toBe(55);
    // 推回服务器的也必须仍是完整的
    expect((JSON.parse(store[ID]) as BaziRecord).toneUsed).toBe(55);
  });

  it('本机从没跑过 AI(没有任务)时：保存语气后重读列表，服务器残缺行也不许把它抹掉', async () => {
    // 合并若按「哪一侧字段多就整条用谁」判定，这条本机没有任何 AI 任务可比，就会被
    // 服务器那份(老库连 tone_used 列都没有)整体覆盖 —— 用户刚选完语气，一次刷新回到默认。
    configureBaziRepository(memoryBaziRepository);
    expect(await listBaziRecords()).toHaveLength(1);
    await saveBaziRecord({ ...fullRecord(), aiTasks: undefined, aiAnalysis: undefined, toneUsed: 20 });
    const again = await listBaziRecords();
    expect(again.find((r) => r.id === ID)?.toneUsed).toBe(20);
  });

  it('保存后立刻重读列表：不得被服务器回读的瘦身版覆盖（同步竞态）', async () => {
    configureBaziRepository(memoryBaziRepository);   // 换设备：本机为空，服务器上已有瘦身版
    expect(await listBaziRecords()).toHaveLength(1); // 先把远端拉进视图

    await saveBaziRecord({ ...fullRecord(), toneUsed: 30 });
    const again = await listBaziRecords();
    expect(again.find((r) => r.id === ID)?.toneUsed).toBe(30);
    expect(again.find((r) => r.id === ID)?.aiTasks?.['task-01']?.analysis).toBeTruthy();
  });

  it('推送失败时：重读列表也不得丢掉本机改动，且要标成待同步', async () => {
    configureBaziRepository(memoryBaziRepository);
    expect(await listBaziRecords()).toHaveLength(1);
    __failRemoteForTests(true);
    try {
      await saveBaziRecord({ ...fullRecord(), toneUsed: 42 });
      const again = await listBaziRecords();
      expect(again.find((r) => r.id === ID)?.toneUsed, '没推上去就该留着本机版本').toBe(42);
      const dirty = JSON.parse(localStorage.getItem('mingli.records.probe_a.dirty') ?? '[]') as string[];
      expect(dirty).toContain(ID);
    } finally {
      __failRemoteForTests(false);
    }
  });

  it('导出 .sqlite 再导回来：完整盘原样还原，第二次 dedupe 导入应整条跳过', async () => {
    const [exported] = await exportableRecords();
    const { exportRecordsSQLite } = await import('../data/sqliteExport');
    const bytes = await exportRecordsSQLite([exported]);
    const parsed = await parseBackupFile(bytes, 'mingli-data.sqlite');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].aiTasks?.['task-01']?.analysis).toBeTruthy();
    // 语气档在备份文件里是独立一列(tone_used)，不是搭在某段 JSON 的顺风车里
    expect(parsed.records[0].toneUsed).toBe(55);

    const first = await importRecords(parsed.records, 'dedupe');
    expect(first.updated).toBe(1);
    const again = await importRecords(parsed.records, 'dedupe');
    expect({ ...again }).toEqual({ added: 0, updated: 1, skipped: 0, total: 1 });
    const stored = await listBaziRecords();
    expect(stored).toHaveLength(1);
    expect(await hydrateRecord(stored[0])).toBeTruthy();
  });

  it('老备份文件(没有 tone_used 列)仍要能导入，不能整份失败', async () => {
    const { exportRecordsSQLite } = await import('../data/sqliteExport');
    const modern = await exportRecordsSQLite([fullRecord()]);
    // 用只含旧列的建表语句重造一份「迁移之前导出的文件」
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs({ locateFile: () => './sql-wasm.wasm' });
    const src = new SQL.Database(modern);
    const rows = src.exec('SELECT id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks FROM bazi_records');
    src.close();
    const legacy = new SQL.Database();
    legacy.run('CREATE TABLE bazi_records (id TEXT PRIMARY KEY, name TEXT NOT NULL, gender TEXT NOT NULL, birth_year INTEGER NOT NULL, birth_month INTEGER NOT NULL, created_at TEXT NOT NULL, year_pillar TEXT NOT NULL, month_pillar TEXT NOT NULL, day_pillar TEXT NOT NULL, hour_pillar TEXT NOT NULL, non_ai_result TEXT, ai_status TEXT NOT NULL, ai_analysis TEXT, ai_overview TEXT, ai_error TEXT, ai_tasks TEXT)');
    const ins = legacy.prepare('INSERT INTO bazi_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const v of rows[0].values) ins.run(v);
    ins.free();
    const bytes = legacy.export();
    legacy.close();

    const parsed = await parseBackupFile(bytes, 'legacy.sqlite');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].name).toBe('往返甲');
    expect(parsed.records[0].toneUsed, '老文件没这一列时读成未记录，而不是报错').toBeUndefined();
    const summary = await importRecords(parsed.records, 'overwrite');
    expect(summary.added + summary.updated).toBe(1);
    expect((await getBaziRecord(ID))?.aiTasks?.['task-01']?.analysis).toBeTruthy();
  });

  it('服务器是老库(没有 tone_used 列)时：换设备回读只能退回默认语气，不报错', async () => {
    dropTone = true;   // 从这一刻起，推送上去的落库行不再带语气(老库没这一列)
    await saveBaziRecord({ ...fullRecord(), toneUsed: 33 });
    await until(() => (JSON.parse(store[ID]) as BaziRecord).toneUsed === undefined);
    const remote = JSON.parse(store[ID]) as BaziRecord;
    expect(remote.toneUsed, '老库里这一列根本存不下').toBeUndefined();
    // 同机继续用：本机内存视图里那条还留着 33(推送已发出但服务器落库行没有这一列)，
    // 合并必须按字段把它保住 —— 整条二选一的旧判据在这里会输，因为这条盘没有 AI 任务可比。
    await saveBaziRecord({ ...fullRecord(), aiTasks: undefined, aiAnalysis: undefined, toneUsed: 33 });
    // 推送是「发出去就不管回包」的：等它真的落到服务器(这一列被老库抹掉、任务也确实没了)，
    // 再读列表才谈得上「拿残缺行跟本机这份合并」。
    await until(() => { const r = JSON.parse(store[ID]) as BaziRecord; return r.aiTasks === undefined && r.toneUsed === undefined; });
    expect((await listBaziRecords()).find((r) => r.id === ID)?.toneUsed, '老库回读的残缺行把本机语气抹掉了').toBe(33);
    // 换一台设备(本机为空、只剩服务器那份)：这才是老库真正的代价 —— 语气读不回来，滑杆只能
    // 退回默认档。新库有 tone_used 列时那份落库 JSON 会带着 55/33(见第一个用例)。
    configureBaziRepository(memoryBaziRepository);
    expect((await listBaziRecords()).find((r) => r.id === ID)?.toneUsed).toBeUndefined();
    dropTone = false;
  });
});
