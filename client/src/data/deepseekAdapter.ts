import type { BaziRecord, BaziAIAnalysis, BaziAnalysisTask, BaziTaskResult } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';
import { getBrowserCredential } from './aiSettings';
import { isServerMode, runTaskOnServer, ServerError } from './serverClient';

export type DeepSeekResult = { status: 'completed'; analysis: BaziAIAnalysis } | { status: 'not_configured' | 'failed'; error?: string };
type SecureRunner = (record: BaziRecord, task?: BaziAnalysisTask, options?: AnalyzeOptions) => Promise<BaziTaskResult>;
let secureRunner: SecureRunner | undefined;
export function configureAiTaskRunner(runner?: SecureRunner): void { secureRunner = runner; }

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const abortResult = (): DeepSeekResult => ({ status: 'failed', error: 'cancelled' });

/** 客户端措辞语气提示(备用直连也遵循滑杆)。 */
export function toneInstructionText(tone: number | undefined): string {
  const t = Number.isFinite(tone) ? Math.max(0, Math.min(100, Math.round(Number(tone)))) : 80;
  if (t >= 90) return '语气：温柔夸夸——先说优点亮点，不足用建议/期待式委婉表达带过，避免直接批评。';
  if (t >= 60) return '语气：温和优先——正面先说多说(约八成)，不足用委婉建设性语言简要点到(约两成)。';
  if (t >= 45) return '语气：中立客观——好坏如实平衡说明。';
  if (t >= 10) return '语气：偏犀利——减少客套，直接点出风险与短板并给出依据。';
  return '语气：犀利直白——明显指出不利与短板，直截了当、有理有据。';
}

/** 桌面(Tauri)本机通道的会话启停；服务器模式下由服务端任务请求自身处理中断。 */
export function beginAiSession(): void { if (inTauri()) void invoke('begin_ai_session'); }
export function cancelAiSession(): void { if (inTauri()) void invoke('cancel_ai_session'); }

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
    model: 'deepseek-chat', temperature: 0, forecastRange, forecastScopes: ['大运', '流年', '流月'], task,
    nonAiResult,
    messages: [{ role: 'user', content: `请仅基于 nonAiResult 中的事实解释格局、身强身弱、喜忌，不要自行计算八字、十神、关系或运势，并返回 JSON（pattern,strength,usefulElements,avoidElements,explanation）。仅生成大运、流年、流月：${forecastRange.join('、')}；不要生成范围外年份。四柱：${record.yearPillar} ${record.monthPillar} ${record.dayPillar} ${record.hourPillar}` }],
  };
}

export async function analyzeTask(record: BaziRecord, task: BaziAnalysisTask, tone?: number): Promise<BaziTaskResult> {
  if (inTauri()) {
    try { return await invoke<BaziTaskResult>('run_ai_task', { record: toTauriRecord(record), task: { ...task, tone: tone } }); }
    catch (error) { return { task, status: 'failed', error: error instanceof Error ? error.message : 'request failed' }; }
  }
  if (secureRunner) return secureRunner(record, task);
  return { task, status: 'not_configured' };
}

export interface AnalyzeOptions { signal?: AbortSignal; tone?: number }

export async function analyzeBazi(record: BaziRecord, task?: BaziAnalysisTask, options: AnalyzeOptions = {}): Promise<DeepSeekResult> {
  task ??= (record as BaziRecord & { __task?: BaziAnalysisTask }).__task;

  // 默认走服务器：设置了服务器且已登录设备时优先
  if (isServerMode() && task) {
    try {
      const r = await runTaskOnServer(record, task, options.tone, options.signal);
      if (r.status === 'completed' && r.analysis) return { status: 'completed', analysis: r.analysis as BaziAIAnalysis };
      if (r.status !== 'completed') return { status: r.status, error: r.error };
      return { status: 'failed', error: 'invalid server reply' };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return abortResult();
      const offline = error instanceof ServerError && error.status === 0;
      if (!offline && error instanceof ServerError) return { status: 'failed', error: error.message };
      // 服务器不可达 → 落到本机备用(见下方本地分支)
    }
  }

  const isBrowser = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);
  if (isBrowser && import.meta.env.MODE !== 'test') return browserDirect(record, task, options);
  if (inTauri()) {
    let result: BaziTaskResult;
    try { result = await invoke<BaziTaskResult>('run_ai_task', { record: toTauriRecord(record), task: { ...task, tone: options?.tone } }); }
    catch (error) { return { status: 'failed', error: error instanceof Error ? error.message : 'request failed' }; }
    if (result.status === 'completed' && result.analysis) return { status: 'completed', analysis: result.analysis };
    return { status: result.status === 'failed' ? 'failed' : 'not_configured', error: result.error };
  }
  if (secureRunner) {
    try { const result = await secureRunner(record, task, options); return result.status === 'completed' && result.analysis ? { status: 'completed', analysis: result.analysis } : { status: result.status === 'failed' ? 'failed' : 'not_configured', error: result.error }; }
    catch (error) { return { status: 'failed', error: error instanceof Error ? error.message : 'request failed' }; }
  }
  return { status: 'not_configured' };
}

/** 本机备用直连(服务器断线/未设置服务器时用，遵守语气滑杆)。 */
export async function browserFallback(record: BaziRecord, task: BaziAnalysisTask | undefined, tone: number | undefined, secret: string, signal?: AbortSignal): Promise<{ ok: boolean } | { ok: false; reason: string }> {
  const result = await browserDirect(record, task, { signal, tone, secret });
  if (result.status === 'completed' && result.analysis) return { ok: true };
  return { ok: false, reason: (result.status === 'failed' || result.status === 'not_configured') ? (result.error || '备用直连失败') : '备用直连失败' };
}

/** PWA/网页直连（密钥本机保存，仅作为无服务器时的备用通道）。 */
async function browserDirect(record: BaziRecord, task?: BaziAnalysisTask, opts: AnalyzeOptions & { secret?: string } = {}): Promise<DeepSeekResult> {
  const secret = opts.secret ?? getBrowserCredential('deepseek');
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
  const isBaseline = !task || task.type === 'baseline';
  const isAdjustment = task?.type === 'adjustment';
  const fiveDimRule = isBaseline
    ? 'explanation 必须以【身强身弱与喜忌】开头，随后按序各出现一次【健康】【事业】【财运】【爱情】(不得合并、省略或改名)。判断身强身弱按四步写明依据：①得令(月支生旺与十二长生)；②得地(四支藏干印比禄刃根基)；③得势(印比出现次数)；④克泄耗(食伤财官杀次数)，权衡后下结论；喜忌按通则：身弱喜印比、忌克泄耗，身强反之。'
    : isAdjustment
      ? 'explanation 必须依次各出现一次【后天调整】【事业适配】【健康注意】(不得合并、省略或改名)。'
      : 'explanation 必须依次各出现一次【健康】【事业】【财运】【爱情】【刑冲克害批注】，顺序一致，不得合并、省略或改名；【刑冲克害批注】依据 annualHits/monthlyHits/decadeHits 逐条编号，每行 数字. 关系（干支实例）：一句影响；无命中时写 1. 本期无重大刑冲克害（仅提示）。';
  const instruction = '你是资深子平命理师。仅依据下方JSON事实作答，禁止自行推算干支/十神/五行。目标：' + when
    + '。若为年份/月份分析且已有本命结论摘要请沿用。' + (isBaseline ? '输出 JSON 含 pattern/strength/usefulElements/avoidElements/explanation。' : '输出 JSON 仅含 explanation 以及可选 title。') + fiveDimRule
    + ' 全篇一律简体中文，禁止繁体字。正文必须分点：每个主题每条单独一行，行首 1. 2. 3. 编号，一句话一条，不要整段连排。' + toneInstructionText(opts.tone)
    + ' 不要输出注释或代码块。';
  const content = instruction + '\n\n# 事实数据(JSON)\n' + JSON.stringify({ natal, scope });
  const payload: Record<string, unknown> = { model: 'deepseek-reasoner', max_tokens: 32768, messages: [
    { role: 'system', content: '请把思考压缩到最短，直接输出符合要求的JSON正文。' },
    { role: 'user', content },
  ] };
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret }, body: JSON.stringify(payload), signal: opts.signal });
    if (!res.ok) return { status: 'failed', error: 'HTTP ' + res.status };
    const body = await res.json();
    const raw = String(body?.choices?.[0]?.message?.content ?? '').trim();
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    const analysis = JSON.parse(cleaned) as BaziAIAnalysis;
    return { status: 'completed', analysis };
  } catch (error) {
    if (opts.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return abortResult();
    return { status: 'failed', error: error instanceof Error ? error.message : 'request failed' };
  }
}
