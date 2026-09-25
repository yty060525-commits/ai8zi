import type { AiFindings, BaziAIAnalysis, BaziAnalysisTask, BaziRecord, BaziTaskResult, BaziTaskType } from '../types/domain';
import * as adapter from './deepseekAdapter';
import { chinaYearMonth } from '../utils/date';
import { ELEMENT_GUIDES, primaryElement, type ElementGuide } from './elementKnowledge';
import { sanitizeAnalysisText } from '../features/chart/elements';
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
  /** 窗口起点时刻(默认今天)；只有测试与预建盘需要固定它。 */
  now?: Date;
  /** 本地离线（第四路）：为真时若未显式传入 runner，改用本地规则引擎产出各篇正文，
   *  结果照常写进 record.aiTasks 并打 source='local'。绝不触网、不耗额度。 */
  local?: boolean;
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
  // 本地引擎缺该时段排盘数据：重跑还是缺，重试毫无意义(也绝不该把它当可恢复故障循环)。
  if (/local_unavailable/i.test(error)) return false;
  return true;
};

/** 每个任务类型硬性要求出现的【小节】。模型输出缺段时自动重写一次(与提示词“输出硬性要求”呼应)。 */
export const REQUIRED_SECTIONS: Record<string, string[]> = {
  baseline: ['身强身弱与喜忌', '健康', '事业', '财运', '爱情'],
  annual: ['健康', '事业', '财运', '爱情', '刑冲克害批注'],
  monthly: ['健康', '事业', '财运', '爱情', '刑冲克害批注'],
  decade: ['健康', '事业', '财运', '爱情', '刑冲克害批注'],
  adjustment: ['后天调整', '事业适配', '健康注意'],
  overview: ['核心结论', '值得关注的时间节点', '行动建议'],
};

/** 固定最大并发(命中率优先)：**不爬坡** —— 一开始就满速发，遇限流/超时只冷却重发，绝不降档。
 * 取 8 路：单张命盘最多 27 条请求；三条通道里最紧的是 Kimi(约 64 RPM 稳态)，
 * 8 路 × 平均 6s ≈ 每秒 1.3 条新请求，配合秒级冷却兜底刚好贴住最慢通道的稳态吞吐，
 * 同时远在 DeepSeek/Qwen 的上限之下，不会长期撞墙。repair 用于收尾补跑(量小、单独一轮)。 */
export const FIXED_CONCURRENCY = { scope: 8, decade: 3, repair: 6 } as const;
/** 冷却时长：限流与超时都等 3s(上游计数窗口多为秒级)后原样重发。 */
const COOLDOWN_MS = 3000;

// 只有「我们自己发太快」才需要冷却等待；上游 5xx/超时属于服务故障，重试即可，不应拖慢整体收尾。
const RATE_LIMIT_RE = /429|rate\s*limit|限流|too many requests|requests per|频繁/i;
const TRANSIENT_RE = /HTTP\s*5\d\d|timeout|timed out|network|econn|网络|超时/i;
export const isThrottleFailure = (error?: string): boolean => !!error && (RATE_LIMIT_RE.test(error) || TRANSIENT_RE.test(error));
/** 仅“限流”值得进入冷却窗口(避免继续撞墙)；5xx/网络抖动只重试不冷却。 */
export const isRateLimited = (error?: string): boolean => !!error && RATE_LIMIT_RE.test(error);
/** 超时/不可达：说明这条通道被我们压满了，与限流同样处理(冷却后原样重发)。 */
export const isTimeoutFailure = (error?: string): boolean => !!error && /超时|timed out|timeout|不可达/i.test(error);

export async function fixedMapLimit<T>(items: T[], concurrency: number, worker: (item: T) => Promise<{ status?: string; error?: string } | void>): Promise<void> {
  const queue = [...items];
  const c = Math.max(1, concurrency);
  let running = 0;
  let cooledUntil = 0;
  let settled = false;
  let abortReason: unknown = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { if (settled) return; settled = true; if (timer) { clearTimeout(timer); timer = null; } if (abortReason) reject(abortReason); else resolve(); };
    // 只有「没有任务在跑」且「队列已空」才算完成；冷却期仍有排队时绝不能提前收尾(否则会静默丢任务)
    const checkDone = () => { if (!settled && running === 0 && queue.length === 0) finish(); };
    const pump = () => {
      if (settled || abortReason) return;
      const now = Date.now();
      if (now < cooledUntil) {
        if (timer === null) timer = setTimeout(() => { timer = null; pump(); }, Math.min(1000, cooledUntil - now));
        return;
      }
      while (!settled && running < c && queue.length > 0) {
        const item = queue.shift()!;
        running += 1;
        void (async () => {
          let outcome: { status?: string; error?: string } | void = undefined;
          try { outcome = await worker(item); }
          catch (error) { abortReason = abortReason ?? error; outcome = undefined; }
          finally {
            running -= 1;
            // 「限流 / 超时」一律冷却后重发(不爬坡、不降并发)；上游 5xx 属对方故障，重试即可不必等。
            if (outcome && outcome.status === 'failed' && (isRateLimited(outcome.error) || isTimeoutFailure(outcome.error))) cooledUntil = Date.now() + COOLDOWN_MS;
            pump();
            checkDone();
          }
        })();
      }
      checkDone();
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
  if (task.type === 'overview') return '全盘总结(值得关注的时间节点)';
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
  const asString = (v: unknown) => (typeof v === 'string' ? sanitizeAnalysisText(stripMarkers(v)) : '');
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
/** 分析窗口的起点：分组标题写的是「未来十年」「从今天起」，窗口就必须从今天算。
 *  曾经按 record.createdAt 排月，一条几个月前建的盘会把「从今天起的十二个月」摆成去年的月份。
 *  createdAt 只在未来才作起点(测试与预建盘要能复现固定窗口)。 */
export function analysisHorizon(record: BaziRecord, now: Date = new Date()): { year: number; month: number } {
  const current = chinaYearMonth(now);
  const created = chinaYearMonth(record.createdAt);
  return created.year > current.year || (created.year === current.year && created.month > current.month) ? created : current;
}

export function buildBaziTasks(record: BaziRecord, now?: Date): BaziAnalysisTask[] {
  const annual = record.nonAiResult?.annualFortunes ?? [];
  const start = analysisHorizon(record, now);
  const year = start.year;
  const { year: startYear, month: startMonth } = start;
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
  // 大运任务只排**起运落在十年窗口内**的那几运(起点晚于今年、又不越过窗口末尾)。
  // 把「今年正在走的那一运」排进来会出两件事：
  // ① 界面分组④按 pruneStaleTasks 的口径不摆它，于是这一格在界面上永远看不到、也永远填不满，
  //    「本机结果是否完整」因此恒为假 —— 23/23 都已生成的盘每次点 AI 分析都整轮重算(真金白银)；
  // ② 正文里全是已经发生过的事，与「未来大运」的标题相反。
  // 上界 startYear <= year+9 与改动前的窗口末尾同一条：更远的运还没到讨论的时候，也不该占槽位。
  const greatFortunes = record.nonAiResult?.greatFortunes ?? [];
  const decadeTasks: BaziAnalysisTask[] = greatFortunes
    .filter((g) => g.startYear > year && g.startYear <= year + 9)
    .map((g, i) => ({ taskId: `task-${String(i + FIRST_DECADE_TASK_INDEX).padStart(2, '0')}`, type: 'decade' as const, year: g.startYear, decade: g }));
  return [...core, ...decadeTasks];
}

/** 大运任务的固定编号起点：本命/流年/流月占 task-01..task-23，往后依次排大运段。 */
export const FIRST_DECADE_TASK_INDEX = 24;
/** 「全盘总结」任务的固定 id(排在所有时段任务之后)。 */
export const OVERVIEW_TASK_ID = 'task-31';
/** 本轮窗口该排哪些任务：buildBaziTasks 的清单 +「全盘总结」。后者要等时段任务跑完、
 *  且要点齐了才发，所以不在 buildBaziTasks 里 —— 但判定「这台设备/这一轮是否已经跑完」时
 *  必须一起算进来，否则界面明明有「② 全盘总结」正文，每次点 AI 分析却还要白等一次总结请求。
 *  与 PersonDetail 的完整性判定共用，两处口径不许各写一份。 */
export function expectedTaskIds(record: BaziRecord, now?: Date): string[] {
  const ids = buildBaziTasks(record, now).map((task) => task.taskId);
  const overview = record.aiOverview;
  if (overview?.explanation || overview?.pattern) ids.push(OVERVIEW_TASK_ID);
  return ids;
}/** 单条要点截断长度：总结只需要结论，不需要把每篇长文原样再发一遍。 */
export const FINDING_SNIPPET = 260;

/** 从正文里提炼「值得注意」的句子：优先带年份/干支与风险词的编号行。 */
const pickPoints = (text: string, limit: number): string => {
  const lines = (text || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const kept: string[] = [];
  let head = '';
  for (const line of lines) {
    // 【小节】标题保留，便于模型按维度归纳
    if (/^【[^】]{1,16}】/.test(line)) { head = line.slice(0, 24); continue; }
    kept.push(line);
  }
  const body = kept.join(' ').replace(/\s+/g, ' ');
  const out = (head ? head + ' ' : '') + body.slice(0, limit);
  return out;
};

/** 汇总各时段已完成结果，作为「全盘总结」的输入(不含未完成任务，避免让模型猜)。 */
export function collectFindings(record: BaziRecord, aiTasks: Record<string, BaziTaskResult>, tasks: BaziAnalysisTask[], now?: Date): AiFindings {
  const from = analysisHorizon(record, now).year;
  const horizon = { from, to: from + 9 };
  const headingOf = (task: BaziAnalysisTask): string => {
    if (task.type === 'decade') {
      const gf = task.decade ?? (record.nonAiResult?.greatFortunes ?? []).find((row) => task.year !== undefined && task.year >= row.startYear && task.year <= row.endYear);
      return (gf?.ganZhi ? gf.ganZhi + ' ' : '') + '大运段(' + (gf?.startYear ?? task.year ?? '') + '-' + (gf?.endYear ?? '') + ')';
    }
    if (task.type === 'monthly') return task.year + '年' + task.month + '月' + (task.monthly?.ganZhi ? '(' + task.monthly.ganZhi + ')' : '');
    return (task.year ?? '') + '年' + (task.annual?.ganZhi ? '(' + task.annual.ganZhi + ')' : '');
  };
  const bucket = (type: BaziTaskType) => tasks
    .filter((task) => task.type === type)
  // 存量记录重跑时，同一 taskId 可能既在 aiTasks 里(旧窗口的大运段)又被本次排入；
  // 只取本轮任务集这一条，否则会把已不在窗口内的旧大运段也当成要点。
    .map((task) => ({ task, result: aiTasks[task.taskId] }))
    .filter((row) => row.result?.status === 'completed' && !!row.result.analysis?.explanation)
    .map((row) => ({ key: row.task.taskId, heading: headingOf(row.task), text: pickPoints(row.result.analysis!.explanation!, FINDING_SNIPPET) }))
    .filter((row) => row.text.length > 0);
  return { horizon, baselineSummary: '', decades: bucket('decade'), annuals: bucket('annual'), monthlies: bucket('monthly') };
}

const makeDefaultRunner = (record: BaziRecord, signal?: AbortSignal, tone?: number): TaskRunner => async (task) => {
  const result = await adapter.analyzeBazi(record, task, { signal, tone });
  return { task, status: result.status, analysis: 'analysis' in result ? result.analysis : undefined, error: 'error' in result ? result.error : undefined, source: 'cloud' as const };
};

/** 本地离线（第四路）runner：由 localAnalysis 规则引擎就地就排盘事实产出与云端各篇同构的正文。
 *  不触网、不耗额度；缺该时段排盘数据时以 local_unavailable 失败(非可重试)，如实反映而不编造。 */
const makeLocalRunner = (record: BaziRecord, now?: Date): TaskRunner => async (task) => {
  /* 规则引擎按需加载：只有真的走本机这一路才付这 41 KB，云端那条主路径不必带着它进首屏包。 */
  const { buildLocalTaskAnalysis } = await import('./localAnalysis');
  const analysis = buildLocalTaskAnalysis(record, task, now ?? new Date());
  return analysis
    ? { task, status: 'completed' as const, analysis, source: 'local' as const }
    : { task, status: 'failed' as const, error: 'local_unavailable: 缺少该时段排盘数据，请先「重新计算非 AI」', source: 'local' as const };
};

/** 历史脏结果(completed 但无正文)不能算「已有结果」：既不该复用，也不该让总结误以为跑过。
 *  引擎不同也绝不复用：云端结果不在本地模式复用、本地结果不在云端模式复用 —— 切换生成方式即整轮重算，
 *  使「本地正文」与「云端正文」不互相冒充(source 缺省视作云端，兼容加字段前的存量结果)。 */
const reusableResult = (item: BaziTaskResult | undefined, local = false): boolean =>
  item?.status === 'completed' && !!item.analysis && (!!item.analysis.explanation || !!item.analysis.pattern)
  && (((item.source ?? 'cloud') === 'local') === local);

export async function orchestrateBaziAnalysis(record: BaziRecord, runner?: TaskRunner, onProgress?: ProgressFn, options: OrchestrateOptions = {}): Promise<BaziRecord> {
  const { signal, retries = 1 } = options;
  const retryDelayMs = options.retryDelayMs ?? (isTest ? 0 : DEFAULT_RETRY_DELAY_MS);
  // 未显式传 runner 时：本地离线（第四路）用规则引擎，否则走云端大模型。窗口起点在下面固定后喂给本地 runner。
  const actualRunner: TaskRunner = runner ?? (options.local ? makeLocalRunner(record, options.now) : makeDefaultRunner(record, signal, options?.tone));
  // 窗口起点在一次分析内固定：跨月长跑时「第 9 项/共 24 项」不会中途变样
  const now = options.now ?? new Date();
  const tasks = buildBaziTasks(record, now);
  // 滚动十二个月的 干支月/关系 需要历法引擎：在需要时才加载(不占首屏)
  const { singleCalendarMonth } = await import('../features/chart/nonAiCalculator');
  const total = tasks.length;
  const aiTasks = { ...(record.aiTasks ?? {}) };
  let done = 0;
  /** 本命喜用是否可用：决定「后天调整」那一项会不会真的发出去。 */
  let adjustmentWillRun = false;
  /** 「全盘总结」的占位：时段任务开跑后置真，收尾确认无要点可总结时撤回(不虚报)。 */
  let summarySlot = false;
  /** 后天调整是否真的跑过：跑过后它已在 tasks 里，不再重复计数。 */
  let adjustmentRan = false;
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
  /** 界面显示的总项数：tasks.length 是「当前这一拍」的队列长度，而「后天调整」「全盘总结」要等本命/时段任务跑完才入列。
   *  不补齐就会出现「第 25 项 / 共 23 项」。占位只在对应步骤真的可能发时才算：
   *    · 后天调整：本命一确定就已知(它排在所有时段任务之后)
   *    · 全盘总结：时段任务开跑后才可能出现(没有任何已完成结果时不会发) */
  const totalShown = (): number => {
    const hasTask = (id: string) => tasks.some((task) => task.taskId === id);
    const extras = (adjustmentWillRun && !adjustmentRan ? 1 : 0) + (summarySlot && !hasTask(OVERVIEW_TASK_ID) ? 1 : 0);
    return Math.max(tasks.length + extras, done);
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
    // 历史脏结果(completed 但无正文)必须重跑；引擎不同(如本地↔云端切换)也重跑
    const reusable = reusableResult(prev, !!options.local);
    if (reusable) {
      done += 1;
      const progress: AiProgress = { done, total: totalShown(), label: taskLabel(task), record: snapshot() };
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
    const progress: AiProgress = { done, total: totalShown(), label: taskLabel(task), record: snapshot() };
    await emitProgress(progress);
    return result;
  };

  const pick = (type: BaziTaskType) => tasks.filter((task) => task.type === type);
  const baselineResult = await step(pick('baseline')[0]);
  // 本命喜用确定后：追加一次“后天调整与职业适配”(按喜用五行取资料库) —— 只算一次
  const favorite = baselineResult.status === 'completed' ? primaryElement(baselineResult.analysis?.usefulElements) : undefined;
  adjustmentWillRun = !!favorite;
  // 本命结论摘要注入每个时段任务作锚点，防止模型自推/乱说
  const analysis = baselineResult.analysis;
  let baselineSummaryText = '';
  if (baselineResult.status === 'completed' && analysis) {
    baselineSummaryText = '格局：' + (analysis.pattern || '—') + ' · 强弱：' + (analysis.strength || '—')
      + '　喜：' + (analysis.usefulElements ?? []).join('、') + '　忌：' + (analysis.avoidElements ?? []).join('、');
    for (const task of tasks) {
      if (task.type === 'annual' || task.type === 'monthly' || task.type === 'decade') task.baseline = { summary: baselineSummaryText } as never;
    }
  }
  // ── 命中率优先的调度(实测驱动，不爬坡)──────────────────────────────────────────
  // 提示词按「恒定在前、可变在后」排列(deepseekAdapter.ts 顶部有分段顺序说明)，
  // 共享前缀由 qwen-prefix-measure.test.ts 逐对实测：
  //   · 一轮任务彼此的全局公共前缀 = 实测 1714 字(占最短全文 49%) —— natal 段 + 到指令分叉点为止
  //   · 同一公历年的「流年 ↔ 该年各流月」再多共享一整个年度段：前缀相同比例 ≥95%
  // 所以调度原则：先用一条请求把公共前缀烘进上游缓存，再让同年任务一起并发吃这段长前缀。
  // 组内不再串行——流年与该年流月只差尾巴，彼此都能命中已烘焙的前缀；唯一的串行点
  // 是第一条预热请求，用来保证「后面的请求进来时前缀已经在缓存里」。
  const annuals = pick('annual');
  const monthlies = pick('monthly');
  const decades = pick('decade');
  const byYear = new Map<number, BaziAnalysisTask[]>();
  for (const t of [...annuals, ...monthlies, ...decades]) {
    const key = t.year ?? 0;
    const list = byYear.get(key) ?? [];
    list.push(t);
    byYear.set(key, list);
  }
  // 每组内流年排最前：它一落地，同组流月开始跑时前缀已含该年年度段。
  const groups = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((x, y) => (x.type === 'annual' ? -1 : 0) - (y.type === 'annual' ? -1 : 0)));
  const flat = groups.flat();
  if (flat.length > 0) summarySlot = true;                  // 时段任务要跑了：给「全盘总结」留一格
  if (flat.length > 0) await step(flat[0]);                 // 预热：建立全局公共前缀
  // 组间并发、组内也并发：整批交给固定池一次性发满，只有「限流/超时」才冷却重发。
  if (flat.length > 1) await fixedMapLimit(flat.slice(1), FIXED_CONCURRENCY.scope, step);
  // 工作/生活/职业知识：最后才上传(等大运流年流月都分析完，避免上下文污染)
  if (favorite && baselineResult.status === 'completed') {
    const guide: ElementGuide = ELEMENT_GUIDES[favorite];

    const adjustmentTask: BaziAnalysisTask = {
      taskId: 'task-30', type: 'adjustment',
      baseline: baselineResult,
      guide: { element: guide.element, lifestyle: guide.lifestyle, career: guide.career, health: guide.health },
    };
    tasks.push(adjustmentTask);
    adjustmentRan = true;
    // 注意：这里必须跑「刚创建的那一条」，不能用 tasks.filter(type) —— 恢复旧记录时同一类型可能已有一条历史任务，filter 会把同一条塞进队列两次。
    await fixedMapLimit([adjustmentTask], 1, step);
  }
  // 全盘总结：把已算出的大运/流年/流月要点交给模型，判断「哪些时间节点真正值得关注」。
  // 必须排在时段任务之后 —— 它依赖前序结论；单独一条请求，不参与并发。
  const findings = collectFindings(record, aiTasks, tasks, now);
  // 一条要点都没有就不会发总结，进度总数也不留这一格。
  const hasFindings = findings.annuals.length + findings.monthlies.length + findings.decades.length > 0;
  summarySlot = hasFindings;   // 一条要点都没有就不会发总结，进度总数也不留这一格
  if (hasFindings) {
    const overviewTask: BaziAnalysisTask = { taskId: OVERVIEW_TASK_ID, type: 'overview', baseline: { summary: baselineSummaryText, analysis: baselineResult.analysis } as never, findings };
    tasks.push(overviewTask);
    await fixedMapLimit([overviewTask], 1, step);   // 上一轮已跑出正文时 step() 原样复用，不再发请求
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
    await fixedMapLimit(stillFailed, FIXED_CONCURRENCY.repair, repairStep);
    ensureLive();
  }
  const statuses = Object.values(aiTasks).map((item) => item.status);
  const failedTask = Object.values(aiTasks).find((item) => item.status === 'failed');
  const notConfigured = Object.values(aiTasks).find((item) => item.status === 'not_configured');
  return {
    ...record,
    aiTasks,
    aiAnalysis: aiTasks['task-01']?.analysis ? sanitizeAnalysis(aiTasks['task-01']?.analysis) : undefined,
    // 全盘总结落到 aiOverview(记录里已有该字段与持久化通道)，供详情页顶部展示
    aiOverview: aiTasks[OVERVIEW_TASK_ID]?.analysis ? sanitizeAnalysis(aiTasks[OVERVIEW_TASK_ID]!.analysis) : undefined,
    aiStatus: statuses.includes('failed') ? 'failed' : statuses.includes('not_configured') ? 'not_configured' : 'completed',
    aiError: failedTask?.error ?? (notConfigured ? '未配置 AI 服务' : undefined),
  };
}