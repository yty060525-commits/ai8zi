import type { ClientRepository, PersonDetailData, Person, BaziRecord } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';
import { apiAdmin, apiRecords, getServerSession, isServerMode } from './serverClient';
import { sqlMirror } from './offlineSql';
import { ELEMENT_RULE_VERSION, countElements } from '../features/chart/elements';
import { analysisHorizon, buildBaziTasks } from './baziOrchestrator';
import type { BaziTaskResult } from '../types/domain';

let sessionPeople: Person[] = [];
let sessionDetails: PersonDetailData[] = [];
let baziRecords: BaziRecord[] = [];
const CAN_PERSIST = typeof localStorage !== 'undefined' && typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window) && import.meta.env.MODE !== 'test';
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 每个账号独立本地命名空间：多账号互不串数据 */
// 未登录时本机数据放这一「共享命名空间」；登录后按账号各开一份。键名只在这里定义一次：
// 它同时决定记录列表、待推送名单和认领逻辑读写的键，抄第二份就会两边对不上。
const SHARED_NS = 'mingli.pwa.records';
const nsKey = (): string => {
  try {
    const s = getServerSession();
    return s ? 'mingli.records.' + s.username : SHARED_NS;
  } catch { return SHARED_NS; }
};
const dirtyKey = () => nsKey() + '.dirty';
/** 登录前离线建的盘，待推送标记落在共享命名空间的那份名单上(登录后由认领逻辑接手)。 */
const sharedDirtyKey = (): string => SHARED_NS + '.dirty';
const readSharedDirty = (): Set<string> => {
  try { const raw = localStorage.getItem(sharedDirtyKey()); return new Set(raw ? (JSON.parse(raw) as string[]) : []); } catch { return new Set(); }
};
const OWNER_KEY = 'mingli.record.owners';
/** 测试专用覆盖：单测里 CAN_PERSIST 为假，归属表(盘→账号名)只活在当前内存视图里，
 *  「上一轮管理员同步引进的盘」到下一轮就没标签了 —— 剔幽灵与跨账号保留这类多轮判据根本没法钉。
 *  指到这里后 rememberOwners/loadOwners 走 localStorage(用例 afterEach 清)，界面不传、行为不变。 */
let ownerKeyOverride: string | null = null;
export function __setOwnerKeyForTests(key: string | null): void { ownerKeyOverride = key; }
const ownerKey = (): string => ownerKeyOverride ?? OWNER_KEY;
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
// 读写都要按当前账号取键：登录前离线建的盘写在共享键上，登录后(reloadLocalForSession →
// adoptUnclaimedLocalRecords)认领进本账号视图，标记也必须跟着挪进本账号命名空间。
// 旧实现只在共享键上增删，于是「这台设备登录之后新加的待推送项」全落在没人读的键里，
// 而认领过来的那批永远留在共享键上 —— 换个账号登录一次，上一账号的待推送名单又被认领一遍。
// 读写都按当前账号取键：登录后新加的待推送项要落在**本账号**命名空间里，补推循环才读得到。
// 曾经这里抄过一份共享键字面量(把标记清到没人读的键上)，storage-key-contract 那条判据钉的就是它。
const markDirty = (id: string) => { const d = readDirty(); d.add(id); writeDirty(d); };
const unmarkDirty = (id: string) => {
  const d = readDirty();
  if (d.delete(id)) writeDirty(d);
  // 认领过来的那条还挂在共享键上：不清掉，下一个在这台设备登录的账号会把它当成自己的积压
  // 再认领一遍(见 adoptUnclaimedLocalRecords)，别人的待推送盘于是成了你的名字。
  try {
    const shared = readSharedDirty();
    if (shared.delete(id)) localStorage.setItem(sharedDirtyKey(), JSON.stringify([...shared]));
  } catch { /* 清不掉只是重复认领一次 */ }
};

/** 尚未上传到服务器的盘(离线新建 / 推送一直失败)。聊天走服务器通道时服务器看不到这些盘，
 *  界面需要据此提示「这条还没同步」，否则用户遇到的是答非所问的「还没有任何命盘」。 */
/** 待推送名单与归属表都是跨调用存着的(localStorage)，视图却会因换页面/换账号而清空：
 *  名单里因此可能留着「这台设备已经没有的盘」(删掉的、或管理员视图里别人的那些)。
 *  留着它们，下一次读取的补推循环就会拿服务器旧行把它们推回去 —— 刚删的盘复活。
 *  只在视图非空时收敛：视图为空正是「刚重启、还没采纳存储」的那一刻，那时名单才是真积压。 */
function reconcileDirty(): void {
  if (!baziRecords.length) return;
  const d = readDirty();
  if (!d.size) return;
  const live = new Set(baziRecords.map((r) => r.id));
  let changed = false;
  for (const id of [...d]) if (!live.has(id)) { d.delete(id); changed = true; }
  if (changed) writeDirty(d);
}

export function unsyncedRecordIds(): string[] {
  // 名单本身写在 localStorage(见 markDirty)，这里那道 CAN_PERSIST 门是给产品的隐私模式兜底的：
  // 存不下就谈不上待推送。单测用 __allowUnsyncedIdsForTests 开门，才能钉住「没推上去的盘要提示」。
  if (!CAN_PERSIST && !unsyncedIdsAllowed) return [];
  const ids = [...readDirty()];
  return serverActive() ? ids.filter((id) => baziRecords.some((r) => r.id === id)) : ids;
}
let unsyncedIdsAllowed = false;
export function __allowUnsyncedIdsForTests(on: boolean): void { unsyncedIdsAllowed = on; }

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
  const sharedKey = SHARED_NS;
  let shared: unknown;
  try { const raw = localStorage.getItem(sharedKey); shared = raw ? JSON.parse(raw) : null; } catch { return; }
  if (!Array.isArray(shared) || shared.length === 0) return;
  const owned = new Set(baziRecords.map((r) => r.id));
  // 只认领**待推送清单里**的那些：不在清单里的盘早已同步过、且属于别的账号(这台设备
  // 登录过的上一个账号留下的副本)。旧实现全部认领并把它们的名字写进本账号库，还把原件从
  // 共享键删掉 —— 换个账号登录一次，别人的盘就成了你的名字。
  const pending = new Set([...readDirty(), ...readSharedDirty()]);
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
  /** 这个端口是否直接以内存视图 baziRecords 当作自己那份数据(内存库是；带本地存储的测试库不是)。
   *  是 ⇒ 它的 saveBaziRecord 已经动过视图，产品代码不能再往视图里塞第二份；
   *  否 ⇒ 它只管存储，视图由产品代码维护(见 saveLocalRecord / persistView)。 */
  mirrorsView?(): boolean;
  /** 用这份数组**整体替换**存储层内容(含跨账号标签的那些)，而不是逐条插入。
   *  实现了它的端口(带本地存储的测试库)才会被 persistView 全量覆盖；没实现的(内存库、
   *  桌面/真设备那条走 persistLocal 的)由视图本身兜着，语义一致。 */
  saveView?(records: BaziRecord[]): Promise<void>;
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
    // 带着别人账号名的条目不进本账号列表：这条端口是「视图即存储」，一旦把别人的盘塞进去，
    // 下一次整体覆盖就把它写进本账号那份存储(桌面 SQLite / localStorage)，重启后它以「自留盘」
    // 的身份回到列表、还会被当成积压 PUT 回别人名下。网页那条端口的存储**按账号分键**，
    // 别人的盘有自己的命名空间；这份库没有那个去处，所以只回克隆、不落地。
    // 判据取条目自带的 username，**不查归属表**：删除一条盘会 forgetOwner(内存库与存储端口两处都是)，
    // 归属表里那笔随之没落 —— 实测：改成 ownerOf(saved)(它先查归属表)之后，删过的 id 再也存不进来，
    // 而「同步引进过、随后又删掉」的 id 本来就该能重新保存(那是用户自己新建的同名盘)。
    if (typeof saved.username === 'string' && saved.username) return structuredClone(saved);
    const index = baziRecords.findIndex((existing) => existing.id === saved.id);
    if (index >= 0) baziRecords[index] = structuredClone(saved);
    else baziRecords.push(structuredClone(saved));
    persistLocal();
    return structuredClone(saved);
  },
  async listBaziRecords() { return structuredClone(baziRecords); },
  async getBaziRecord(id) { const found = baziRecords.find((record) => record.id === id); return found ? structuredClone(found) : undefined; },
  async deleteBaziRecord(id) { baziRecords = baziRecords.filter((record) => record.id !== id); sessionDetails = sessionDetails.filter((detail) => detail.record.id !== id && detail.person.id !== id); sessionPeople = sessionPeople.filter((person) => person.id !== id); persistLocal(); forgetOwner(id); },
  mirrorsView() { return true; },
  // 不提供 saveView：这份库读写的就是 baziRecords 本身，视图即存储。
  resetForTests() { baziRecords = []; sessionDetails = []; sessionPeople = []; },
};

/** 测试专用：带本地存储的库。内存库只活在当前视图里，「刷新一次」这条真实路径在单测里
 *  根本不存在 —— persistLocal 在 MODE==='test' 下不落盘(CAN_PERSIST 为假)，所以上一轮同步
 *  引进的盘、账号归属表与待推送名单都到不了下一轮，多轮同步只能靠浏览器 E2E 验。
 *  这里把持久化补在**端口层**：读写都走 localStorage(用例 afterEach 会清)，同时保留产品代码
 *  那份内存视图语义(fromRemote / mergeRemoteRecords 都要读它)。界面路径永远用不到这个库。 */
export const storageBackedBaziRepository = (storageKey: string, namespacePrefix: string = storageKey + '.'): BaziRepositoryPort => {
  const read = (): BaziRecord[] => {
    try { const raw = localStorage.getItem(storageKey); if (!raw) return []; const list = JSON.parse(raw); return Array.isArray(list) ? list as BaziRecord[] : []; } catch { return []; }
  };
  const write = (list: BaziRecord[]) => { try { localStorage.setItem(storageKey, JSON.stringify(list)); } catch { /* 存不下等于这次没落盘 */ } };
  return {
    async saveBaziRecord(record) {
      const givenId = 'id' in record ? record.id : undefined;
      // 端口层只管「这台设备存了哪些盘」，不认当前会话：视图里躺着谁就存谁(管理员跨账号视图同理)。
      // 把 username 洗成空或抹成本账号名都是**产品代码**的认领动作(见 adoptUnclaimedLocalRecords)，
      // 藏在端口里等于静默改写归属 —— 实测：客户的盘被洗成无标签的本机盘，重启一次就以
      // 「自留盘」的身份回到列表，还会进待推送名单被 PUT 回别人名下。
      const saved = { ...record, id: givenId || crypto.randomUUID() };
      const list = read();
      const index = list.findIndex((existing) => existing.id === saved.id);
      if (index >= 0) list[index] = saved; else list.push(saved);
      write(list);
      // **不回写视图**：这份库的写入方向是「视图 → 存储」。真设备上落一条别人的盘走的是
      // 同一套仓储(saveSqliteRow)，它不会把那条塞进本账号的列表；这里一旦回写，
      // 「只写存储、不动视图」这类语义就没法测了。视图由调用方维护(见 persistView)。
      return structuredClone(saved);
    },
    async listBaziRecords() { return structuredClone(read()); },
    // 整体覆盖：视图就是界面这一轮读到的那份数据，一条都不能少(实测：把别人的盘从存储里剔掉，
    // 下一次读取先采纳存储再合并，跨账号视图当场塌回自己那几条)。属于别人的那些另存到它自己
    // 账号的命名空间(与产品那条 loadLocal 的「每账号一份」同源)，这样重启后本机仍只采纳自己名下
    // 的盘，别人的不会以「无主盘」身份混进来。
    async saveView(records) {
      // 视图里「没人认领」的那些才落在 storageKey 上；带别人账号名的另存到它自己的命名空间。
      for (const r of records) {
        const owner = ownerOf(r);
        if (!owner) continue;
        const k = namespacePrefix + owner;
        try {
          const list: BaziRecord[] = JSON.parse(localStorage.getItem(k) || '[]');
          const i = list.findIndex((x) => x.id === r.id);
          if (i >= 0) list[i] = r; else list.push(r);
          localStorage.setItem(k, JSON.stringify(list));
        } catch { /* 存不下等于这台设备没有别人的副本 */ }
      }
      write(records.filter((r) => !ownerOf(r)));
    },
    async getBaziRecord(id) { const found = read().find((record) => record.id === id); return found ? structuredClone(found) : undefined; },
    async deleteBaziRecord(id) { write(read().filter((record) => record.id !== id)); baziRecords = baziRecords.filter((record) => record.id !== id); forgetOwner(id); },
    // 不提供 mirrorsView：这份库读写 localStorage，视图只是本轮缓存，由产品代码维护。
    resetForTests() { baziRecords = []; try { localStorage.removeItem(storageKey); } catch { /* 忽略 */ } },
  };
};

let baziRepository: BaziRepositoryPort = memoryBaziRepository;
export function configureBaziRepository(repository: BaziRepositoryPort) {
  baziRepository = repository;
  // 换库要连内存视图一起清掉：它跨用例常驻，上一个测试建的盘会混进下一个测试的列表
  // (去重、计数都会莫名其妙对不上)。界面路径全程只装这一个库，不受影响。
  baziRecords = [];
}

/** 视图与存储是两份数据：真设备重启后视图空着，本机那份库(共享命名空间的 localStorage /
 *  SQLite 镜像)才是「这台设备上有哪些盘」的唯一依据(loadLocal / sqlMirror.readAll)。
 *  端口层同样要有这条 adopt：否则一次落盘之后视图被清空(换页面/换账号)，下一轮普通读取
 *  拿服务器清单把存储里那些本机盘一概看不见 —— 删除标记、幽灵判定、待推送补推全都没有参照。
 *  只在视图为空时采纳，避免把本轮同步刚剔掉的盘又捞回来。 */
async function ensureViewLoaded(): Promise<void> {
  if (baziRecords.length || !baziRepository.saveView) return;
  loadOwners();                                  // 归属表是「这条盘是谁的」的第二份依据(存储里那份可能没带标签)
  const me = getServerSession()?.username ?? '';
  let stored: BaziRecord[];
  try { stored = await baziRepository.listBaziRecords(); } catch { return; /* 读不到就当本机没有 */ }
  // 只采纳本账号名下(含无标签的本机新建)那些：这份存储按账号命名，但**管理员全量同步会把别人
  // 的盘也写进来**(界面要在离线时仍看得到全部账号)。视图空着就整份采纳，等于把别人的盘
  // 当成本机自建盘重新引进列表 —— 实测：一次全量同步之后新建一条盘并推送失败，待推送名单里
  // 凭空多出上一轮那些根本不属于本账号的 id。
  const adopt = stored.filter((r) => mineOnDevice(r, me));
  if (adopt.length) baziRecords = structuredClone(adopt);
}

/** 只清单测用的跨用例状态(归属表、「服务器已有 id」名单、最近一轮全量清单)。
 *  这些在真设备上分别存在 localStorage / SQLite 镜像里，换页面也还在；单测里必须显式清，
 *  否则上一个用例引进的标签会让下一个用例凭空多出或少剔几条盘。
 *  **不能**并进 configureBaziRepository：那条会顺带把内存视图清空，而视图正是「本机这份数据」，
 *  界面路径每次装载库都指望它还在。 */
export function __resetSyncStateForTests(): void {
  ownerMap.clear();
  knownRemoteIds.clear();
  adminFullView.clear();
  adminSyncedThisRound.clear();
}

/** 存储瘦身：落库只存“本命要点 + 空占位”，派生数组由确定性内核随时重算。 */
export function pruneRecord(record: BaziRecord): BaziRecord {
  const n = record.nonAiResult;
  if (!n) return record;
  return { ...record, nonAiResult: { ...n, greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } };
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
      // 与 buildBaziTasks 逐字同一条判据(大运段与十年窗口有交集)：界面摆了哪几运 == 哪些槽位必填。
      // 「今天正在走的那一运」也在内 —— 用户要未来十年这段路被大运完整盖住(2026-2033 与 2033-2035 两段都要)，
      // 只摆后一段会让窗口前七年没有大运分析。整段已走完的旧运(endYear 够不到窗口起点)仍剔掉，
      // 那种正文全是过去年份，不该顶「未来大运」的标题。改这里必须同步改那边，否则已跑完的盘
      // 会被判成不完整而每次整轮重算。
      const start = t.decade?.startYear;
      const end = t.decade?.endYear;
      if (typeof start !== 'number') return true;
      const horizon = analysisHorizon(record).year;
      if (typeof end === 'number') return start <= horizon + 9 && end >= horizon;
      return start > horizon;   // 存量任务没带 endYear：退回旧判据，宁可不删也不要把有效结果抹掉
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
  const needs = fixed.filter((record) => isPruned(record.nonAiResult) && canRecompute(record));
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
    return full ? pruneOnRead({ ...record, nonAiResult: full }) : record;
  });
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
const ownerMap = new Map<string, string>();
function rememberOwners(records: BaziRecord[]): void {
  let changed = false;
  for (const r of records) { if (typeof r.username === 'string' && r.username) { if (ownerMap.get(r.id) !== r.username) { ownerMap.set(r.id, r.username); changed = true; } } }
  if (changed && (CAN_PERSIST || ownerKeyOverride)) { try { localStorage.setItem(ownerKey(), JSON.stringify([...ownerMap])); } catch { /* 存不下只是下次少显示几个名字 */ } }
}
function loadOwners(): void {
  if (!(CAN_PERSIST || ownerKeyOverride) || ownerMap.size) return;
  try { const raw = localStorage.getItem(ownerKey()); if (!raw) return; const list = JSON.parse(raw); if (Array.isArray(list)) for (const [id, name] of list) if (typeof id === 'string' && typeof name === 'string') ownerMap.set(id, name); } catch { /* 坏数据当作没有 */ }
}
/** 这条盘的真实所属：视图带着账号名就用它，否则查归属表(只有经管理员全量同步引进的盘会被记下)，
 *  两处都没有才算本机自建。 */
const ownerOf = (r: BaziRecord): string =>
  (typeof r.username === 'string' && r.username) ? r.username : (ownerMap.get(r.id) ?? '');
/** 这条盘是不是记在「本账号名下」：没人认领过(本机自建)或所属就是自己。 */
const mineOnDevice = (r: BaziRecord, myName: string): boolean => {
  const owner = ownerOf(r);
  return !owner || owner === myName;
};
/** 归属表里忘掉这条盘(删除 / 全量清单已无它)。忘掉的只是标签，视图里那条留给调用方处置。 */
function forgetOwner(id: string): void {
  if (!ownerMap.delete(id)) return;
  if (CAN_PERSIST || ownerKeyOverride) { try { localStorage.setItem(ownerKey(), JSON.stringify([...ownerMap])); } catch { /* 存不下只是下次少显示几个名字 */ } }
}
/** 给一条盘补上所属账号名(有名字才加字段，免得本机建的盘多出一个空 username)。 */
function withOwner<T extends BaziRecord>(record: T): T {
  const name = ownerMap.get(record.id);
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
  } catch (e) {
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

/** 把当前内存视图整体落到存储层，让下一次 listBaziRecords 读到的就是这一份。
 *  为什么必须显式做：视图与存储是两份数据 —— 同步拉来的东西不落这一层，下一次读取就用旧的
 *  那份覆盖回视图(实测：管理员全量同步刚把别人的盘引进视图，紧接着一次普通读取只剩自己名下
 *  那几条，界面那句「本列表为服务器全部账号记录」当场塌了)。
 *  **整体覆盖**而不是逐条 upsert：视图里已经删掉的盘必须从存储里一起消失，否则删除只活一轮，
 *  下一次读取它又回到列表(离线删除的盘还会被补推循环当成积压重新推上服务器)。
 *  也绝不走导出的 saveBaziRecord：那条在网页上会顺带把这条推回服务器，而管理员视图里躺着别人
 *  账号的盘 —— server/app.mjs 对 GET/PUT/DELETE 一律放行 admin，逐条走导出路径等于用本机的
 *  视图覆盖别人的数据(实测：一次全量同步发出两条 PUT /records/other)。
 *  只有「视图归产品代码、存储只是这台设备的副本」这类端口(带 saveView)才走到这里；
 *  镜像视图的那条(内存库)与桌面/真设备那条由 persistLocal 写本账号存储，调用方不会让它们落到这。 */
/** 只写存储层，绝不碰视图、也不触发推送。
 *  为什么单独一条：listBaziRecords 里的五行计数回写就是这种「修的是存着的那份，界面这一轮读到的
 *  已经是修好的值」。若它走带视图副作用的那条(saveLocalRecord)，而端口又把记录追加到视图末尾，
 *  下一次整体覆盖就会把这条盘排到别人账号的盘后面 —— 列表顺序当场变(实测)。 */
async function saveToStorage(record: BaziRecord): Promise<void> {
  try { await baziRepository.saveBaziRecord(record); } catch { /* 落不下下次读取重新拉 */ }
}

/** 把一条盘落到本机存储，并让它出现在内存视图里(新建时排在末尾)。
 *  为什么不能只调端口：带存储的那条路径下端口只管存储(见 storageBackedBaziRepository)，视图由
 *  产品代码维护；只写存储的话这条盘「存下来了但这一轮看不见」——实测：新建一条盘、推送又没通，
 *  紧接着读列表就是空的，界面显示「暂无记录」，用户以为数据丢了。
 *  端口自己就读写视图(mirrorsView，内存库那条)时不再 push，否则同一条盘在视图里出现两次。 */
async function saveLocalRecord(record: BaziRecord): Promise<BaziRecord> {
  const stored = await baziRepository.saveBaziRecord(record).catch(() => record);
  if (baziRepository.mirrorsView?.()) return stored;
  const i = baziRecords.findIndex((x) => x.id === record.id);
  if (i >= 0) baziRecords[i] = structuredClone(record); else baziRecords.push(structuredClone(record));
  return stored;
}

async function persistView(): Promise<void> {
  // persistView 里不再判「端口是否镜像视图」：那条判断是死代码 —— 当场取证(在函数入口打印端口形状)
  // 显示整组用例跑下来每次调用都是 sv=function、mv=undefined，产品路径从不会把镜像端口送到这里
  // (内存库那条根本没有 saveView)，删掉它全量照旧全绿。真正拦住跨账号视图整体落盘的是下面这道
  // 「端口没有 saveView 就直接返回」；带账号标签的跨账号视图交给**有** saveView 的端口时，
  // storageBackedBaziRepository 会把别人的盘另存到它自己账号的命名空间(KEY.客户甲)，不写进本账号键。
  // 这条落盘本身必需：漏掉它，上一轮同步引进/剔掉的盘只活在当前内存里，下一次读取先采纳存储再合并，
  // 跨账号视图当场塌回自己那几条(实测：删掉下面那行 saveView 调用，两条用例当场红)。
  persistLocal();
  // saveView 是端口的可选方法：调用方(syncAdminAll / pullAndMergeLocal)确实都只在端口带它时才走到这里，
  // 但类型上看不出来 —— 这里窄化一次即可(实测：把它当死判断整条删掉，tsc 报 TS2722)。
  const saveView = baziRepository.saveView;
  if (!saveView) return;
  try { await saveView(baziRecords); } catch { /* 落不下下次读取重新拉 */ }
}

/** 在途的「保存后推送」(saveBaziRecord 里 void 出去的那条)。测试要判定推送结果就得等得到它。 */
const pendingPushes = new Set<Promise<void>>();
let lastPush: Promise<void> | null = null;
function trackPush(promise: Promise<void>): void {
  pendingPushes.add(promise);
  lastPush = promise;
  void promise.finally(() => pendingPushes.delete(promise));
}

/** 测试专用：等最近一次保存的推送结束(含其前所有在途推送)，用来确定性地判定
 *  「这条到底推上去了没」—— 不 await 的话，同一轮里读待同步名单读到的是还没落地的那一半。 */
export async function flushPendingPushes(): Promise<void> {
  while (pendingPushes.size) {
    const batch = [...pendingPushes];
    pendingPushes.clear();
    await Promise.all(batch);
  }
  if (lastPush) { const p = lastPush; lastPush = null; await p.catch(() => { /* 已由 pushRemote 自己兜住 */ }); }
}

/** 管理员全量视图：把服务器上所有账号的八字拉进本机列表(离线仍可查看)。 */
export async function syncAdminAll(): Promise<void> {
  if (!serverActive() || isTauri) return;
  const session = getServerSession();
  if (session?.role !== 'admin') return;   // 权限门在 try 之外：门后那条路径本来就不该发请求
  try {
    const all = await apiAdmin.listAll();
    // 记下本轮全量清单：普通读取没有「全部账号」这份参照，只能拿它剔幽灵(见 pullAndMergeLocal)。
    adminFullView.set(session.username, new Set(all.map((rr) => rr.id)));
    markKnownRemote(all.map((rr) => rr.id));
    rememberOwners(all);
    // 剔幽灵的参照只能是**管理员全量清单**：普通 /api/records 只回当前账号名下的盘，
    // 别人的盘一律不在里面。旧实现把这件事交给 mergeRemoteRecords(它参照随后 listBaziRecords
    // 拉回的普通清单)，于是「别的账号的盘」在下一轮同步里被当成已删除而剔掉 ——
    // 跨账号视图一次同步就塌回自己那几条，界面上那句「本列表为服务器全部账号记录，含账号名」成了空话。
    // 顺序是「剔 → 写」：applyMerged 会把本轮全量清单里的盘一律补进视图，先写后剔等于
    // 把自己刚引进来的那条马上又剔掉(实测)。名单取剔之前的视图快照，只认带账号标签的那些；
    // dirty 的那几条仍不动，交给 pullAndMergeLocal 补推。
    const remoteNow = new Set(all.map((rr) => rr.id));
    // 归属表先按本轮全量清单瘦身：上一轮被删/改属的那些如果还留着标签，loadOwners 会把它们
    // 从存储里捞回来当成「本视图引进的盘」，幽灵于是杀不干净(实测)。
    for (const id of [...ownerMap.keys()]) if (!remoteNow.has(id)) forgetOwner(id);
    adminSyncedThisRound.add(session.username);
    // 这条负责把「上一轮引进、这一轮全量清单没有」的盘从视图里就地剔掉，并同步忘掉它在
    // adminFullView / knownRemoteIds / 归属表里的痕迹 —— 三处账目只要不一致，下一轮普通读取就会
    // 照着旧清单把它判成「服务器上还有」，点不开的幽灵又回到列表(实测：只清视图不清参照，第三轮复活)。
    dropAbsentFromAdminView(remoteNow, baziRecords.filter((r) => ownerOf(r)).map((r) => r.id));
    const merged = mergeRemoteRecords(all.map((rr) => withOwner(rr)), readDirty());
    // 剔幽灵必须同时落到**合并结果**上：mergeRemoteRecords 会把「本机有、这一轮服务器没返回」的盘
    // 一律保留(那是离线建的盘)，而落盘走整体覆盖 —— 照它写就把幽灵又存回存储层，下一次普通读取
    // 先采纳存储再合并，幽灵原地复活(实测)。视图与存储必须始终同一份。
    const pendingNow = readDirty();
    for (const id of [...merged.keys()]) if (!remoteNow.has(id) && !pendingNow.has(id)) merged.delete(id);
    applyMerged(merged);
    await persistView();
  } catch { /* 断网：继续使用本地 */ }
}

/** 最近一轮管理员全量清单的 id 集合(按账号记，只活在本页面会话里)。
 *  有它 = 这个视图是管理员视图；它同时充当普通读取那一道剔幽灵的参照。 */
const adminFullView = new Map<string, Set<string>>();
/** 「本页面会话里做过管理员全量同步」的账号名。普通读取剔幽灵只认**这一轮**刚拉到的全量清单：
 *  上一轮的清单早就过时了，拿它当参照会把这一轮新引进的盘当成幽灵剔掉(实测)。 */
const adminSyncedThisRound = new Set<string>();

/** 上一轮管理员同步引进、这一轮全量清单里已经没有的盘：被删了或改了归属，
 *  留着就是一条点不开的幽灵记录(详情走 GET /records/<id>，服务器回 403/404)。
 *  「引进过」这份名单由调用方在剔之前从视图上取好传进来(labelledIds)：普通 /api/records
 *  不带 username，只有经管理员同步引进的盘才带标签 —— 本机自建、从没进过全量清单的盘
 *  不在这份名单里，不会被误剔。判据参照的是**管理员全量清单**(remoteIds)，不是普通清单。 */
function dropAbsentFromAdminView(remoteIds: Set<string>, labelledIds: string[]): boolean {
  const labelled = new Set(labelledIds);
  const gone = baziRecords.filter((r) => labelled.has(r.id) && !remoteIds.has(r.id)).map((r) => r.id);
  if (!gone.length) return false;
  const asSet = new Set(gone);
  baziRecords = baziRecords.filter((r) => !asSet.has(r.id));
  for (const id of gone) {
    forgetOwner(id);
    knownRemoteIds.delete(id);
    // 全量快照也要一起忘：普通读取那道闸门比的就是它，留着 id 幽灵下一轮又被判成「服务器上还有」。
    for (const ids of adminFullView.values()) ids.delete(id);
  }
  return true;
}


/** 服务器可连时拉取合并：本机未同步(dirty)的改动优先；结果落本地缓存供离线。 */
async function pullAndMergeLocal(): Promise<void> {
  if (!serverActive() || isTauri) return;
  // 视图空着先采纳本机存储，**而且要在发第一个请求之前做**：真设备上「重启后正好离线」是常态
  // (地铁里、服务器没起)。旧实现把采纳排在 apiRecords.list() 之后，清单一取失败就从 catch 里
  // return，这一轮连一次采纳都没发生 —— 实测：界面显示「暂无记录」，用户以为数据丢了。
  await ensureViewLoaded();
  try {
    reconcileDirty();
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
    // 剔幽灵只做成一半不算做完：syncAdminAll 把它从视图里删掉之后，紧接着 listBaziRecords
    // 还会走这条普通读取 —— 服务器那边只是「这一轮全量清单没返回」，本账号清单里那条旧行还在，
    // mergeRemoteRecords 会照着它把幽灵原样送回视图(实测)。所以这里同口径再剔一次。
    // 判据必须**同时**满足三条，少一条就会误杀本来该留的本机盘：
    //   1) 这个页面会话真做过管理员全量同步(adminFullView) —— 普通用户的视图绝不该这样清；
    //   2) 这条盘是管理员引进的：归属表里有它(ownerMap 由 rememberOwners/loadOwners 填，
    //      只有 /api/admin/records 带 username，本机自建的盘从不写归属)；
    //   3) 本轮**全量清单**里没有它 —— 注意不能用刚拉到的普通清单当参照：那是本账号名下的盘，
    //      别的账号的盘当然不在里面，拿它比会把整个跨账号视图清空(实测)。
    // 待推送名单里的一律不动，留给补推。
    const sessionName = getServerSession()?.username ?? '';
    const currentAdminIds = adminSyncedThisRound.has(sessionName) ? adminFullView.get(sessionName) : null;
    if (currentAdminIds) {
      const dirtyNow = readDirty();
      // 判据两半缺一不可：本轮全量清单没有它 + 它是管理员引进的(归属表记着 或 视图带着账号标签)。
      // 只看标签会漏 —— 普通 /api/records 不带 username，视图里那条标签是 withOwner 按归属表补的，
      // 而归属表可能已被上一轮的瘦身清掉；只看归属表也会漏 —— syncAdminAll 引进时先写视图再记表。
      const ghosts = baziRecords.filter((r) => !currentAdminIds.has(r.id) && !dirtyNow.has(r.id) && ownerOf(r)).map((r) => r.id);
      // 待推送的那些不动：它们是本机新建/离线改过的，服务器还没收到，「全量清单里没有」正是预期。
      if (ghosts.length) {
        const asSet = new Set(ghosts);
        baziRecords = baziRecords.filter((r) => !asSet.has(r.id));
        // 归属表**只忘本轮判成幽灵的那几条**，不跟全量清单对齐：普通 /api/records 只回本账号名下的盘
        // (server/app.mjs 按 username 查)，这份清单没有「全部账号」那份视野 —— 拿它当参照整表瘦身，
        // 会把视图里其他账号的盘的标签一起抹掉，下一次读取它们以「无主本机盘」身份被采纳回来、
        // 还进待推送名单被 PUT 回别人名下。逐条 forgetOwner 才是对的口径(与 syncAdminAll 那条的区别：
        // 那里比的是 /admin/records 的全量清单)。
        for (const id of ghosts) { knownRemoteIds.delete(id); forgetOwner(id); }
        await persistView();
      }
    }
    // 合并**先于**补推：本机这一份可能已经被上一轮拉取换成了服务器那份残缺行(老库连
    // tone_used 列都没有)，而待推送名单里还留着它的 id —— 直接拿视图里的东西去补推，
    // 等于把残缺行原样推回去，用户刚改完的语气当场作废。所以先用「同人同名的本机版」
    // 按字段保住(toKeep)，再推这一份，最后才把它写回视图。
    const dirtyBefore = readDirty();
    const toKeep = mergeRemoteRecords(remoteOwned, dirtyBefore);
    // 同一条判据用在合并结果上：本轮全量清单没有、且归属表里记着(管理员引进过)的那些就是幽灵，
    // 留着它们既会被整体覆盖重新写进存储，也会被补推循环当成待推送项推回服务器。
    // 参照只能是全量清单：普通清单只含本账号名下的盘，别人的盘当然不在里面。
    if (currentAdminIds) for (const id of [...toKeep.keys()]) if (!currentAdminIds.has(id) && !dirtyBefore.has(id)) toKeep.delete(id);
    const myName = sessionName;
    for (const id of [...dirtyBefore]) {
      const record = toKeep.get(id);
      if (!record) { unmarkDirty(id); forgetOwner(id); continue; }
      // 本机已经没有这条盘(离线删除后残留的待推送标记)：绝不能拿服务器上那份旧行去补推，
      // 否则刚删掉的盘会在下一轮读取里复活。mergeRemoteRecords 只看视图，所以这里再确认一次。
      if (!baziRecords.some((x) => x.id === id)) { unmarkDirty(id); forgetOwner(id); continue; }
      // 带别人账号标签的盘不推：admin 的 PUT 对别人的盘同样放行(server/app.mjs 的 owner 判定
      // 含 role==='admin')，补推循环一旦推它就是拿本机的视图覆盖别人的数据。标记留着，
      // 等这条真的归到本账号名下再推。
      if (!mineOnDevice(record, myName)) continue;
      if (await uploadRecord(record)) unmarkDirty(id); // 仍不通则留着标记，下轮再试
    }
    applyMerged(toKeep);
    await persistView();
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
  const stored = await saveLocalRecord(pruneRecord(input));
  const full = await hydrateRecord(stored);
  if (serverActive() || (isTauri && isServerMode())) {
    // 不 await：一次导入/保存可能上百条，逐条等网络往返就是几分钟白屏。
    // 界面随后立刻重读列表也不会丢数据 —— 那一条始终还在内存视图 baziRecords 里，
    // 而拉取合并对「本机那份带 toneUsed / AI 任务、且同人同名」的记录会保留本机版，
    // 不会拿服务器回读的瘦身行反向覆盖它(见 fromRemote)。
    trackPush(pushRemote(full));
  }
  return full;
};
export const listBaziRecords = async (): Promise<BaziRecord[]> => {
  await pullAndMergeLocal();
  // 列表也要校正五行计数：聊天证据直接读列表记录，不走 hydrate(避免为读数拖入历法库)。
  loadOwners();
  // 数据归谁看就向谁读：端口自己镜像视图(mirrorsView，内存库那条)或不管整体落盘(桌面 SQLite、
  // Tauri 那条)时，读的就是端口那份真数据；只有「视图由产品代码维护、存储只是这台设备的副本」
  // 这条路径(storageBackedBaziRepository / 网页 localStorage)才读视图 —— 否则读到的是没带账号
  // 标签的存储副本，实测：管理员同步后刷新一次，客户甲的盘被当成无主盘显示，普通读取那道
  // 剔幽灵闸门也因看不到标签而失效。
  // 两半在现有两条真实端口上恒不等价，别当成冗余删一半：内存库 mirrorsView 为真**且没有** saveView，
  // 两半同时成立；storageBackedBaziRepository 两半同时为假。单删任一半都不会改变这两条端口的读数
  // (实测：各删一半，全量 472 条照旧全绿)，但测试桩与以后新增的端口可以只带其中一项(本文件里
  // 「镜像视图的端口不该被整体落盘」那条装的正是 mirrorsView + saveView 同时成立的桩)，
  // 到那时少一半就把该读端口的路径读成了视图副本。
  const fromPort = baziRepository.mirrorsView?.() === true || !baziRepository.saveView;
  const stored = (fromPort ? await baziRepository.listBaziRecords() : structuredClone(baziRecords)).map(withOwner);
  const repaired = stored.map(repairElementCounts);
  // 校正结果回写一次：否则每次读列表都要重算，且导出/同步出去的仍是旧的错值。
  // 逐条比对，只有真的被改过的才落库；失败不影响返回(内存里已经是对的)。
  const fixes = repaired.filter((record, i) => record !== stored[i]);
  if (fixes.length) {
    try { for (const record of fixes) await saveToStorage(pruneRecord(record)); }
    catch { /* 落库失败只影响下次仍要重算，界面与返回值不受影响 */ }
  }
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