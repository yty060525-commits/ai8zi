import type { ClientRepository, PersonDetailData, Person, BaziRecord } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';
import { apiAdmin, apiRecords, getServerSession, isServerMode } from './serverClient';
import { sqlMirror } from './offlineSql';
import { ELEMENT_RULE_VERSION, countElements } from '../features/chart/elements';

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
const writeDirty = (ids: Set<string>) => { if (CAN_PERSIST) { try { localStorage.setItem(dirtyKey(), JSON.stringify([...ids])); } catch { /* 忽略 */ } } };

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
}

export const memoryBaziRepository: BaziRepositoryPort = {
  async saveBaziRecord(record) {
    const saved = { ...record, id: 'id' in record ? record.id : crypto.randomUUID() };
    const index = baziRecords.findIndex((existing) => existing.id === saved.id);
    if (index >= 0) baziRecords[index] = structuredClone(saved);
    else baziRecords.push(structuredClone(saved));
    persistLocal();
    return structuredClone(saved);
  },
  async listBaziRecords() { return structuredClone(baziRecords); },
  async getBaziRecord(id) { const found = baziRecords.find((record) => record.id === id); return found ? structuredClone(found) : undefined; },
  async deleteBaziRecord(id) { baziRecords = baziRecords.filter((record) => record.id !== id); sessionDetails = sessionDetails.filter((detail) => detail.record.id !== id && detail.person.id !== id); sessionPeople = sessionPeople.filter((person) => person.id !== id); persistLocal(); },
};

let baziRepository: BaziRepositoryPort = memoryBaziRepository;
export const configureBaziRepository = (repository: BaziRepositoryPort) => { baziRepository = repository; };

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
export async function hydrateRecord(record: BaziRecord): Promise<BaziRecord> {
  const fixed = repairElementCounts(record);
  const n = fixed.nonAiResult;
  if (!n || !isPruned(n)) return fixed;
  const year = Number(record.birthYear);
  const month = Number(record.birthMonth);
  if (!Number.isInteger(year) || !Number.isInteger(month) || ![record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar].every((p) => typeof p === 'string' && p.length === 2)) return fixed;
  try {
    const { calculateNonAi } = await import('../features/chart/nonAiCalculator');
    const full = calculateNonAi({ birthYear: year, birthMonth: month, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar }, record.gender, record.createdAt || new Date().toISOString());
    return { ...record, nonAiResult: full };
  } catch { return fixed; }
}

/* ---------------- 服务器同步(默认走服务器；断网自动留本地，联网后自动汇总) ---------------- */
const serverActive = () => isServerMode() && typeof window !== 'undefined';

/** 服务器上已确认存在的盘 id。本机新建的盘第一次上传要走 POST(PUT 对不存在的 id 回 404)，
 *  之后才用 PUT 覆盖；这份集合只用于决定「该走哪个方法」，不参与界面显示。 */
const knownRemoteIds = new Set<string>();
export function markKnownRemote(ids: Iterable<string>): void { for (const id of ids) knownRemoteIds.add(id); }

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

/** 把一条盘推上服务器：成功返回 true(调用方据此清除待推送标记)，失败返回 false。 */
async function uploadRecord(record: BaziRecord): Promise<boolean> {
  const slim = pruneRecord(record);
  try {
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
/** 保存成功后推送到服务器(失败则本机保留并标 dirty，稍后自动补推)。 */
async function pushRemote(record: BaziRecord): Promise<void> {
  if (!serverActive()) return;
  if (await uploadRecord(record)) unmarkDirty(record.id);
  else markDirty(record.id);
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
    const remoteIds = new Set(all.map((rr) => rr.id));
    const dirty = readDirty();
    let changed = false;
    // 先剔掉上一轮管理员同步留下的「别人的盘」：本机没有、这一轮服务器也没返回，
    // 说明它已被删除或改属，留在本地视图里就是一条点不开的幽灵记录。
    for (let i = baziRecords.length - 1; i >= 0; i--) {
      if (!remoteIds.has(baziRecords[i].id) && !dirty.has(baziRecords[i].id) && baziRecords[i].username) { baziRecords.splice(i, 1); changed = true; }
    }
    for (const rr of all) {
      if (dirty.has(rr.id)) continue;
      const idx = baziRecords.findIndex((x) => x.id === rr.id);
      if (idx >= 0) { if (JSON.stringify(baziRecords[idx]) !== JSON.stringify(rr)) { baziRecords[idx] = rr; changed = true; } }
      else { baziRecords.push(rr); changed = true; }
    }
    if (changed) persistLocal();
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
    loadOwners();
    // 普通同步拉到的盘不带 username：回填已知的所属账号，否则管理员视图的账号标签会被抹掉。
    const remoteOwned = remote.map(withOwner);
    const pending = [...readDirty()];
    for (const id of pending) {
      const record = baziRecords.find((x) => x.id === id);
      if (!record) { unmarkDirty(id); continue; }
      if (await uploadRecord(record)) unmarkDirty(id); // 仍不通则留着标记，下轮再试
    }
    const dirty = readDirty();
    const remoteIds = new Set(remote.map((rr) => rr.id));
    // 远端列表是**合并**而非替换：本机有、服务器没有的盘(离线建的/未上传成功的)必须留在
    // 内存视图里。之前只增不改，一旦把 baziRecords 换成语义上的「远端集合」，这些盘就从
    // 界面上消失(看不见也点不开)，只剩 localStorage 里一份没人读的副本。
    let changed = baziRecords.some((x) => !remoteIds.has(x.id));
    baziRecords = baziRecords.filter((x) => dirty.has(x.id) || !remoteIds.has(x.id));
    for (const rr of remoteOwned) {
      if (dirty.has(rr.id)) continue;
      const idx = baziRecords.findIndex((x) => x.id === rr.id);
      if (idx >= 0) { if (JSON.stringify(baziRecords[idx]) !== JSON.stringify(rr)) { baziRecords[idx] = rr; changed = true; } }
      else { baziRecords.push(rr); changed = true; }
    }
    if (changed) persistLocal();
  } catch { /* 断网/服务器不可达：直接用本地离线库 */ }
}

export const saveBaziRecord = async (record: Omit<BaziRecord, 'id' | 'aiStatus'> & Partial<Pick<BaziRecord, 'aiStatus'>> | BaziRecord): Promise<BaziRecord> => {
  const stored = await baziRepository.saveBaziRecord(pruneRecord({ aiStatus: 'not_started', ...record } as BaziRecord));
  const full = await hydrateRecord(stored);
  if (serverActive() || (isTauri && isServerMode())) void pushRemote(full);
  return full;
};
export const listBaziRecords = async (): Promise<BaziRecord[]> => {
  await pullAndMergeLocal();
  // 列表也要校正五行计数：聊天证据直接读列表记录，不走 hydrate(避免为读数拖入历法库)。
  loadOwners();
  const stored = (await baziRepository.listBaziRecords()).map(withOwner);
  const repaired = stored.map(repairElementCounts);
  // 校正结果回写一次：否则每次读列表都要重算，且导出/同步出去的仍是旧的错值。
  // 逐条比对，只有真的被改过的才落库；失败不影响返回(内存里已经是对的)。
  const fixes = repaired.filter((record, i) => record !== stored[i]);
  if (fixes.length) {
    try { for (const record of fixes) await baziRepository.saveBaziRecord(pruneRecord(record)); }
    catch { /* 落库失败只影响下次仍要重算，界面与返回值不受影响 */ }
  }
  return repaired;
};

/** 导出用：把瘦身存储还原成完整盘，保证分享出去的 .sqlite/.sql/.json 自解释、可被第三方直接读懂。 */
export async function exportableRecords(): Promise<BaziRecord[]> {
  const records = await listBaziRecords();
  return await Promise.all(records.map((record) => hydrateRecord(record)));
}
export const getBaziRecord = async (id: string): Promise<BaziRecord | undefined> => {
  let record = await baziRepository.getBaziRecord(id);
  if (!record && serverActive()) {
    try { const remote = await apiRecords.get(id); record = remote; await baziRepository.saveBaziRecord(record); } catch { /* 离线则无 */ }
  }
  return record ? hydrateRecord(record) : undefined;
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