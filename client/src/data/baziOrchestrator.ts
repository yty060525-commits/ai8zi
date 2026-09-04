import type { BaziAIAnalysis, BaziAnalysisTask, BaziRecord, BaziTaskResult, BaziTaskType } from '../types/domain';
import * as adapter from './deepseekAdapter';
import { chinaYear, chinaYearMonth } from '../utils/date';
import { ELEMENT_GUIDES, primaryElement, type ElementGuide } from './elementKnowledge';
export type TaskRunner = (task: BaziAnalysisTask, payload: { nonAiResult: BaziRecord['nonAiResult']; task: BaziAnalysisTask }) => Promise<BaziTaskResult>;
export interface AiProgress { done: number; total: number; label: string; record: BaziRecord; }
export type ProgressFn = (progress: AiProgress) => void | Promise<void>;

export const ABORTED_MESSAGE = '已停止：已完成的任务已保存，可随时点“AI 分析”继续完成剩余任务';
export interface OrchestrateOptions {
  /** 外部可中止整个分析会话(点“停止”时触发) */
  signal?: AbortSignal;
  /** 单个任务自动重试次数上限(不含第一次尝试)，失败会自动重新分析 */
  retries?: number;
  /** 重试间隔；测试环境自动为 0 */
  retryDelayMs?: number;
  /** 语气档(0 犀利 .. 50 中立 .. 100 温柔夸夸)，默认 80 */
  tone?: number;
}

const isTest = typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test';
const DEFAULT_RETRY_DELAY_MS = 900;
export const DEFAULT_TONE = 80;   // 检测到失败后尽快重发(太短易被限流，900ms 合适)
const REPAIR_WAIT_MS = 2500;          // 整批跑完后的自动补跑等待
const REPAIR_RETRIES = 1;             // 补跑轮内每个任务再自动重试的次数
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** 判定某条错误是否值得自动重试(密钥类/权限类重试也是白费) */
export const isRetryableFailure = (error: string | undefined): boolean => {
  if (!error) return false;
  if (/not_configured|未配置|credential|keyring/i.test(error)) return false;
  if (/HTTP 40[0-9]|HTTP 404/i.test(error)) return false;
  return true;
};

/** 每个任务类型硬性要求出现的【小节】。模型输出缺段时自动重写一次(与提示词“输出硬性要求”呼应)。 */
export const REQUIRED_SECTIONS: Record<string, string[]> = {
  baseline: ['身强身弱与喜忌', '健康', '事业', '财运', '爱情'],
  annual: ['健康', '事业', '财运', '爱情', '刑冲克害批注'],
  monthly: ['健康', '事业', '财运', '爱情', '刑冲克害批注'],
  decade: ['健康', '事业', '财运', '爱情', '刑冲克害批注'],
  adjustment: ['后天调整', '事业适配', '健康注意'],
};

export interface ConcurrencyProfile { min: number; max: number; cooldownMs?: number; rampAfter?: number }
/**
 * 波动并发(按“内容相似度”成组，而不是无差别全开)：
 * 同组任务的正文高度相似(同一命盘、只换一个 scope 行)，可放心一起并发；
 * 组与组(本命/年+月/大运/后天调整/补跑)之间仍串行，避免瞬时把差异很大的请求全砸给上游。
 * 每个组以 max 拉满起步；若出现限流/超时类失败则自动减半并冷却，之后连续成功再逐步回升。
 */
export const CONCURRENCY_PROFILES = {
  scope: { min: 2, max: 8 },
  decade: { min: 1, max: 4 },
  repair: { min: 2, max: 6 },
} satisfies Record<string, ConcurrencyProfile>;

const THROTTLE_RE = /429|rate\s*limit|限流|HTTP\s*5\d\d|timeout|timed out|network|econn|超时/i;
export const isThrottleFailure = (error?: string): boolean => !!error && THROTTLE_RE.test(error);

async function adaptiveMap<T>(items: T[], profile: ConcurrencyProfile, worker: (item: T) => Promise<{ status?: string; error?: string } | void>): Promise<void> {
  const queue = [...items];
  let limit = Math.min(profile.max, Math.max(profile.min, queue.length || profile.min));
  let running = 0;
  let cooledUntil = 0;
  let okRun = 0;
  let settled = false;
  let abortReason: unknown = null;
  const rampAfter = profile.rampAfter ?? 3;
  const cooldownMs = profile.cooldownMs ?? 2500;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { if (!settled) { settled = true; if (abortReason) reject(abortReason); else resolve(); } };
    const pump = () => {
      while (!settled && running < limit && queue.length > 0) {
        const item = queue.shift()!;
        running += 1;
        void (async () => {
          let outcome: { status?: string; error?: string } | void = undefined;
          try { outcome = await worker(item); }
          catch (error) { abortReason = abortReason ?? error; outcome = undefined; }
          finally {
            running -= 1;
            const now = Date.now();
            const throttled = !!outcome && outcome.status === 'failed' && isThrottleFailure(outcome.error);
            if (throttled) {
              okRun = 0;
              if (now >= cooledUntil) { cooledUntil = now + cooldownMs; limit = Math.max(profile.min, Math.ceil(limit / 2)); }
            } else if (now >= cooledUntil) {
              okRun += 1;
              if (okRun >= rampAfter && limit < profile.max) { limit += 1; okRun = 0; }
            }
            pump();
            if (running === 0) finish();
          }
        })();
      }
      if (running === 0 && queue.length === 0) finish();
    };
    pump();
  });
}

const taskLabel = (task: BaziAnalysisTask): string => {
  if (task.type === 'baseline') return '本命命局分析';
  if (task.type === 'annual') return task.year !== undefined ? task.year + ' 年流年' : '流年';
  if (task.type === 'monthly') return task.year !== undefined && task.month !== undefined ? task.year + ' 年 ' + task.month + ' 月' : '流月';
  if (task.type === 'decade') return task.year !== undefined ? '大运段 ' + task.year : '大运段';
  if (task.type === 'adjustment') return '后天调整与职业适配(按喜用五行)';
  return '任务';
};

/** 把模型返回消毒成稳定结构，缺字段一律给默认值，防止渲染崩溃。 */
// 清理模型输出中夹带的草稿/注释/代码块(如 /* ... */、<!-- -->、```围栏)。
export function stripMarkers(value: string): string {
  let text = value;
  text = build('/*', '*/', text);
  text = build('<!--', '-->', text);
  text = build('```', '```', text);
  return text.trim();
  function build(open: string, close: string, src: string): string {
    let out = src;
    for (;;) { const a = out.indexOf(open); if (a < 0) break; const b = out.indexOf(close, a + open.length); out = b < 0 ? out.slice(0, a) : out.slice(0, a) + out.slice(b + close.length); }
    return out;
  }
}

export function sanitizeAnalysis(raw: BaziAIAnalysis | undefined): BaziAIAnalysis {
  const asString = (v: unknown) => (typeof v === 'string' ? stripMarkers(v) : '');
  const asStringArray = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const optional = (key: 'overall' | 'health' | 'career' | 'wealth' | 'love' | 'notice' | 'title') => (raw && asString(raw[key])) ? { [key]: asString(raw[key]) } : {};
  return {
    pattern: asString(raw && raw.pattern),
    strength: asString(raw && raw.strength),
    usefulElements: asStringArray(raw && raw.usefulElements),
    avoidElements: asStringArray(raw && raw.avoidElements),
    explanation: asString(raw && raw.explanation),
    ...optional('overall'), ...optional('health'), ...optional('career'), ...optional('wealth'), ...optional('love'), ...optional('notice'), ...optional('title'),
  };
}
export function buildBaziTasks(record: BaziRecord): BaziAnalysisTask[] {
  const annual = record.nonAiResult?.annualFortunes ?? [];
  const year = chinaYear(record.createdAt);
  const { year: startYear, month: startMonth } = chinaYearMonth(record.createdAt);
  const years = Array.from({ length: 10 }, (_, i) => year + i);
  const core: BaziAnalysisTask[] = [
    { taskId: 'task-01', type: 'baseline' },
    ...years.map((item, i) => ({ taskId: `task-${String(i + 2).padStart(2, '0')}`, type: 'annual' as const, year: item, annual: annual.find((entry) => entry.year === item) })),
    // 未来十二个月：今天所在公历月起连续 12 个公历月
    ...Array.from({ length: 12 }, (_, i) => {
      const offset = startMonth - 1 + i;
      const y = startYear + Math.floor(offset / 12);
      const m = (offset % 12) + 1;
      return { taskId: `task-${String(i + 12).padStart(2, '0')}`, type: 'monthly' as const, year: y, month: m } as BaziAnalysisTask;
    }),
  ];
  // 大运分析：只排未来十年(含当前)所落入的大运段
  const greatFortunes = record.nonAiResult?.greatFortunes ?? [];
  const decadeTasks: BaziAnalysisTask[] = greatFortunes
    .filter((g) => g.startYear <= year + 9 && g.endYear >= year)
    .map((g, i) => ({ taskId: `task-${String(i + 24).padStart(2, '0')}`, type: 'decade' as const, year: g.startYear }));
  return [...core, ...decadeTasks];
}

const makeDefaultRunner = (record: BaziRecord, signal?: AbortSignal, tone?: number): TaskRunner => async (task) => {
  const result = await adapter.analyzeBazi(record, task, { signal, tone });
  return { task, status: result.status, analysis: 'analysis' in result ? result.analysis : undefined, error: 'error' in result ? result.error : undefined };
};

export async function orchestrateBaziAnalysis(record: BaziRecord, runner?: TaskRunner, onProgress?: ProgressFn, options: OrchestrateOptions = {}): Promise<BaziRecord> {
  const { signal, retries = 1 } = options;
  const retryDelayMs = options.retryDelayMs ?? (isTest ? 0 : DEFAULT_RETRY_DELAY_MS);
  const actualRunner: TaskRunner = runner ?? makeDefaultRunner(record, signal, options?.tone);
  const tasks = buildBaziTasks(record);
  // 滚动十二个月的 干支月/关系 需要历法引擎：在需要时才加载(不占首屏)
  const { singleCalendarMonth } = await import('../features/chart/nonAiCalculator');
  const total = tasks.length;
  const aiTasks = { ...(record.aiTasks ?? {}) };
  let done = 0;
  const ensureLive = () => { if (signal?.aborted) { const error = new Error(ABORTED_MESSAGE); (error as Error & { aborted?: boolean }).aborted = true; throw error; } };
  const snapshot = () => ({ ...record, aiTasks, aiStatus: 'pending' as const });

  const abortError = () => { const error = new Error(ABORTED_MESSAGE); (error as Error & { aborted?: boolean }).aborted = true; return error; };
  /** 单次调用（失败会带错误文本返回，而不是抛出）。点“停止”后立即以 abort 拒绝，不等网络请求返回。 */
  const attemptOnce = async (task: BaziAnalysisTask): Promise<BaziTaskResult> => {
    // 月度任务补上“该公历月”的干支/关系数据行(供后端最小上下文使用)
    if (task.type === 'monthly' && task.year !== undefined && task.month !== undefined && !task.monthly) {
      task.monthly = singleCalendarMonth({ birthYear: record.birthYear, birthMonth: record.birthMonth, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar }, task.year, task.month);
    }
    const settle: Promise<BaziTaskResult> = (async () => {
      try { return await actualRunner(task, { nonAiResult: record.nonAiResult, task }); }
      catch (error) { return { task, status: 'failed' as const, error: error instanceof Error ? error.message : 'request failed' }; }
    })();
    if (!signal) return settle;
    if (signal.aborted) throw abortError();
    return await new Promise<BaziTaskResult>((resolve, reject) => {
      let done = false;
      const onAbort = () => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); reject(abortError()); } };
      signal.addEventListener('abort', onAbort, { once: true });
      settle.then(
        (result) => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); resolve(result); } },
        (error: unknown) => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); reject(error instanceof Error ? error : new Error(String(error))); } },
      );
    });
  };

  // 进度落库串行化：并发完成时按顺序排队保存，避免“后写覆盖早写”导致丢任务(共享 aiTasks 每步只增不减)
  let progressTail: Promise<unknown> = Promise.resolve();
  const emitProgress = (progress: AiProgress): Promise<void> => {
    const run = progressTail.then(() => onProgress?.(progress));
    progressTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const sanitizeCompleted = (result: BaziTaskResult): BaziTaskResult => result.status === 'completed' && result.analysis
    ? { ...result, analysis: sanitizeAnalysis(result.analysis) } : result;
  const missingOf = (taskType: string, result: BaziTaskResult): string[] => {
    const required = REQUIRED_SECTIONS[taskType];
    const text = result.analysis ? (result.analysis.explanation || '') : '';
    if (!required || !result.analysis) return [];
    // 无任何【】小节的旧式散文输出无法校验结构(与复制兜底一致)，交给提示词约束；带小节却缺段才重试
    if (!/【[^】]{1,16}】/.test(text)) return [];
    return required.filter((name) => !text.includes('【' + name + '】'));
  };

  const step = async (task: BaziAnalysisTask): Promise<BaziTaskResult> => {
    ensureLive();
    const prev = aiTasks[task.taskId];
    // 历史脏结果(completed 但无正文)必须重跑
    const reusable = prev?.status === 'completed' && !!prev.analysis && (!!prev.analysis.explanation || !!prev.analysis.pattern);
    if (reusable) {
      done += 1;
      const progress: AiProgress = { done, total: tasks.length, label: taskLabel(task), record: snapshot() };
      await emitProgress(progress);
      return prev;
    }
    // 自动重新分析：失败或缺【小节】(五个维度不齐)都会自动再试，用完 options.retries 的额外次数为止
    let result: BaziTaskResult = sanitizeCompleted(await attemptOnce(task));
    let attempt = 0;
    while (attempt < retries) {
      const missing = result.status === 'completed' ? missingOf(task.type, result) : [];
      const retryable = result.status === 'failed' && isRetryableFailure(result.error);
      if (!retryable && missing.length === 0) break;
      ensureLive();
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      attempt += 1;
      result = sanitizeCompleted(await attemptOnce(task));
    }
    ensureLive(); // 若停止发生在最后一次请求收尾阶段，丢弃该结果(不落库)
    aiTasks[task.taskId] = result;
    done += 1;
    const progress: AiProgress = { done, total: tasks.length, label: taskLabel(task), record: snapshot() };
    await emitProgress(progress);
    return result;
  };

  const pick = (type: BaziTaskType) => tasks.filter((task) => task.type === type);
  const baselineResult = await step(pick('baseline')[0]);
  // 本命喜用确定后：追加一次“后天调整与职业适配”(按喜用五行取资料库) —— 只算一次
  const favorite = baselineResult.status === 'completed' ? primaryElement(baselineResult.analysis?.usefulElements) : undefined;
  // 本命结论摘要注入每个时段任务作锚点，防止模型自推/乱说
  const analysis = baselineResult.analysis;
  if (baselineResult.status === 'completed' && analysis) {
    const summary = '格局：' + (analysis.pattern || '—') + ' · 强弱：' + (analysis.strength || '—')
      + '　喜：' + (analysis.usefulElements ?? []).join('、') + '　忌：' + (analysis.avoidElements ?? []).join('、');
    for (const task of tasks) {
      if (task.type === 'annual' || task.type === 'monthly' || task.type === 'decade') task.baseline = { summary } as never;
    }
  }
  await adaptiveMap([...pick('annual'), ...pick('monthly')], CONCURRENCY_PROFILES.scope, step);
  await adaptiveMap(pick('decade'), CONCURRENCY_PROFILES.decade, step);
  // 工作/生活/职业知识：最后才上传(等大运流年流月都分析完，避免上下文污染)
  if (favorite && baselineResult.status === 'completed') {
    const guide: ElementGuide = ELEMENT_GUIDES[favorite];
    tasks.push({
      taskId: 'task-30', type: 'adjustment',
      baseline: baselineResult,
      guide: { element: guide.element, lifestyle: guide.lifestyle, career: guide.career, health: guide.health },
    });
    await adaptiveMap(tasks.filter((t) => t.type === 'adjustment'), { min: 1, max: 1 }, step);
  }
  ensureLive();
  // 整批跑完后自动“补跑一轮”：把仍然失败(且属于可重试因素)的任务再调一次 AI，
  // 不直接让失败停在界面上 —— 只有多轮都失败才在最后如实展示。
  const stillFailed = tasks.filter((task) => {
    const item = aiTasks[task.taskId];
    return item?.status === 'failed' && isRetryableFailure(item.error);
  });
  if (stillFailed.length > 0 && !signal?.aborted) {
    const waitMs = isTest ? 0 : REPAIR_WAIT_MS;
    if (waitMs > 0) await sleep(waitMs);
    if (!signal?.aborted) await onProgress?.({ done, total: tasks.length, label: '自动重试失败任务(' + stillFailed.length + ')…', record: snapshot() });
    const repairStep = async (task: BaziAnalysisTask): Promise<BaziTaskResult> => {
      ensureLive();
      const sanitizeDone = (r: BaziTaskResult): BaziTaskResult => r.status === 'completed' && r.analysis ? { ...r, analysis: sanitizeAnalysis(r.analysis) } : r;
      const missingOfType = (r: BaziTaskResult): string[] => { const required = REQUIRED_SECTIONS[task.type]; const text = r.analysis ? (r.analysis.explanation || '') : ''; if (!required || !r.analysis) return []; if (!/【[^】]{1,16}】/.test(text)) return []; return required.filter((name) => !text.includes('【' + name + '】')); };
      let result: BaziTaskResult = sanitizeDone(await attemptOnce(task));
      let attempt = 0;
      while (attempt < REPAIR_RETRIES) {
        const missing = result.status === 'completed' ? missingOfType(result) : [];
        const retryable = result.status === 'failed' && isRetryableFailure(result.error);
        if (!retryable && missing.length === 0) break;
        if (retryDelayMs > 0) await sleep(retryDelayMs);
        attempt += 1;
        result = sanitizeDone(await attemptOnce(task));
      }
      ensureLive();
      aiTasks[task.taskId] = result;
      return result;
    };
    await adaptiveMap(stillFailed, CONCURRENCY_PROFILES.repair, repairStep);
    ensureLive();
  }
  const statuses = Object.values(aiTasks).map((item) => item.status);
  const failedTask = Object.values(aiTasks).find((item) => item.status === 'failed');
  const notConfigured = Object.values(aiTasks).find((item) => item.status === 'not_configured');
  return {
    ...record,
    aiTasks,
    aiAnalysis: aiTasks['task-01']?.analysis ? sanitizeAnalysis(aiTasks['task-01']?.analysis) : undefined,
    aiOverview: undefined,
    aiStatus: statuses.includes('failed') ? 'failed' : statuses.includes('not_configured') ? 'not_configured' : 'completed',
    aiError: failedTask?.error ?? (notConfigured ? '未配置 AI 服务' : undefined),
  };
}