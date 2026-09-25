import type { ClientRepository, PersonDetailData, Person, BaziRecord } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';
import { apiAdmin, apiRecords, getServerSession, isServerMode } from './serverClient';
import { sqlMirror } from './offlineSql';
import { ELEMENT_RULE_VERSION, countElements } from '../features/chart/elements';
import { DECADE_WINDOW_YEARS, analysisHorizon, buildBaziTasks } from './baziOrchestrator';
import type { BaziTaskResult } from '../types/domain';

let sessionPeople: Person[] = [];
let sessionDetails: PersonDetailData[] = [];
let baziRecords: BaziRecord[] = [];
const CAN_PERSIST = typeof localStorage !== 'undefined' && typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window) && import.meta.env.MODE !== 'test';
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 每个账号独立本地命名空间：多账号互不串数据 */
const nsKey = (): string => {
  try {
    const s = getServerSession();
    return s ? 'mingli.records.' + s.username : 'mingli.pwa.records';
  } catch { return 'mingli.pwa.records'; }
};
const dirtyKey = () => nsKey() + '.dirty';
/** 盘 id → 所属账号名(管理员同步时见到过一次就长期有效，跨设备/跨登录都算数)。 */
const OWNER_KEY = 'mingli.record.owners';
const persistLocal = () => {
  if (CAN_PERSIST) {
    try { localStorage.setItem(nsKey(), JSON.stringify(baziRecords)); } catch { /* 满/隐私模式忽略 */ }
    void sqlMirror.saveAll(structuredClone(baziRecords)).catch(() => { /* 镜像写入失败不影响使用 */ });
  }
};
const loadLocal = () => { if (CAN_PERSIST) { try { const raw = localStorage.getItem(nsKey()); if (raw) { const list = JSON.parse(raw); if (Array.isArray(list)) baziRecords = list; } } catch { /* 忽略 */ } loadOwners(); for (let i = 0; i < baziRecords.length; i++) baziRecords[i] = withOwner(baziRecords[i]); } };
const readDirty = (): Set<string> => {
  try { const raw = localStorage.getItem(dirtyKey()); return new Set(raw ? (JSON.parse(raw) as string[]) : []); } catch { return new Set(); }
};
const writeDirty = (ids: Set<string>) => { try { localStorage.setItem(dirtyKey(), JSON.stringify([...ids])); } catch { /* 满/隐私模式忽略 */ } };

/** 断网编辑会标记 dirty；连上服务器后自动补推。 */
const markDirty = (id: string) => { const d = readDirty(); d.add(id); writeDirty(d); };
const unmarkDirty = (id: string) => { const d = readDirty(); if (d.delete(id)) writeDirty(d); };

/** 尚未上传到服务器的盘(离线新建 / 推送一直失败)。聊天走服务器通道时服务器看不到这些盘，
 *  界面需要据此提示「这条还没同步」，否则用户遇到的是答非所问的「还没有任何命盘」。 */
export function unsyncedRecordIds(): string[] {
  if (!CAN_PERSIST) return [];
  const ids = [...readDirty()];
  return serverActive() ? ids.filter((id) => baziRecords.some((r) => r.id === id)) : ids;
}

export const clientRepository: ClientRepository = {
  listPersons(): Person[] {
    return sessionPeople.map((person) => ({ ...person })).sort((left, right) => left.nameInitial.localeCompare(right.nameInitial) || left.name.localeCompare(right.name));
  },
  getPerson(id: string): PersonDetailData | undefined {
    const detail = sessionDetails.find((item) => item.person.id === id);
    return detail ? structuredClone(detail) : undefined;
  },
};

/** Injects fixture data explicitly from tests; production startup remains empty. */
export function initializeMockSession(people: Person[] = [], details: PersonDetailData[] = []): void {
  sessionPeople = people.map((person) => ({ ...person }));
  sessionDetails = details.map((detail) => structuredClone(detail));
  baziRecords = details.map(({ person, record, aiAnalysis }) => ({
    ...structuredClone(record), id: person.id,
    aiAnalysis: record.aiAnalysis ?? (aiAnalysis.result ? { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: aiAnalysis.result } : undefined),
  }));
}
export function resetMockSession(): void { initializeMockSession(); }

export const listPersons = (): Person[] => clientRepository.listPersons();
export const getPerson = (id: string): PersonDetailData | undefined => clientRepository.getPerson(id);

/** 切换账号/登录状态后调用：清空并载入该账号的本地离线库。 */
export function reloadLocalForSession(): void {
  if (CAN_PERSIST) { baziRecords = []; loadLocal(); adoptUnclaimedLocalRecords(); }
}

/** 本机离线建的盘(存在共享命名空间里、尚未标进当前账号命名空间)在登录后会被
 *  loadLocal 整个替换掉，列表于是显示「暂无记录」—— 数据没丢但用户以为丢了。
 *  这里把这类未上传过的盘补回当前账号视图，并交给 flushDirty 推上服务器。 */
function adoptUnclaimedLocalRecords(): void {
  if (!CAN_PERSIST || !isServerMode()) return;
  const sharedKey = 'mingli.pwa.records';
  let shared: unknown;
  try { const raw = localStorage.getItem(sharedKey); shared = raw ? JSON.parse(raw) : null; } catch { return; }
  if (!Array.isArray(shared) || shared.length === 0) return;
  const owned = new Set(baziRecords.map((r) => r.id));
  // 只认领**待推送清单里**的那些：不在清单里的盘早已同步过、且属于别的账号(这台设备
  // 登录过的上一个账号留下的副本)。旧实现全部认领并把它们的名字写进本账号库，还把原件从
  // 共享键删掉 —— 换个账号登录一次，别人的盘就成了你的名字。
  const pending = readDirty();
  const adopted = (shared as BaziRecord[]).filter((r) => r && typeof r.id === 'string' && !owned.has(r.id) && pending.has(r.id));
  if (!adopted.length) return;
  // adopted 必然来自待推送清单(pending 过滤)，所以这里不用新增 id，只补进本账号视图。
  for (const record of adopted) baziRecords.push(structuredClone(record));
  persistLocal();
  // 已并入账号命名空间的这些盘从共享键移除，避免下次换账号又重复认领一遍。
  try {
    const remaining = (shared as BaziRecord[]).filter((r) => !adopted.some((a) => a.id === r.id));
    if (remaining.length) localStorage.setItem(sharedKey, JSON.stringify(remaining));
    else localStorage.removeItem(sharedKey);
  } catch { /* 清不掉只是多留一份，不影响正确性 */ }
}

export interface BaziRepositoryPort {
  saveBaziRecord(record: Omit<BaziRecord, 'id'> | BaziRecord): Promise<BaziRecord>;
  listBaziRecords(): Promise<BaziRecord[]>;
  getBaziRecord(id: string): Promise<BaziRecord | undefined>;
  deleteBaziRecord(id: string): Promise<void>;
  /** 仅测试用：清空内存库与本地命名空间，保证用例之间不串数据。 */
  resetForTests?(): void;
}

export const memoryBaziRepository: BaziRepositoryPort = {
  async saveBaziRecord(record) {
    // 未指定 id 时按「新建」处理：补一个 UUID。旧实现只认 record.id 在不在，而调用方常传
    // { id: undefined }(表单里还没落地的盘)，于是所有这种盘都存成同一个 undefined 键 ——
    // 第二条直接覆盖第一条，界面/导入结果莫名其妙少一批人。
    const givenId = 'id' in record ? record.id : undefined;
    const saved = { ...record, id: givenId || crypto.randomUUID() };
    const index = baziRecords.findIndex((existing) => existing.id === saved.id);
    if (index >= 0) baziRecords[index] = structuredClone(saved);
    else baziRecords.push(structuredClone(saved));
    persistLocal();
    return structuredClone(saved);
  },
  async listBaziRecords() { return structuredClone(baziRecords); },
  async getBaziRecord(id) { const found = baziRecords.find((record) => record.id === id); return found ? structuredClone(found) : undefined; },
  async deleteBaziRecord(id) { baziRecords = baziRecords.filter((record) => record.id !== id); sessionDetails = sessionDetails.filter((detail) => detail.record.id !== id && detail.person.id !== id); sessionPeople = sessionPeople.filter((person) => person.id !== id); persistLocal(); },
  resetForTests() { baziRecords = []; sessionDetails = []; sessionPeople = []; },
};

let baziRepository: BaziRepositoryPort = memoryBaziRepository;
export function configureBaziRepository(repository: BaziRepositoryPort) {
  baziRepository = repository;
  // 换库要连内存视图一起清掉：它跨用例常驻，上一个测试建的盘会混进下一个测试的列表
  // (去重、计数都会莫名其妙对不上)。界面路径全程只装这一个库，不受影响。
  baziRecords = [];
}

/** 把「未来十年内起运的大运段条数」原样带到瘦身记录上。
 *  进度分母按大运段计槽位，而 greatFortunes 数组在存储里是空的、只有 hydrate（动态导入历法库）才补得回；
 *  记录列表刻意不走 hydrate，于是同一个人在列表看到 2/24、点进详情看到 2/25。这里在唯一拿得到完整数组的
 *  时机把它记下来，列表就能算出与详情页相同的分母。 */
export function stampDecadeSlots(record: BaziRecord): BaziRecord {
  const n = record.nonAiResult;
  if (!n?.greatFortunes?.length) return record;   // 只有真数得出大运段时才落这个数
  const year = analysisHorizon(record).year;      // 与 buildBaziTasks 同一个锚点，别各写一份
  const slots = n.greatFortunes.filter((g) => g.startYear > year && g.startYear <= year + DECADE_WINDOW_YEARS).length;
  if (n.decadeSlots === slots) return record;
  return { ...record, nonAiResult: { ...n, decadeSlots: slots } };
}

/** 存储瘦身：落库只存“本命要点 + 空占位”，派生数组由确定性内核随时重算。 */
export function pruneRecord(record: BaziRecord): BaziRecord {
  const n = record.nonAiResult;
  if (!n) return record;
  const stamped = stampDecadeSlots(record);
  const m = stamped.nonAiResult!;
  return { ...stamped, nonAiResult: { ...m, greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } };
}
function isPruned(nonAi: BaziRecord['nonAiResult']): boolean {
  return !!nonAi && Array.isArray(nonAi.greatFortunes) && nonAi.greatFortunes.length === 0
    && Array.isArray(nonAi.annualFortunes) && nonAi.annualFortunes.length === 0
    && Array.isArray(nonAi.monthlyFortunes) && nonAi.monthlyFortunes.length === 0;
}
/** 存量记录的五行计数按当前唯一口径校正：纯查表、同步、不动任何 AI 结果。
 *  背景：老引擎的地支本气手抄表把「子」写成木，带子的盘 木+1、水-1。 */
export function repairElementCounts(record: BaziRecord): BaziRecord {
  const n = record.nonAiResult;
  if (!n || n.elementRuleVersion === ELEMENT_RULE_VERSION) return record;
  const pillars = [record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar];
  if (!pillars.every((p) => typeof p === 'string' && p.length === 2)) return record;
  const { elements, elementRatio } = countElements(pillars);
  return { ...record, nonAiResult: { ...n, elements, elementRatio, elementRuleVersion: ELEMENT_RULE_VERSION } };
}
/** 存量任务的时段若已不在本轮窗口内(如去年排的大运段、去年的流月)，就不该再顶着一句
 *  「从今天起 · 未来十二个月」摆出多年前的条目。只在带完整排盘数据时做：存储里的 nonAiResult
 *  是瘦身过的(大运/流年数组为空)，拿它判定会把整组④大运误删干净，所以清洗统一放在重算之后。 */
export function pruneStaleTasks(record: BaziRecord): BaziRecord {
  const tasks = record.aiTasks;
  if (!tasks || Object.keys(tasks).length === 0) return record;
  const greatFortunes = record.nonAiResult?.greatFortunes ?? [];
  // 没有完整大运数组就没有判定依据 —— 宁可不删，也不要把有效结果抹掉。
  if (!greatFortunes.length) return record;
  let current: ReturnType<typeof buildBaziTasks>;
  try { current = buildBaziTasks(record); } catch { return record; }
  // 判据用任务自带的时段而不是 taskId：窗口整体前移一年时 task-02 依然是有效槽位，
  // 按 id 保留会把「上一年流年」当成今年的那条留下来。
  const inWindow = (item: BaziTaskResult): boolean => {
    const t = item.task;
    if (t.type === 'annual') return current.some((c) => c.type === 'annual' && c.year === t.year);
    if (t.type === 'monthly') return current.some((c) => c.type === 'monthly' && c.year === t.year && c.month === t.month);
    if (t.type === 'decade') {
      // 「未来大运」只该摆还没走到的运。十年窗口会把「今年刚交出去的上一运」也排进来(它的
      // endYear 差一年才够到窗口起点)，留着它就会被截成「乙酉 大运段(2026-2034)」这种假段，
      // 正文写的还是过去年份。起点晚于窗口起点的下一运保留，由展示层如实标出真实区间。
      // buildBaziTasks 现在用同一条判据排大运任务，所以「界面摆了哪几运」与「哪些槽位必填」
      // 恒等 —— 改这里必须同步改那边，否则已跑完的盘会被判成不完整而每次整轮重算。
      const start = t.decade?.startYear;
      if (typeof start !== 'number') return true;
      return start > analysisHorizon(record).year;
    }
    return true;
  };
  const kept: Record<string, BaziTaskResult> = {};
  let dropped = 0;
  for (const [id, item] of Object.entries(tasks)) {
    if (inWindow(item)) kept[id] = item; else dropped += 1;
  }
  return dropped === 0 ? record : { ...record, aiTasks: kept };
}

/** 清洗入口：判定要带完整排盘数据(见 pruneStaleTasks)，所以只在 hydrate 重算之后调用；
 *  发现过期任务就地回写一次，回写走 pruneRecord(存储本就存瘦身后的派生数组)。 */
function pruneOnRead(record: BaziRecord): BaziRecord {
  const pruned = pruneStaleTasks(record);
  // 返回 Promise 供测试与需要「确认已推上去」的调用方 await；生产路径不关心结果。
  if (pruned !== record) pendingPruneWrites.add(queuePruneWrite(pruned));
  return pruned;
}

const pendingPruneWrites = new Set<Promise<void>>();
/** 同一轮里可能多条记录各自触发清洗：按记录 id 去重，避免同一条重复写库/重复推送。 */
const recentlyPruned = new Set<string>();
async function queuePruneWrite(record: BaziRecord): Promise<void> {
  if (recentlyPruned.has(record.id)) return;
  recentlyPruned.add(record.id);
  // 本地 + 服务器都要收到这一份。导出的 saveBaziRecord 用不了：它会再 hydrate →
  // 再判定过期 → 再回写，自己转圈；而直接调 baziRepository.saveBaziRecord 又只写本机，
  // 服务器上仍留着上一年的时段，换一台设备一同步就「复活」。所以这里复用它的推送半边。
  await baziRepository.saveBaziRecord(pruneRecord(record)).catch(() => { /* 回写失败下次读取再试 */ });
  recentlyPruned.delete(record.id);
  // 推送单独兜住：uploadRecord 内部已 catch，走到这里只是保险
  if (serverActive() || (isTauri && isServerMode())) await pushRemote(record);
}

/** 等出所有在途的清洗回写(含推送)结束 —— 供测试断言，界面路径不需要。 */
export async function flushPendingPruneWrites(): Promise<void> {
  while (pendingPruneWrites.size) {
    const batch = [...pendingPruneWrites];
    pendingPruneWrites.clear();
    await Promise.all(batch);
  }
}

/** 界面读取：存储里的排盘数组是瘦身的，读出来必须重算回完整盘，否则大运/流年那些分组是空的。
 *  与 getBaziRecord 的区别只在起点 —— 这里跳过「服务器拉取合并」那一步(约一次网络往返)，
 *  用于内存视图里已有这一条的场合(详情页操作后刷新、编辑保存)。 */
export async function refreshRecord(record: BaziRecord): Promise<BaziRecord> {
  const stored = await baziRepository.getBaziRecord(record.id);
  return hydrateRecord(stored ?? record);
}

export async function hydrateRecord(record: BaziRecord): Promise<BaziRecord> {
  return (await hydrateRecords([record]))[0];
}

/** 批量还原：历法库只要动态导入一次。 */
async function hydrateRecords(records: BaziRecord[]): Promise<BaziRecord[]> {
  const fixed = records.map(repairElementCounts);
  const needs = fixed.filter((record) => (isPruned(record.nonAiResult) || !hasDecadeStamp(record)) && canRecompute(record));
  if (!needs.length) return fixed;
  let calculateNonAi: typeof import('../features/chart/nonAiCalculator').calculateNonAi;
  try { ({ calculateNonAi } = await import('../features/chart/nonAiCalculator')); } catch { return fixed; }
  // 逐条独立成批：一条算失败(或被历法库抛错打断)不能连累同批其它记录，否则整页都拿不到重算结果。
  const charts = await Promise.all(fixed.map(async (record) => {
    if (!needs.includes(record)) return undefined;
    try {
      const now = new Date();
      const input = { birthYear: Number(record.birthYear), birthMonth: Number(record.birthMonth), birthDay: record.nonAiResult?.birthDay, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar };
      // 引擎按传入时刻排「十年流年 + 每年十二流月」，锚点必须与 buildBaziTasks 同源(analysisHorizon)：
      // 传 createdAt 就等于把窗口钉在建盘那一年，跨年之后任务列表最后一年的流年查不到干支
      // (实测 2025 年建的盘，今年界面上「2035 年流年」整行空掉)。
      const full = calculateNonAi(input, record.gender, now.toISOString());
      // 兜底：万一两端锚点仍不一致(立春前口径差异等)，整组平移对齐。干支年序沿六十甲子连续，
      // 流月干支只由年干+月序决定，平移后逐字相同，不会算错任何东西。
      const anchor = analysisHorizon(record, now).year;
      const baseYear = full.annualFortunes[0]?.year ?? anchor;
      if (baseYear === anchor) return full;
      const offset = anchor - baseYear;
      return {
        ...full,
        forecastRange: full.forecastRange.map((y) => y + offset),
        annualFortunes: full.annualFortunes.map((item) => ({ ...item, year: item.year + offset })),
        monthlyFortunes: full.monthlyFortunes.map((item) => ({ ...item, year: item.year + offset })),
      };
    } catch { return undefined; }
  }));
  return fixed.map((record, i) => {
    const full = charts[i];
    if (!full) return record;
    /* 重算时顺带把大运槽位数补在返回的那份上(老记录没这个数，字段是后加的)。这里**不**自己写库：
       调用方拿到结果后统一决定要不要落库。在读取内部另开一条异步整条覆盖，会把同一次读取刚
       清洗掉的结果冲回去(实测：过期任务又复活了)。 */
    return pruneOnRead(stampDecadeSlots({ ...record, nonAiResult: full }));
  });
}

/** 这条瘦身记录是否已经带着大运槽位数（缺它就算不出与详情页同源的分母）。 */
function hasDecadeStamp(record: BaziRecord): boolean {
  return typeof record.nonAiResult?.decadeSlots === 'number';
}

function canRecompute(record: BaziRecord): boolean {
  const year = Number(record.birthYear);
  const month = Number(record.birthMonth);
  return Number.isInteger(year) && Number.isInteger(month)
    && [record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar].every((p) => typeof p === 'string' && p.length === 2);
}

/* ---------------- 服务器同步(默认走服务器；断网自动留本地，联网后自动汇总) ---------------- */
const serverActive = () => isServerMode() && typeof window !== 'undefined';

/** 服务器上已确认存在的盘 id。本机新建的盘第一次上传要走 POST(PUT 对不存在的 id 回 404)，
 *  之后才用 PUT 覆盖；这份集合只用于决定「该走哪个方法」，不参与界面显示。 */
const knownRemoteIds = new Set<string>();
export function markKnownRemote(ids: Iterable<string>): void { for (const id of ids) knownRemoteIds.add(id); }

/** 测试专用：把「本机有、服务器没有」的盘标成已知，让推送走 PUT(单条覆盖)而不是 POST(建行)。
 *  界面路径由 pullAndMergeLocal 里的 markKnownRemote 自动完成，不需要调用这里。 */
export function __assumeOnServerForTests(ids: Iterable<string>): void { markKnownRemote(ids); }

/** 盘 → 所属账号名。只有 /api/admin/records 会带 username，普通同步拉到的同一盘没有这个
 *  字段，整条覆盖回来就把管理员视图刚写进内存的 username 抹掉了(界面上一句「含账号名」却
 *  一个账号都不显示)。所以单独记一份，并在两条合并路径里回填。 */
const ownerNames = new Map<string, string>();
function rememberOwners(records: BaziRecord[]): void {
  let changed = false;
  for (const r of records) { if (typeof r.username === 'string' && r.username) { if (ownerNames.get(r.id) !== r.username) { ownerNames.set(r.id, r.username); changed = true; } } }
  if (changed && CAN_PERSIST) { try { localStorage.setItem(OWNER_KEY, JSON.stringify([...ownerNames])); } catch { /* 存不下只是下次少显示几个名字 */ } }
}
function loadOwners(): void {
  if (!CAN_PERSIST || ownerNames.size) return;
  try { const raw = localStorage.getItem(OWNER_KEY); if (!raw) return; const list = JSON.parse(raw); if (Array.isArray(list)) for (const [id, name] of list) if (typeof id === 'string' && typeof name === 'string') ownerNames.set(id, name); } catch { /* 坏数据当作没有 */ }
}
/** 给一条盘补上所属账号名(有名字才加字段，免得本机建的盘多出一个空 username)。 */
function withOwner<T extends BaziRecord>(record: T): T {
  const name = ownerNames.get(record.id);
  if (!name || record.username === name) return record;
  return { ...record, username: name };
}

/** 测试专用：让推送服务器失败，用来验证「没推上去的盘标成待同步、下轮补推」。 */
export function __failRemoteForTests(fail: boolean): void { remoteFails = fail; }
let remoteFails = false;

/** 把一条盘推上服务器：成功返回 true(调用方据此清除待推送标记)，失败返回 false。
 *  只发不收：服务器的 PUT/POST 回的是**落库行**(瘦身 + 列名白名单)，既没有 toneUsed，也不带
 *  本轮刚算出的完整派生数组。旧实现把这份回包当返回值交给界面，实测一次保存之后语气档当场
 *  回到默认 80 —— 命盘详情按 toneUsed 判定要不要重跑，于是整盘成果被无声作废。 */
async function uploadRecord(record: BaziRecord): Promise<boolean> {
  const slim = pruneRecord(record);
  try {
    if (remoteFails) throw new Error('测试：模拟服务器不可达');
    // 服务器的 PUT 对不存在的 id 回 404，只有 POST 会建行：本机新建的盘第一次上传走 POST，
    // 之后才用 PUT 覆盖。旧实现一律 PUT，离线建的盘每条都撞 404、永远停在「未同步」。
    if (knownRemoteIds.has(record.id)) await apiRecords.upsert(slim);
    else await apiRecords.create(slim);
    knownRemoteIds.add(record.id);
    return true;
  } catch {
    /* 网络不通/被拒：留着 dirty 标记，下一轮再试 */
    return false;
  }
}

/** 服务器回读的那条永远不比本机新：它只存白名单列 + 瘦身后的时段数组，老库甚至根本没有
 *  tone_used 这一列。同人同名时按字段取「谁有值用谁」，而不是整条二选一 —— 整条二选一必须
 *  先猜哪一侧更全，一旦本机这条恰好没有 AI 任务(从没跑过分析、或任务全被过期清洗掉)，猜错
 *  就把刚保存的语气档/状态抹回服务器那份残缺值(实测：保存后一次重读列表语气当场回到默认)。
 *  不同人(改名或换四柱)仍以服务器为准，否则多设备各建一条同名盘会永远互相看不见。 */
/** 「同一个人」的指纹：性别+四柱+出生年月。导入去重与同步合并共用同一口径 ——
 *  两边判据不一致时，一边认成同人、另一边认成新人，数据就会被无声覆盖。 */
export const fpOf = (r: BaziRecord): string => [r.gender, r.yearPillar, r.monthPillar, r.dayPillar, r.hourPillar, r.birthYear, r.birthMonth].join('|');

const MERGE_KEYS = ['toneUsed', 'aiTasks', 'aiAnalysis', 'aiOverview'] as const;
const fromRemote = (record: BaziRecord, dirty: Set<string>): BaziRecord => {
  const local = baziRecords.find((x) => x.id === record.id);
  if (!local || local === record) return record;
  // 还在待推送名单里 = 那次改动还没推上去，服务器那份必然是旧版，整条沿用本机。
  // 补推就在下一轮做，推的是这一份完整值；中途不能先把它写成残缺行(见 pullAndMergeLocal)。
  if (dirty.has(local.id)) return local;
  if (fpOf(record) !== fpOf(local) || record.name !== local.name) return record;
  // 只有这几样是「本机可能比服务器新」的：AI 正文与语气由用户操作产生，而产生它的同一次保存
  // 必定已把新值推上去(saveBaziRecord 先落库再推送)，所以另一台设备不可能拿着更新的这类数据。
  // 反过来，服务器侧有值的一律以服务器为准 —— 那是别的设备真的算出来/清掉过的。
  // aiStatus 不在其列：清除结果之后它是 not_started 而不是缺字段，只能看服务器。
  let merged: BaziRecord | null = null;
  const target = () => (merged ??= { ...record });
  const source = local as unknown as Record<string, unknown>;
  for (const key of MERGE_KEYS) {
    if (source[key] !== undefined && (record as unknown as Record<string, unknown>)[key] === undefined) {
      (target() as unknown as Record<string, unknown>)[key] = source[key];
    }
  }
  return merged ?? record;
};

/** 保存成功后推送到服务器(失败则本机保留并标 dirty，稍后自动补推)。 */
async function pushRemote(record: BaziRecord): Promise<void> {
  if (!serverActive()) return;
  try {
    if (await uploadRecord(record)) unmarkDirty(record.id);
    else markDirty(record.id); // 推送失败：留待同步标记，下轮补推
  } catch {
    markDirty(record.id);
  }
}

/** 管理员全量视图：把服务器上所有账号的八字拉进本机列表(离线仍可查看)。 */
export async function syncAdminAll(): Promise<void> {
  if (!serverActive() || isTauri) return;
  try {
    const session = getServerSession();
    if (session?.role !== 'admin') return;
    const all = await apiAdmin.listAll();
    markKnownRemote(all.map((rr) => rr.id));
    rememberOwners(all);
    const dirty = readDirty();
    // 先剔掉上一轮管理员同步留下的「别人的盘」：本机没有、这一轮服务器也没返回，
    // 说明它已被删除或改属，留在本地视图里就是一条点不开的幽灵记录。
    // mergeRemoteRecords 只做这件事(远端没有且非 dirty 的一律不留)，写回交给 applyMerged。
    if (applyMerged(mergeRemoteRecords(all.map((rr) => withOwner(rr)), dirty))) persistLocal();
  } catch { /* 断网：继续使用本地 */ }
}


/** 服务器可连时拉取合并：本机未同步(dirty)的改动优先；结果落本地缓存供离线。 */
async function pullAndMergeLocal(): Promise<void> {
  if (!serverActive() || isTauri) return;
  try {
    // 先把积压的待推送项补上去(登录前离线建的盘、上次断网改的盘)，再拉取合并。
    // 否则这些盘只活在当前内存视图里，刷新后列表既看不见也点不开。
    // 先取一次远端清单：既知道哪些盘服务器上已有(决定 POST 还是 PUT)，也避免本轮
    // 把「服务器暂时不可达」误判成「服务器上不存在这条」而反复 POST。
    let remote: BaziRecord[];
    try {
      remote = await apiRecords.list();
    } catch {
      if (!readDirty().size) return; // 没有积压要推的东西，直接沿用本地库
      remote = [];
    }
    markKnownRemote(remote.map((rr) => rr.id));
    // 补推之前**不能**先合并远端：这条盘一旦在推送在途时被别的读取拉过一次清单，
    // 视图里就已经躺著服务器那份残缺行(老库连 tone_used 列都没有)，此时 dirty 名单又已清空，
    // 「整条沿用本机」的护栏也救不了 —— 实测：刚改完语气、一次重读列表语气当场回到默认。
    // 所以先把本机视图里积压的那几条原样推上去，再合并。
    loadOwners();
    // 普通同步拉到的盘不带 username：回填已知的所属账号，否则管理员视图的账号标签会被抹掉。
    const remoteOwned = remote.map(withOwner);
    // 合并**先于**补推：本机这一份可能已经被上一轮拉取换成了服务器那份残缺行(老库连
    // tone_used 列都没有)，而待推送名单里还留着它的 id —— 直接拿视图里的东西去补推，
    // 等于把残缺行原样推回去，用户刚改完的语气当场作废。所以先用「同人同名的本机版」
    // 按字段保住(toKeep)，再推这一份，最后才把它写回视图。
    const dirtyBefore = readDirty();
    const toKeep = mergeRemoteRecords(remoteOwned, dirtyBefore);
    for (const id of [...dirtyBefore]) {
      const record = toKeep.get(id) ?? baziRecords.find((x) => x.id === id);
      if (!record) { unmarkDirty(id); continue; }
      if (await uploadRecord(record)) unmarkDirty(id); // 仍不通则留着标记，下轮再试
    }
    applyMerged(toKeep);
    persistLocal();
  } catch { /* 断网/服务器不可达：直接用本地离线库 */ }
}

/** 把远端清单并进内存视图：返回「合并后每条该是什么样」，由调用方决定何时写回视图。
 *  不直接改 baziRecords 是因为补推要在中间插一步 —— 待推送的那几条得先按合并后的完整值
 *  推上去，才能落回视图(见 pullAndMergeLocal)。 */
function mergeRemoteRecords(remoteOwned: BaziRecord[], dirty: Set<string>): Map<string, BaziRecord> {
  const remoteIds = new Set(remoteOwned.map((rr) => rr.id));
  // 远端列表是**合并**而非替换：本机有、服务器没有的盘(离线建的/未上传成功的)必须留在
  // 内存视图里。之前只增不改，一旦把 baziRecords 换成语义上的「远端集合」，这些盘就从
  // 界面上消失(看不见也点不开)，只剩 localStorage 里一份没人读的副本。
  const merged = new Map<string, BaziRecord>();
  for (const x of baziRecords) if (!remoteIds.has(x.id) || dirty.has(x.id)) merged.set(x.id, x);
  for (const rr of remoteOwned) merged.set(rr.id, fromRemote(rr, dirty));
  return merged;
}

/** 把 mergeRemoteRecords 的结果写回内存视图；返回是否真的动了哪一条。 */
function applyMerged(merged: Map<string, BaziRecord>): boolean {
  let changed = false;
  const next: BaziRecord[] = [];
  for (const x of baziRecords) {
    const keep = merged.get(x.id);
    if (!keep) continue;
    if (JSON.stringify(keep) !== JSON.stringify(x)) changed = true;
    next.push(keep);
  }
  for (const [id, record] of merged) {
    if (baziRecords.some((x) => x.id === id)) continue;
    next.push(record); changed = true;
  }
  if (changed) baziRecords = next;
  return changed;
}

export const saveBaziRecord = async (record: Omit<BaziRecord, 'id' | 'aiStatus'> & Partial<Pick<BaziRecord, 'aiStatus'>> | BaziRecord): Promise<BaziRecord> => {
  // aiStatus 只在「新建」时补默认值。以前每次保存都把它抹成未开始：跑完一轮分析后任何一次
  // 保存(改语气、重算非 AI)都会让状态回退，而任务条目还全部留着已完成 —— 界面就成了
  // 「状态未开始 + 每一段都已生成」。
  const input = { ...record } as BaziRecord;
  if (!input.id || !input.aiStatus) input.aiStatus = 'not_started';
  /* pruneRecord 顺带把大运槽位数记下来了(见 stampDecadeSlots)：那是与排盘同一次的纯计算，不为它多跑一次
     hydrate。上一版在这里又 hydrate 一遍专门补这个数 —— 实测那整段删掉测试仍全绿，因为传完整盘的调用方
     pruneRecord 已经覆盖，传瘦身盘的(存量记录)它也算不出来，那种盘由 listBaziRecords 那条补齐路负责。
     交出去的那份就是存储里那一份(派生数组为空占位)：完整数组不能顺着返回值漏给调用方 —— 实测那样同一次
     保存会有三种厚度(存储 gf=0、详情 gf=9、返回值 gf=9)，任何「比较两次读取」的调用方都判成数据不一致。 */
  const full = await baziRepository.saveBaziRecord(pruneRecord(input));
  if (serverActive() || (isTauri && isServerMode())) {
    // 不 await：一次导入/保存可能上百条，逐条等网络往返就是几分钟白屏。
    // 界面随后立刻重读列表也不会丢数据 —— 那一条始终还在内存视图 baziRecords 里，
    // 而拉取合并对「本机那份带 toneUsed / AI 任务、且同人同名」的记录会保留本机版，
    // 不会拿服务器回读的瘦身行反向覆盖它(见 fromRemote)。
    void pushRemote(full);
  }
  return full;
};
export const listBaziRecords = async (): Promise<BaziRecord[]> => {
  await pullAndMergeLocal();
  // 列表也要校正五行计数：聊天证据直接读列表记录，不走 hydrate(避免为读数拖入历法库)。
  loadOwners();
  const stored = (await baziRepository.listBaziRecords()).map(withOwner);
  /* 存量盘可能缺大运槽位数(见 stampDecadeSlots)，而它只有重算排盘才数得出来 —— 补不出来的话这台
     设备上的分母永远比详情页少一段。所以只对「瘦身 + 没钉过槽位数」的少数几条走一次 hydrate：
     整条列表都拖历法库太贵。hydrateRecords 只算不写，落库统一走下面那条「校正结果回写」——
     在读取内部另开一条异步整条覆盖，会把同一次读取刚清掉的过期任务冲回来(实测)。 */
  const unstamped = stored.filter((record) => isPruned(record.nonAiResult) && !hasDecadeStamp(record));
  const slotsById = new Map<string, number>();
  if (unstamped.length) {
    // 只取那一个数：清洗与落库仍走下面那条统一的「校正结果回写」，不在读取内部另开整条覆盖的写入。
    for (const record of await hydrateRecords(unstamped)) {
      const slots = record.nonAiResult?.decadeSlots;
      if (typeof slots === 'number') slotsById.set(record.id, slots);
    }
  }
  const repaired = stored.map((record) => {
    const fixed = repairElementCounts(record);
    const slots = slotsById.get(record.id);
    return (typeof slots === 'number' && fixed.nonAiResult && typeof fixed.nonAiResult.decadeSlots !== 'number')
      ? { ...fixed, nonAiResult: { ...fixed.nonAiResult, decadeSlots: slots } }
      : fixed;
  });
  // 校正结果回写一次：否则每次读列表都要重算，且导出/同步出去的仍是旧的错值。
  // 逐条比对，只有真的被改过的才落库；失败不影响返回(内存里已经是对的)。
  const fixes = repaired.filter((record, i) => record !== stored[i]);
  try { for (const record of fixes) await baziRepository.saveBaziRecord(pruneRecord(record)); }
  catch { /* 落库失败只影响下次仍要重算，界面与返回值不受影响 */ }
  return repaired;
};
/** 导出用：把瘦身存储还原成完整盘，保证分享出去的 .sqlite/.sql/.json 自解释、可被第三方直接读懂。 */
export async function exportableRecords(): Promise<BaziRecord[]> {
  return await hydrateRecords(await listBaziRecords());
}
export const getBaziRecord = async (id: string): Promise<BaziRecord | undefined> => {
  // 先走列表：它顺带做了服务器拉取合并与账号回填，只在服务器上的那条才不会漏；
  // 过期任务的剔除要等历法库重算出完整大运，放在下面 hydrateRecord 里做。
  const found = (await listBaziRecords()).find((record) => record.id === id);
  return found ? hydrateRecord(found) : undefined;
};
export const deleteBaziRecord = async (id: string): Promise<void> => {
  await baziRepository.deleteBaziRecord(id);
  if (serverActive() || (isTauri && isServerMode())) { try { await apiRecords.remove(id); } catch { /* 离线删除只影响本机 */ } }
};

type TauriBaziRecord = Omit<BaziRecord, 'nonAiResult' | 'aiAnalysis' | 'aiOverview' | 'aiTasks'> & { nonAiResult?: string; aiAnalysis?: string; aiOverview?: string; aiTasks?: string };

const parseTauri = (saved: TauriBaziRecord): BaziRecord => ({ ...saved, nonAiResult: saved.nonAiResult ? JSON.parse(saved.nonAiResult) : undefined, aiAnalysis: saved.aiAnalysis ? JSON.parse(saved.aiAnalysis) : undefined, aiOverview: saved.aiOverview ? JSON.parse(saved.aiOverview) : undefined, aiTasks: saved.aiTasks ? JSON.parse(saved.aiTasks) : undefined });
const tauriBaziRepository: BaziRepositoryPort = {
  async saveBaziRecord(record) {
    const payload = { ...record, nonAiResult: record.nonAiResult ? JSON.stringify(record.nonAiResult) : undefined, aiAnalysis: record.aiAnalysis ? JSON.stringify(record.aiAnalysis) : undefined, aiOverview: record.aiOverview ? JSON.stringify(record.aiOverview) : undefined, aiTasks: record.aiTasks ? JSON.stringify(record.aiTasks) : undefined };
    const saved = await invoke<TauriBaziRecord>('save_bazi_record', { record: payload });
    return parseTauri(saved);
  },
  async listBaziRecords() { const records = await invoke<TauriBaziRecord[]>('list_bazi_records'); return records.map(parseTauri); },
  async getBaziRecord(id) { const record = await invoke<TauriBaziRecord | null>('get_bazi_record', { id }); return record ? parseTauri(record) : undefined; },
  async deleteBaziRecord(id) { await invoke('delete_bazi_record', { id }); },
};

if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) baziRepository = tauriBaziRepository;
else {
  loadLocal();
  // 首次/隐私模式清掉 localStorage 时，从真 SQLite 镜像恢复离线数据
  if (baziRecords.length === 0) {
    void sqlMirror.readAll().then((rows) => { if (rows && baziRecords.length === 0) { baziRecords = rows; persistLocal(); } }).catch(() => {});
  }
}