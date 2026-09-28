import { invoke } from '@tauri-apps/api/core';
import { listBaziRecords } from './clientRepository';

export interface StorageStats { records: number; cacheEntries: number | null; dbBytes: number; }

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 网页版没有本机数据库：缓存条目数只能等服务器提供统计接口，现在如实报「未知」，
 *  不再摆一个假的 0(看起来像「缓存已空」，实际是根本没查)。 */
export async function getStorageStats(): Promise<StorageStats> {
  if (inTauri()) return invoke<StorageStats>('get_storage_stats');
  return { records: (await listBaziRecords()).length, cacheEntries: null, dbBytes: 0 };
}

export async function compactRecords(): Promise<number> {
  if (inTauri()) {
    const result = await invoke<{ changedRecords: number }>('compact_records');
    return result.changedRecords;
  }
  return 0; // 网页预览/测试环境无持久化，无需压缩
}
export interface AiSelfTest { ok: boolean; provider?: string; model?: string; reply?: string; latencyMs?: number; message?: string; }

/** AI 连通自检：发一次最小请求。网页版没有本机调用通道(密钥在服务器或桌面端)，
 *  这里如实说明并指出该去哪儿测，而不是报一个看起来像故障的「失败」。 */
export async function runAiSelfTest(): Promise<AiSelfTest> {
  if (inTauri()) {
    try {
      return await invoke<AiSelfTest>('ai_self_test');
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, message: '网页版不能在本地做连通自检。要看 AI 是否可用：在任一命盘详情页点「AI 分析」，或在「排盘 → 问问 AI」提一个问题，看它能否答上。' };
}
/** AI 结果缓存清理：网页版的缓存在服务器库里，走服务器的清除接口按盘清除；
 *  桌面版清本机库。返回删除条数。 */
export async function clearChartCache(fields: { gender: string; yearPillar: string; monthPillar: string; dayPillar: string; hourPillar: string }, recordId?: string): Promise<number> {
  if (inTauri()) return invoke<number>('clear_chart_cache', { gender: fields.gender, yearPillar: fields.yearPillar, monthPillar: fields.monthPillar, dayPillar: fields.dayPillar, hourPillar: fields.hourPillar });
  if (!recordId) return 0;
  const { apiRecords } = await import('./serverClient');
  return apiRecords.clearChartCache({ id: recordId });
}
