import type { ClientRepository, PersonDetailData, Person, BaziRecord } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';
import { apiAdmin, apiRecords, getServerSession, isServerMode } from './serverClient';
import { sqlMirror } from './offlineSql';

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
const persistLocal = () => {
  if (CAN_PERSIST) {
    try { localStorage.setItem(nsKey(), JSON.stringify(baziRecords)); } catch { /* 满/隐私模式忽略 */ }
    void sqlMirror.saveAll(structuredClone(baziRecords)).catch(() => { /* 镜像写入失败不影响使用 */ });
  }
};
const loadLocal = () => { if (CAN_PERSIST) { try { const raw = localStorage.getItem(nsKey()); if (raw) { const list = JSON.parse(raw); if (Array.isArray(list)) baziRecords = list; } } catch { /* 忽略 */ } } };
const readDirty = (): Set<string> => {
  try { const raw = localStorage.getItem(dirtyKey()); return new Set(raw ? (JSON.parse(raw) as string[]) : []); } catch { return new Set(); }
};
const writeDirty = (ids: Set<string>) => { if (CAN_PERSIST) { try { localStorage.setItem(dirtyKey(), JSON.stringify([...ids])); } catch { /* 忽略 */ } } };

/** 断网编辑会标记 dirty；连上服务器后自动补推。 */
const markDirty = (id: string) => { const d = readDirty(); d.add(id); writeDirty(d); };
const unmarkDirty = (id: string) => { const d = readDirty(); if (d.delete(id)) writeDirty(d); };

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
  if (CAN_PERSIST) { baziRecords = []; loadLocal(); }
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
export async function hydrateRecord(record: BaziRecord): Promise<BaziRecord> {
  const n = record.nonAiResult;
  if (!n || !isPruned(n)) return record;
  const year = Number(record.birthYear);
  const month = Number(record.birthMonth);
  if (!Number.isInteger(year) || !Number.isInteger(month) || record.yearPillar.length !== 2 || record.monthPillar.length !== 2 || record.dayPillar.length !== 2 || record.hourPillar.length !== 2) return record;
  try {
    const { calculateNonAi } = await import('../features/chart/nonAiCalculator');
    const full = calculateNonAi({ birthYear: year, birthMonth: month, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar }, record.gender, record.createdAt || new Date().toISOString());
    return { ...record, nonAiResult: full };
  } catch { return record; }
}

/* ---------------- 服务器同步(默认走服务器；断网自动留本地，联网后自动汇总) ---------------- */
const serverActive = () => isServerMode() && import.meta.env.MODE !== 'test' && typeof window !== 'undefined';
/** 保存成功后推送到服务器(失败则本机保留并标 dirty，稍后自动补推)。 */
async function pushRemote(record: BaziRecord): Promise<void> {
  if (!serverActive()) return;
  try { await apiRecords.upsert(pruneRecord(record)); unmarkDirty(record.id); }
  catch { markDirty(record.id); }
}
/** 管理员全量视图：把服务器上所有账号的八字拉进本机列表(离线仍可查看)。 */
export async function syncAdminAll(): Promise<void> {
  if (!serverActive() || isTauri) return;
  try {
    const session = getServerSession();
    if (session?.role !== 'admin') return;
    const all = await apiAdmin.listAll();
    const dirty = readDirty();
    let changed = false;
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
    const remote = await apiRecords.list();
    const dirty = readDirty();
    let changed = false;
    for (const rr of remote) {
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
  return baziRepository.listBaziRecords();
};
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