import type { ClientRepository, PersonDetailData, Person, BaziRecord } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';

let sessionPeople: Person[] = [];
let sessionDetails: PersonDetailData[] = [];
let baziRecords: BaziRecord[] = [];

export const clientRepository: ClientRepository = {
  listPersons(): Person[] {
    return sessionPeople
      .map((person) => ({ ...person }))
      .sort(
        (left, right) => left.nameInitial.localeCompare(right.nameInitial) || left.name.localeCompare(right.name),
      );
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
    ...structuredClone(record),
    id: person.id,
    aiAnalysis: record.aiAnalysis ?? (aiAnalysis.result ? {
      pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: aiAnalysis.result,
    } : undefined),
  }));
}

export function resetMockSession(): void {
  initializeMockSession();
}

export const listPersons = (): Person[] => clientRepository.listPersons();
export const getPerson = (id: string): PersonDetailData | undefined => clientRepository.getPerson(id);

/** Browser implementation used by tests and web preview; Tauri can replace this via configureBaziRepository. */
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
    return structuredClone(saved);
  },
  async listBaziRecords() { return structuredClone(baziRecords); },
  async getBaziRecord(id) { const found = baziRecords.find((record) => record.id === id); return found ? structuredClone(found) : undefined; },
  async deleteBaziRecord(id) { baziRecords = baziRecords.filter((record) => record.id !== id); sessionDetails = sessionDetails.filter((detail) => detail.record.id !== id && detail.person.id !== id); sessionPeople = sessionPeople.filter((person) => person.id !== id); },
};

let baziRepository: BaziRepositoryPort = memoryBaziRepository;
export const configureBaziRepository = (repository: BaziRepositoryPort) => { baziRepository = repository; };
/**
 * 存储瘦身：落库只存“本命要点 + 空占位”，把 ~207KB 的流年/流月/大运派生数组丢弃
 * （这些可由确定性内核在任何时刻即时重算），列表页与 AI 请求不再背 200KB。
 * 打开详情(getBaziRecord)或保存返回时再 hydrate 成完整盘。
 */
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

/** 用四柱+出生信息即时重算完整流年/流月/大运(确定性，与当初完全一致)。引擎按需加载。 */
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
  } catch {
    return record;
  }
}

export const saveBaziRecord = async (record: Omit<BaziRecord, 'id' | 'aiStatus'> & Partial<Pick<BaziRecord, 'aiStatus'>> | BaziRecord): Promise<BaziRecord> => {
  const stored = await baziRepository.saveBaziRecord(pruneRecord({ aiStatus: 'not_started', ...record } as BaziRecord));
  return hydrateRecord(stored);
};
export const listBaziRecords = (): Promise<BaziRecord[]> => baziRepository.listBaziRecords();
export const getBaziRecord = async (id: string): Promise<BaziRecord | undefined> => { const record = await baziRepository.getBaziRecord(id); return record ? hydrateRecord(record) : undefined; };
export const deleteBaziRecord = (id: string): Promise<void> => baziRepository.deleteBaziRecord(id);

type TauriBaziRecord = Omit<BaziRecord, 'nonAiResult' | 'aiAnalysis' | 'aiOverview' | 'aiTasks'> & { nonAiResult?: string; aiAnalysis?: string; aiOverview?: string; aiTasks?: string };

const tauriBaziRepository: BaziRepositoryPort = {
  async saveBaziRecord(record) {
    const payload = { ...record, nonAiResult: record.nonAiResult ? JSON.stringify(record.nonAiResult) : undefined, aiAnalysis: record.aiAnalysis ? JSON.stringify(record.aiAnalysis) : undefined, aiOverview: record.aiOverview ? JSON.stringify(record.aiOverview) : undefined, aiTasks: record.aiTasks ? JSON.stringify(record.aiTasks) : undefined };
    const saved = await invoke<TauriBaziRecord>('save_bazi_record', { record: payload });
    return { ...saved, nonAiResult: saved.nonAiResult ? JSON.parse(saved.nonAiResult) : undefined, aiAnalysis: saved.aiAnalysis ? JSON.parse(saved.aiAnalysis) : undefined, aiOverview: saved.aiOverview ? JSON.parse(saved.aiOverview) : undefined, aiTasks: saved.aiTasks ? JSON.parse(saved.aiTasks) : undefined };
  },
  async listBaziRecords() { const records = await invoke<TauriBaziRecord[]>('list_bazi_records'); return records.map((record) => ({ ...record, nonAiResult: record.nonAiResult ? JSON.parse(record.nonAiResult) : undefined, aiAnalysis: record.aiAnalysis ? JSON.parse(record.aiAnalysis) : undefined, aiOverview: record.aiOverview ? JSON.parse(record.aiOverview) : undefined, aiTasks: record.aiTasks ? JSON.parse(record.aiTasks) : undefined })); },
  async getBaziRecord(id) { const record = await invoke<TauriBaziRecord | null>('get_bazi_record', { id }); return record ? { ...record, nonAiResult: record.nonAiResult ? JSON.parse(record.nonAiResult) : undefined, aiAnalysis: record.aiAnalysis ? JSON.parse(record.aiAnalysis) : undefined, aiOverview: record.aiOverview ? JSON.parse(record.aiOverview) : undefined, aiTasks: record.aiTasks ? JSON.parse(record.aiTasks) : undefined } : undefined; },
  async deleteBaziRecord(id) { await invoke('delete_bazi_record', { id }); },
};

if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) baziRepository = tauriBaziRepository;