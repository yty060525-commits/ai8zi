import type { BaziRecord, BaziAIAnalysis, BaziAnalysisTask, BaziTaskResult } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';
import { getBrowserCredential } from './aiSettings';

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
  const isBrowser = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);
  if (isBrowser && import.meta.env.MODE !== 'test') return browserDirect(record, task);
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

/** PWA/网页直连 DeepSeek（密钥存本机，适合受信任设备；公开分发请改用后端代理）。 */
async function browserDirect(record: BaziRecord, task?: BaziAnalysisTask): Promise<DeepSeekResult> {
  const secret = getBrowserCredential('deepseek');
  if (!secret) return { status: 'not_configured' };
  const nonAi = record.nonAiResult;
  const natal = {
    pillars: { year: record.yearPillar, month: record.monthPillar, day: record.dayPillar, hour: record.hourPillar },
    dayMaster: nonAi?.dayMaster, zodiac: nonAi?.zodiac, solarDate: nonAi?.solarDate,
    elements: nonAi?.elements, tenGods: nonAi?.tenGods, hiddenStems: nonAi?.hiddenStems, relationships: nonAi?.relationships,
  };
  const scope: Record<string, unknown> = {};
  const y = task?.year;
  if (y !== undefined) {
    scope.age = y - record.birthYear;
    const annual = (nonAi?.annualFortunes ?? []).find((row) => row.year === y);
    if (annual) scope.annual = annual;
    const decade = (nonAi?.greatFortunes ?? []).find((row) => y >= row.startYear && y <= row.endYear);
    if (decade) scope.decade = decade;
    if (task?.month !== undefined) {
      const monthly = task.monthly ?? (nonAi?.monthlyFortunes ?? []).find((row) => row.year === y && row.month === task.month);
      if (monthly) scope.monthly = monthly;
    }
  }
  const when = task ? (task.type === 'annual' ? y + '年' : task.type === 'monthly' ? y + '年' + task.month + '月' : task.type === 'decade' ? '大运' : '本命') : '本命';
  const instruction = '你是资深子平命理师。仅依据下方JSON事实作答，禁止自行推算干支/十神/五行。目标：' + when
    + '。若为年份/月份分析且已有本命结论摘要请沿用。输出JSON仅含 explanation(长文) 以及可选 title；本命输出含 pattern/strength/usefulElements/avoidElements/explanation。不要输出/* */注释或代码块。';
  const content = instruction + '\n\n# 事实数据(JSON)\n' + JSON.stringify({ natal, scope });
  const payload: Record<string, unknown> = { model: 'deepseek-reasoner', max_tokens: 32768, messages: [
    { role: 'system', content: '请把思考压缩到最短，直接输出符合要求的JSON正文。' },
    { role: 'user', content },
  ] };
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret }, body: JSON.stringify(payload) });
    if (!res.ok) return { status: 'failed', error: 'HTTP ' + res.status };
    const body = await res.json();
    const raw = String(body?.choices?.[0]?.message?.content ?? '').trim();
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    const analysis = JSON.parse(cleaned);
    return { status: 'completed', analysis };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'request failed' };
  }
}
