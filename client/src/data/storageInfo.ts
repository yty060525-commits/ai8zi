import { invoke } from '@tauri-apps/api/core';
import { listBaziRecords } from './clientRepository';

export interface StorageStats { records: number; cacheEntries: number; dbBytes: number; }

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function getStorageStats(): Promise<StorageStats> {
  if (inTauri()) return invoke<StorageStats>('get_storage_stats');
  const records = (await listBaziRecords()).length;
  return { records, cacheEntries: 0, dbBytes: 0 };
}

export async function compactRecords(): Promise<number> {
  if (inTauri()) {
    const result = await invoke<{ changedRecords: number }>('compact_records');
    return result.changedRecords;
  }
  return 0; // 网页预览/测试环境无持久化，无需压缩
}
export interface AiSelfTest { ok: boolean; provider?: string; model?: string; reply?: string; latencyMs?: number; message?: string; }

/** 连通性自检：几乎零成本的最小请求。网页预览模式返回不可用。 */
export async function runAiSelfTest(): Promise<AiSelfTest> {
  if (!inTauri()) return { ok: false, message: '网页预览模式无法调用 AI，请在桌面版设置中自检' };
  try {
    return await invoke<AiSelfTest>('ai_self_test');
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
/** 清除该命盘(性别+四柱)的所有命中缓存条目：删除后下一次 AI 分析会重新调用(只清除，不自动重算)。 */
export async function clearChartCache(fields: { gender: string; yearPillar: string; monthPillar: string; dayPillar: string; hourPillar: string }): Promise<number> {
  if (!inTauri()) return 0;
  return invoke<number>('clear_chart_cache', { gender: fields.gender, yearPillar: fields.yearPillar, monthPillar: fields.monthPillar, dayPillar: fields.dayPillar, hourPillar: fields.hourPillar });
}
