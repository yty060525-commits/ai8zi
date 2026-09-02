import type { BaziRecord, BaziAIAnalysis, BaziAnalysisTask, BaziTaskResult } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';

export type DeepSeekResult = { status: 'completed'; analysis: BaziAIAnalysis } | { status: 'not_configured' | 'failed'; error?: string };
type SecureRunner = (record: BaziRecord, task?: BaziAnalysisTask) => Promise<BaziTaskResult>;
let secureRunner: SecureRunner | undefined;
export function configureAiTaskRunner(runner?: SecureRunner): void { secureRunner = runner; }
const toTauriRecord = (record: BaziRecord) => ({ ...record,
  nonAiResult: record.nonAiResult ? JSON.stringify(record.nonAiResult) : undefined,
  aiAnalysis: record.aiAnalysis ? JSON.stringify(record.aiAnalysis) : undefined,
  aiOverview: record.aiOverview ? JSON.stringify(record.aiOverview) : undefined,
  aiTasks: record.aiTasks ? JSON.stringify(record.aiTasks) : undefined,
});

export function buildAiRequestPayload(record: BaziRecord, task?: BaziAnalysisTask) {
  const forecastRange = record.nonAiResult?.forecastRange ?? [];
  const nonAiResult = record.nonAiResult ?? null;
  return {
    model: 'deepseek-chat',
    temperature: 0,
    forecastRange,
    forecastScopes: ['大运', '流年', '流月'], task,
    nonAiResult,
    messages: [{ role: 'user', content: `请仅基于 nonAiResult 中的事实解释格局、身强身弱、喜忌，不要自行计算八字、十神、关系或运势，并返回 JSON（pattern,strength,usefulElements,avoidElements,explanation）。仅生成大运、流年、流月：${forecastRange.join('、')}；不要生成范围外年份。四柱：${record.yearPillar} ${record.monthPillar} ${record.dayPillar} ${record.hourPillar}` }],
  };
}
export async function analyzeTask(record: BaziRecord, task: BaziAnalysisTask): Promise<BaziTaskResult> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try { return await invoke<BaziTaskResult>('run_ai_task', { record: toTauriRecord(record), task }); }
    catch (error) { return { task, status: 'failed', error: error instanceof Error ? error.message : 'request failed' }; }
  }
  if (secureRunner) return secureRunner(record, task);
  return { task, status: 'not_configured' };
}

export async function analyzeBazi(record: BaziRecord, task?: BaziAnalysisTask): Promise<DeepSeekResult> {
  task ??= (record as BaziRecord & { __task?: BaziAnalysisTask }).__task;
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    let result: BaziTaskResult;
    try { result = await invoke<BaziTaskResult>('run_ai_task', { record: toTauriRecord(record), task }); }
    catch (error) { return { status: 'failed', error: error instanceof Error ? error.message : 'request failed' }; }
    if (result.status === 'completed' && result.analysis) return { status: 'completed', analysis: result.analysis };
    return { status: result.status === 'failed' ? 'failed' : 'not_configured', error: result.error };
  }
  if (secureRunner) {
    try { const result = await secureRunner(record, task); return result.status === 'completed' && result.analysis ? { status: 'completed', analysis: result.analysis } : { status: result.status === 'failed' ? 'failed' : 'not_configured', error: result.error }; }
    catch (error) { return { status: 'failed', error: error instanceof Error ? error.message : 'request failed' }; }
  }
  return { status: 'not_configured' };
}
