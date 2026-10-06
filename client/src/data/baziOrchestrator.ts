import type { AiFindings, BaziAIAnalysis, BaziAnalysisTask, BaziRecord, BaziTaskResult, BaziTaskType } from '../types/domain';
import * as adapter from './deepseekAdapter';
import { readableTransportError } from './deepseekAdapter';

import { chinaYearMonth } from '../utils/date';
import { ELEMENT_GUIDES, primaryElement, type ElementGuide } from './elementKnowledge';
import { sanitizeAnalysisText } from '../features/chart/elements';
import { cnCount, cnYear } from '../shared/chineseReadAloud';
export type TaskRunner = (task: BaziAnalysisTask, payload: { nonAiResult: BaziRecord['nonAiResult']; task: BaziAnalysisTask }) => Promise<BaziTaskResult>;
export interface AiProgress { done: number; total: number; label: string; record: BaziRecord; }
export type ProgressFn = (progress: AiProgress) => void | Promise<void>;

export const ABORTED_MESSAGE = '已停止：已完成的任务已保存，可随时再点批断分析继续完成剩余任务';
/** 「一轮」内的再试额度(可变的记账对象，由 step() 的即时重试与池子的冷却重发共同扣减)。 */
type RoundBudget = { retriesLeft: number };

/** 「一轮」内的**发口额度**：余额就是「这条任务在这一阶段还允许发几次请求」。
 *  一个模型、两处用法，扣账点必须与进门闸门配对(见 step() 与 repairStep())：
 *   · `retriesLeft > 0` 是**进门判据**(排在每次 `await attemptOnce` 之前)；
 *   · `spend()` 是**发口后扣账**，只有余额为正才扣得动 ⇒ 余额永远不为负。
 *  ⚠ 两条纪律都是实测换来的(jsdom 2026-10-07)：
 *   · 把扣账写成无条件 `-= 1`(旧形态)会把余额打成负数 ⇒ 「查余额」的闸门(#117 补跑名单)读不出
 *     「这一条已经烧过」。当时恒超时盘读数不变(67/90)，因为 step() 还没接这本账；#121 把首发也
 *     记进同一本之后，这条下限就成了**行为可观测**的必需项(去掉它 task-01 会读到三口)。
 *   · 反过来，若只加进门判据而不给首发扣账(step 的 retries:0 形态)，池子的退队重发就还能拿到
 *     一条额度 ⇒ 同一条结论被买两次(#109 的口径)。所以首发那句 `spend(own.budget)` 不能省。 */
const spend = (budget?: RoundBudget) => { if (budget && budget.retriesLeft > 0) budget.retriesLeft -= 1; };

/**
 * 缺陷 #108 / #117 的记账口径：**每条任务一本账，分「主跑」与「补跑」两个阶段各记一份**。
 * · 主跑起始余额 = options.retries(默认 1)，step() 的即时重试与 fixedMapLimit 的限流/超时退队重发
 *   从**同一本**扣。⚠ 「同一本」只保证**池子自己**那条路不超发(退队闸门 + spend 双保险)，
 *   挡不住 step() 的即时重试不看余额就进门(旧形态 `attempt < retries` 恒真)：实测恒失败盘 retries:1 时
 *   一条任务一整轮花 **3** 口(首发 + 补跑首发 + 补跑再试)、整轮 69 口，而不是注释里曾经写的「最多 2 次」。
 *   【#121 已做 · 实测矩阵 jsdom 2026-10-07】step() 的再试现在查的是 `own.budget.retriesLeft > 0`，
 *   首发也随即记账 ⇒ 同一本账封住超发。四格读数(23 条任务全走桩、每条 id 计数)：
 *     · 恒失败(上游五百)  retries:1 ：HEAD 每口 3 / 整轮 69  →  修复后每口 2 / 整轮 **46**
 *     · 恒超时            retries:0 ：HEAD 2 / 67            →  修复后 2 / **67**(这条没变)
 *     · 恒超时            retries:1 ：HEAD 3 / 90            →  修复后 2 / **67**
 *   ⇒ 省钱的两格是「恒失败 retries:1」与「恒超时 retries:1」；恒超时 retries:0 的 67 口里那第二口
 *   是池子的冷却重发(它必须能重发，否则限流的任务以 failed 落库 = #104)，不是超发。
 *   代价如实记下：主跑额度被自己的首发扣光 ⇒ 「completed 但缺【小节】」不再在**主跑**内自动重写
 *   (orchestration 的 task-31 用例从 2 口读成 1 口)；补跑名单只收 failed，所以那种盘的结构缺陷
 *   这一轮不再有人修 —— 这是有意的口径变更(省下的正是重复付费的那一口)，不是遗漏。
 *   补跑阶段另有 REPAIR_BUDGET
 *   那一口(repairStep 与补跑轮的退队重发共用它) —— **不能**让两阶段共用同一本账，实测订正见 roundOf 上方。
 * · 旧写法给整批队列共用的账户充 `retries` 然后两处同时扣：先跑完的任务把余额扣成负数，
 *   后面的任务一口都拿不到(实测第一轮只发 34 口、界面像卡住)；而补跑轮另开新账，于是
 *   同一条任务被烧三次(主 1 + 即时 1 + 补跑 1)，下一轮自动重试又把同样的失败带回来 ⇒
 *   批次逐轮变大永不收敛(实测 92 → 20 → 46)。
 * · 每条任务原本另存一份 `cap`(即时再试上限，与改动前 `attempt < retries` 同形)，用来给「缺【小节】
 *   自动重写」留一口。#121 让 step 的再试也认这本账之后，那个字段没有任何代码读过(死字段)，删掉 ——
 *   它换来的那一次重写正是上面记下的超发口，二者只能留一个，这里留账本。
 */
type TaskRound = { readonly budget: RoundBudget; readonly repairBudget: RoundBudget };

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
}

const isTest = typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test';
const DEFAULT_RETRY_DELAY_MS = 900;
export const DEFAULT_TONE = 80;   // 检测到失败后尽快重发(太短易被限流，900ms 合适)
const REPAIR_WAIT_MS = 2500;          // 整批跑完后的自动补跑等待
/** 补跑阶段给**每条任务**的那一份额度(与主跑的 retries 分开，见 roundOf 的实测订正)。
 *  ⚠ 「独立」指的是记账对象不同，不是「随便再发一批」：这一份同样记在**这条任务**的账上、
 *    被 step/池子退队/补跑三处共同扣减 ⇒ 恒超时下每条一整轮最多「主跑 1+1、补跑 1+1」四口封顶，
 *    批次不会像旧写法那样逐轮变大(缺陷 #108 实测 92 → 20 → 46 的成因是补跑那份额度没和退队重发对账)。 */
const REPAIR_BUDGET = 1;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** 判定某条错误是否值得自动重试(密钥类/权限类重试也是白费) */
export const isRetryableFailure = (error: string | undefined): boolean => {
  if (!error) return false;
  if (/not_configured|未配置|credential|keyring/i.test(error)) return false;
  // 状态码现在一律读成中文「服务返回四零一」，不再出现「HTTP 401」这种形态；
  // 两种写法都留着认：存量 record.aiError 里还有旧格式，漏掉就会对着余额不足白烧两次钱。
  if (/HTTP 40[0-9]|服务返回四[零一二三四五六七八九]/.test(error)) return false;
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
/** 冷却时长：限流与超时都等 3s(上游计数窗口多为秒级)后原样重发。
 *  导出是给用例用的：等待「一批跑完」的稳定窗必须严格大于它，否则会把池子自己的冷却静默
 *  读成队列已空(实测缺陷 #111，见 auto-retry-schedule.test.tsx 的 settleBatch)。 */
export const COOLDOWN_MS = 3000;

// 只有「我们自己发太快」才需要冷却等待；上游 5xx/超时属于服务故障，重试即可，不应拖慢整体收尾。
const RATE_LIMIT_RE = /429|rate\s*limit|限流|too many requests|requests per|频繁/i;
const TRANSIENT_RE = /HTTP\s*5\d\d|timeout|timed out|network|econn|网络|超时/i;
export const isThrottleFailure = (error?: string): boolean => !!error && (RATE_LIMIT_RE.test(error) || TRANSIENT_RE.test(error));
/** 仅“限流”值得进入冷却窗口(避免继续撞墙)；5xx/网络抖动只重试不冷却。 */
export const isRateLimited = (error?: string): boolean => !!error && RATE_LIMIT_RE.test(error);
/** 超时/不可达：说明这条通道被我们压满了，与限流同样处理(冷却后原样重发)。 */
export const isTimeoutFailure = (error?: string): boolean => !!error && /超时|timed out|timeout|不可达/i.test(error);

/** 固定并发池。worker 返回 failed 且属于限流/超时时，这一条会在冷却后**重发一次**(上限一条一次)；
 *  重发仍失败的如实留在 failed，交给后面的补跑轮。 */
export async function fixedMapLimit<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<{ status?: string; error?: string } | void>,
  budgetOf?: (item: T) => RoundBudget | undefined,
): Promise<void> {  const queue = [...items];
  const c = Math.max(1, concurrency);
  let running = 0;
  let cooledUntil = 0;
  let settled = false;
  let abortReason: unknown = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 已因限流/超时退下来、正在等冷却窗的那几条。**不能**塞回 queue：
   *  · append 到尾部 ⇒ 只要初始队列比并发数长，running 就永远降不到 0，收尾判据
   *    (`running===0 && queue.length===0`)永不成立，这一句 await 卡死 ⇒ 详情页走不到
   *    收尾(既不落库也不排期)。实测缺陷 #110：第一次自动轮 23 个槽位只发了 10 个共 20 口。
   *  · unshift 到队首 ⇒ 反过来把未处理条目挤到后面，同一条被反复点起来打到额度耗尽，
   *    同样永不收尾。实测缺陷 #110b：第二轮 46 口仍在滴灌。
   *  单独一份集合还顺带修掉一个烧钱点：退下来的条目原先排在队尾，要等整批新任务都跑完
   *  才轮到它，那时 step() 的即时重试早已把额度花光，冷却重发等于白跑一趟(实测第一轮
   *  每条任务被打进 step() 三到四次、113 口)。 */
  const pending: T[] = [];
  // 「本条目是否已经因限流/超时重发过一次」。用 WeakSet 而不是给条目打标记：任务对象会被
  // step() 就地写入 baseline，改对象会污染缓存语义；WeakSet 只记引用、池散即清。
  const requeued = new WeakSet<object>();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { if (settled) return; settled = true; if (timer) { clearTimeout(timer); timer = null; } if (abortReason) reject(abortReason); else resolve(); };
    // 只有「没有任务在跑」且「待办与冷却排队都已清空」才算完成；冷却期仍有排队时绝不能提前收尾(否则会静默丢任务)
    const checkDone = () => { if (!settled && running === 0 && queue.length === 0 && pending.length === 0) finish(); };
    const pump = () => {
      if (settled || abortReason) return;
      const now = Date.now();
      if (now < cooledUntil) {
        if (timer === null) timer = setTimeout(() => { timer = null; pump(); }, Math.min(1000, cooledUntil - now));
        return;
      }
      while (pending.length > 0 && running < c) {
        const item = pending.shift()!;
        requeued.add(item as object);
        runOne(item);
      }
      while (!settled && running < c && queue.length > 0) runOne(queue.shift()!);
      checkDone();
    };
    const runOne = (item: T) => {
      running += 1;
      void (async () => {
        let outcome: { status?: string; error?: string } | void = undefined;
        try { outcome = await worker(item); }
        catch (error) { abortReason = abortReason ?? error; outcome = undefined; }
        finally {
          running -= 1;
          // 「限流 / 超时」一律冷却后重发(不爬坡、不降并发)；上游 5xx 属对方故障，重试即可不必等。
          // 旧写法只记下冷却时刻、条目却已经算「处理过」，于是整批限流的任务以 failed 落库(实测缺陷 #104)。
          // 每条**最多重发一次**：不设上限时「恒失败 + 每次都算超时」会让每个波次都重开三秒窗口并把整批
          // 退回队列，这个 await 永不 resolve(实测缺陷 #106：jsdom 里池子滴灌三十秒、八十八条退队记录)。
          if (outcome && outcome.status === 'failed' && !requeued.has(item as object)
            && (isRateLimited(outcome.error) || isTimeoutFailure(outcome.error))) {
            requeued.add(item as object);
            cooledUntil = Date.now() + COOLDOWN_MS;
            pending.push(item);
            // 冷却重发花的也是**这条任务本轮那一次额度**：与 step() 里的即时重试同一本账。
            spend(budgetOf?.(item));
          }
          pump();
        }
      })();
    };
    pump();
  });
}

/** 进度条上的任务名：界面文案在正式版口径下不许出现阿拉伯数字与半角括号，
 *  所以年份逐位读成汉字。读法一律走 shared/chineseReadAloud 那一份单一词表：
 *  月份与详情页 scopeLabel 同用 cnCount(「十月」而非「一零月」)，否则同一屏里
 *  进度条和任务卡对同一个任务会念出两种名字。 */
const readYear = (n: number): string => cnYear(n);

const taskLabel = (task: BaziAnalysisTask): string => {
  if (task.type === 'baseline') return '本命命局分析';
  if (task.type === 'annual') return task.year !== undefined ? readYear(task.year) + '年流年' : '流年';
  if (task.type === 'monthly') return task.year !== undefined && task.month !== undefined ? readYear(task.year) + '年' + cnCount(task.month) + '月' : '流月';
  if (task.type === 'decade') return task.year !== undefined ? '大运段、' + readYear(task.year) : '大运段';
  if (task.type === 'adjustment') return '后天调整与职业适配，按喜用五行';
  if (task.type === 'overview') return '全盘总结，值得关注的时间节点';
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

/** 闸门放行的字符集：汉字、空白、中文句读，外加唯一保留的结构标记 【】
 *  (小节括号由 chineseGate.normalizeStructure 专门留下，供检索/切段/缺段重写判据使用)。
 *  空串也通过这个式子(trim 后 length 0)，所以能区分「原文本就为空」与「被闸门拦下」。 */
const GATE_ALLOWED = /^[一-鿿 \n、。，：；？！【】]*$/;

export function sanitizeAnalysis(raw: BaziAIAnalysis | undefined): BaziAIAnalysis {
  // 「洗成空串」有两种成因：原文含英文/符号(该按缺字段丢弃)，或原文本就为空(必须保持为空，
  // 否则下游会把占位符 '—' 当成本命结论注入时段任务)。用闸门口径把两者分开。
  const asString = (v: unknown) => {
    if (typeof v !== 'string') return '';
    const stripped = sanitizeAnalysisText(stripMarkers(v));
    return stripped || GATE_ALLOWED.test(stripMarkers(v).trim()) ? stripped : '';
  };
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
  // 大运任务排**与十年窗口有交集**的那几运(起点不越过窗口末尾、终点不落在窗口之前)。
  // 「今天正在走的那一运」也在内：用户要的是「未来十年这段路」被大运完整盖住 ——
  // 窗口 2026-2035、当前运到 2033，就该同时有「2026-2033」和「2033-2035」两段，
  // 只排后一段会让未来十年的前七年没有大运分析。
  // 判据必须与 pruneStaleTasks 的 inWindow 逐字同源：两边不一致，界面摆出来的运就没有槽位、
  // 或有槽位界面看不到，「本机结果是否完整」因此恒为假 —— 已跑完的盘每次点 AI 分析整轮重算(真金白银)。
  // 上界 endYear >= year 剔掉整段已走完的旧运；正文里全是过去年份的东西不该顶「未来大运」的标题。
  const greatFortunes = record.nonAiResult?.greatFortunes ?? [];
  const decadeTasks: BaziAnalysisTask[] = greatFortunes
    .filter((g) => g.startYear <= year + 9 && g.endYear >= year)
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

/** 汇总各时段已完成结果，作为「全盘总结」的输入(不含未完成任务，避免让模型猜)。
 *  要点标题给模型看，也会经「原因」类回显漏到界面上，所以与详情页同一套中文读法：
 *  年份逐位、区间用「至」、括号一律不写。 */
export function collectFindings(record: BaziRecord, aiTasks: Record<string, BaziTaskResult>, tasks: BaziAnalysisTask[], now?: Date): AiFindings {
  const from = analysisHorizon(record, now).year;
  const horizon = { from, to: from + 9 };
  const headingOf = (task: BaziAnalysisTask): string => {
    if (task.type === 'decade') {
      const gf = task.decade ?? (record.nonAiResult?.greatFortunes ?? []).find((row) => task.year !== undefined && task.year >= row.startYear && task.year <= row.endYear);
      // 与详情页 decadeSegment 同口径：只显这一运与「未来十年」窗口的交集，整段在窗口之外退回整段。
      const rawStart = gf?.startYear ?? task.year;
      // 终点不往「起点+9」抬：当前运与窗口的交集就该是「今年 → 它交出去那一年」(如 二零二六至二零三三)。
      // 把只有 endYear=year+1 的段抬到 year+9，会让标题盖住正文根本没谈过的年份。
      // 旧记录里 endYear 比 startYear+9 小的段仍按真实 endYear 显示，展示层不替存量数据编年份。
      const rawEnd = gf?.endYear ?? rawStart ?? horizon.to;
      const hasSpan = typeof rawStart === 'number' && typeof rawEnd === 'number';
      const intersects = hasSpan && (rawStart as number) <= horizon.to && (rawEnd as number) >= horizon.from;
      const start = intersects ? Math.max(rawStart as number, horizon.from) : rawStart;
      const end = intersects ? Math.min(rawEnd as number, horizon.to) : rawEnd;
      // readYear 对 undefined 会读出「零」，所以拿不到年份时只写干支，不编造区间。
      const range = typeof start === 'number' && typeof end === 'number' ? '大运段、' + readYear(start) + '至' + readYear(end) : '大运段';
      return (gf?.ganZhi ? gf.ganZhi + '、' : '') + range;
    }
    if (task.type === 'monthly') return readYear(task.year ?? 0) + '年' + cnCount(task.month ?? 0) + '月' + (task.monthly?.ganZhi ? '，干支' + task.monthly.ganZhi : '');
    return readYear(task.year ?? 0) + '年' + (task.annual?.ganZhi ? '，干支' + task.annual.ganZhi : '');
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
  return { task, status: result.status, analysis: 'analysis' in result ? result.analysis : undefined, error: 'error' in result ? result.error : undefined };
};

/** 历史脏结果(completed 但无正文)不能算「已有结果」：既不该复用，也不该让总结误以为跑过。 */
const reusableResult = (item: BaziTaskResult | undefined): boolean =>
  item?.status === 'completed' && !!item.analysis && (!!item.analysis.explanation || !!item.analysis.pattern);

export async function orchestrateBaziAnalysis(record: BaziRecord, runner?: TaskRunner, onProgress?: ProgressFn, options: OrchestrateOptions = {}): Promise<BaziRecord> {
  const { signal, retries = 1 } = options;
  const retryDelayMs = options.retryDelayMs ?? (isTest ? 0 : DEFAULT_RETRY_DELAY_MS);
  const actualRunner: TaskRunner = runner ?? makeDefaultRunner(record, signal, options?.tone);
  // 窗口起点在一次分析内固定：跨月长跑时「第 9 项/共 24 项」不会中途变样
  const now = options.now ?? new Date();
  const tasks = buildBaziTasks(record, now);
  const total = tasks.length;
  const aiTasks = { ...(record.aiTasks ?? {}) };
  // 滚动十二个月的 干支月/关系 需要历法引擎：在需要时才加载(不占首屏)
  const { singleCalendarMonth } = await import('../features/chart/nonAiCalculator');
  /** 本轮会不会真的发「全盘总结」那一条 —— 在建队列这一刻就定死(见下面赋值处的说明)。 */
  let summarySlot = false;
  /** 本轮真正要跑的队列：buildBaziTasks 的清单**剔掉已经出窗的槽位**。
   *  判据与读取路径 pruneStaleTasks.inWindow 逐字同源(clientRepository.ts)，两边不一致就会出现
   *  「界面摆了却没有槽位 / 有槽位界面看不到」，本机完整性判定因此恒为假(每次点批断整轮重算)。
   *  为什么要在编排器里也剔一遍：详情页那一读(pruneOnRead)只在**非空 aiTasks** 上动手，而内存库
   *  存的是 pending 快照、那份过期条目根本没落库 ⇒ 自动重试拿到的记录带着上一轮的旧时段原样回来，
   *  每一轮都重发同一组早已出窗的流月(实测缺陷 #107：桩即时 resolve 时第一轮 113 口里两整批是重复，
   *  第一次自动轮只发了窗口头两个年度的 20 口就静默收尾 —— 那些结论界面上永远不会显示，纯烧钱)。 */
  const inWindowNow = (item: BaziTaskResult): boolean => {
    const t = item.task;
    if (t.type === 'annual') return tasks.some((c) => c.type === 'annual' && c.year === t.year);
    if (t.type === 'monthly') return tasks.some((c) => c.type === 'monthly' && c.year === t.year && c.month === t.month);
    if (t.type === 'decade') {
      const start = t.decade?.startYear;
      const end = t.decade?.endYear;
      if (typeof start !== 'number') return true;
      const horizonYear = analysisHorizon(record, now).year;
      if (typeof end === 'number') return start <= horizonYear + 9 && end >= horizonYear;
      return start > horizonYear;   // 存量任务没带 endYear：退回旧判据，宁可不删也不要把有效结果抹掉
    }
    return true;
  };
  for (const id of Object.keys(aiTasks)) if (!tasks.some((task) => task.taskId === id) || !inWindowNow(aiTasks[id])) delete aiTasks[id];
  // 「全盘总结」的占位**不在此处**摆进分母 —— 见下面 flat.length > 0 那一句：它排在时段任务开跑那一刻。
  // 为什么不在建队列时按「存量有没有要点」判有无(我试过，实测 progress-bar-count 2026-10-07)：
  //   一轮从零开始、正文全靠本轮才产出的盘会读出**非单调**的分母 23 → 24 → 25 —— 界面按先看到的那份
  //   小分母落库，末条又满格 ⇒ 「total 中途漂移」。但反过来把占位提到本命之前(读 24 → 25…)同样不对：
  //   本命那一条此刻仍是「队列长度」这一格，提前 +2 会让首步虚报，且与 HEAD 既有口径分叉。
  //   两条路的账不同，收尾那句只负责**撤回**确实没攒出要点的占位。
  let done = 0;
  /** 本命喜用是否可用：决定「后天调整」那一项会不会真的发出去。 */
  let adjustmentWillRun = false;
  /** 后天调整是否真的跑过：跑过后它已在 tasks 里，不再重复计数。 */
  let adjustmentRan = false;
  const ensureLive = () => { if (signal?.aborted) { const error = new Error(ABORTED_MESSAGE); (error as Error & { aborted?: boolean }).aborted = true; throw error; } };
  const snapshot = () => ({ ...record, aiTasks, aiStatus: 'pending' as const });

  const abortError = () => { const error = new Error(ABORTED_MESSAGE); (error as Error & { aborted?: boolean }).aborted = true; return error; };
  /** 单次调用的**返回语义**：只可能「带文本的 failed / completed」，绝不抛出。
   *  PersonDetail 里 `catch (error) { markBusy(false); ... }` 那个分支会把这一轮的收尾状态写成
   *  aiError = error.message(不是任务里那份)，而 ABORTED_MESSAGE 恰好也能过 isRetryableFailure
   *  ⇒ 一旦这里真抛出，自动重试就在**没有任何取消、没有任何用户操作**的情况下静默断链
   *  (实测缺陷 #112：第二次自动轮整轮发满 113 口后调度器不再排期，界面再无排期句)。
   *  所以抛出的唯一来源(runner 本身 reject)必须在这里就地转成同一条可读失败。 */
  const toFailedResult = (task: BaziAnalysisTask, error: unknown): BaziTaskResult => ({
    task, status: 'failed' as const, error: readableTransportError(error instanceof Error ? error.message : String(error ?? '')),
  });
  /** 单次调用（失败会带错误文本返回，而不是抛出）。点“停止”后立即以 abort 拒绝，不等网络请求返回。 */
  const attemptOnce = async (task: BaziAnalysisTask): Promise<BaziTaskResult> => {
    // 月度任务补上“该公历月”的干支/关系数据行(供后端最小上下文使用)
    if (task.type === 'monthly' && task.year !== undefined && task.month !== undefined && !task.monthly) {
      task.monthly = singleCalendarMonth({ birthYear: record.birthYear, birthMonth: record.birthMonth, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar }, task.year, task.month);
    }
    const settle: Promise<BaziTaskResult> = (async () => {
      try { return await actualRunner(task, { nonAiResult: record.nonAiResult, task }); }
      catch (error) { return toFailedResult(task, error); }
    })();
    if (!signal) return settle;
    if (signal.aborted) throw abortError();
    return await new Promise<BaziTaskResult>((resolve, reject) => {
      let done = false;
      const onAbort = () => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); reject(abortError()); } };
      signal.addEventListener('abort', onAbort, { once: true });
      settle.then(
        (result) => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); resolve(result); } },
        (error: unknown) => { if (!done) { done = true; signal.removeEventListener('abort', onAbort); resolve(toFailedResult(task, error)); } },
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

  /** 每条任务的再试账本(taskId → 一本)：`budget` 是**主跑阶段**的额度，`repairBudget` 是**补跑阶段**的额度。
   *  【实测订正 · jsdom 2026-10-07】我原本让两个阶段共用同一本账(#108 的第一版改法)，读数是错的：
   *   · retries:0(线上默认盘的口径)时余额为 0 ⇒ 补跑名单被闸门全部拦掉，一整轮恒失败**一条都不补跑**
   *     (实测 still=1 repairable=0)，#104/#106 那批「失败不再直接停留」的修复等于被关掉；
   *   · retries:1 时主跑把余额扣光 ⇒ 同样不补跑，orchestration.test.ts 的「自动补跑」用例从 3 口掉到 2 口。
   *  HEAD 的口径本来就是**每阶段各一份**(step: `attempt < retries` / 补跑: `attempt < REPAIR_RETRIES`)，
   *  #108 真正的病灶是「补跑那份额度没有和池子的退队重发对账」⇒ 恒超时下每条固定烧三次、批次不收敛。
   *  所以这里保留两份额度，但两份都记在**同一条任务**的账上、都被 spend 扣减。 */
  const rounds = new Map<string, TaskRound>();
  const roundOf = (taskId: string): TaskRound => {
    const existing = rounds.get(taskId);
    if (existing) return existing;
    const created: TaskRound = { budget: { retriesLeft: retries }, repairBudget: { retriesLeft: REPAIR_BUDGET } };
    rounds.set(taskId, created);
    return created;
  };
  const step = async (task: BaziAnalysisTask, round?: TaskRound): Promise<BaziTaskResult> => {
    ensureLive();
    const own = round ?? roundOf(task.taskId);
    const prev = aiTasks[task.taskId];

    // 历史脏结果(completed 但无正文)必须重跑
    const reusable = reusableResult(prev);
    if (reusable) {
      done += 1;
      const progress: AiProgress = { done, total: totalShown(), label: taskLabel(task), record: snapshot() };
      await emitProgress(progress);
      return prev;
    }
    /* 【缺陷 #121】HEAD 把第一次 `await attemptOnce` 写在 while **之外**，于是 retries:0(线上默认盘
       就是这个口径)时主跑一次都不再试 ⇒ flat.slice(1) 那 22 条压根没进过 step()、也没往 aiTasks 写
       任何东西。补跑轮用的是同一个 step：旧写法照样无条件先发一口、再把「缺【小节】自动重写」那一口
       也发出去 ⇒ 一条任务整轮烧 **3** 口(首发 + 补跑首发 + 补跑再试)，而注释承诺的是 2 口封顶(#108)。
       更糟的是那 22 条从没被计数 ⇒ done 停在 1/23，界面像卡住，随后以 failed 落库并排第二次自动重试。
       ⚠ 三个形态都实测过(jsdom 2026-10-07)，只有下面这个同时做到「每条两口子封顶」和「一条都不漏发」：
       · 「循环头查余额 → 扣 → 发」(照抄 repairStep 的三步)是**过度修正**：池子的退队重发与 step 花
         同一本账，恒超时/恒失败盘里退队那一句先把这条任务的额度扣光 ⇒ 22 条一条都发不出
         (steps 读 0、task-02 读 0 口、总结占位永远摆不上、done 停在 1/23)，等于用「不花钱」换掉「少花钱」。
       · 只给**再试**查余额、首发完全不记账(HEAD 的无闸门原样保留)则反过来超发：补跑轮用的是同一个 step，
         那条任务仍烧三口。所以首发的 `spend` 不能省，但再试**不再另加一句扣账** —— retries 的语义是
         「首发之外还能再试几次」，余额就是那个额度；多扣一句会让 retries:1 的盘一次再试都发不出
         (实测 task-31 读 1、恒超时盘整轮读数同步下掉)。
       · 试过「循环头查余额 → 扣 → 发」的完整形态(与 repairStep 逐字同形)⇒ 见上面第一条，整批不发。
       最终形态 = **无闸门首发 + 首发随即记账 + 再试查余额**。恒失败盘每条两口子封顶(首发 + 补跑一口)。
       代价如实记下：主跑额度被自己的首发扣光 ⇒ 「completed 但缺【小节】」不再在**主跑**内自动重写
       (orchestration 的 task-31 用例从 2 口读成 1 口)，而补跑名单只收 failed ⇒ 那种结构缺陷这一轮没人修。
       这是有意的口径变更(省下的正是重复付费的那一口)，不是遗漏；实测整轮读数见上方 roundOf 那段。 */
    let result: BaziTaskResult = sanitizeCompleted(await attemptOnce(task));
    spend(own.budget);   // 首发这一口记在**这条任务主跑那本账**上：池子的退队重发也从同一本扣(补跑另有 own.repairBudget)
    for (;;) {
      const missing = result.status === 'completed' ? missingOf(task.type, result) : [];
      const retryable = result.status === 'failed' && isRetryableFailure(result.error);
      if (!retryable && missing.length === 0) break;
      /* 再试必须查余额：HEAD 这里读的是纯计数器 `attempt < retries`，于是「缺【小节】自动重写」那一口
         不看账 ⇒ 恒失败盘每条烧三口(#121)。注意闸门排在扣账之前 —— 反过来的话退队重发已把这本账扣光，
         step 连一次再试都拿不到(实测 task-31 从 2 口被打成 1 口的另一种形态：整批一条都不发)。 */
      if (own.budget.retriesLeft <= 0) break;
      ensureLive();
      if (retryDelayMs > 0) await sleep(retryDelayMs);
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
    baselineSummaryText = '格局：' + (analysis.pattern || '无') + '，强弱：' + (analysis.strength || '未判')
      + '，喜：' + (analysis.usefulElements ?? []).join('、') + '，忌：' + (analysis.avoidElements ?? []).join('、');
    // 这段摘要会作为「事实锚点」拼进下游时段任务的提示词，不是给用户看的正文。
    // 分隔符只用中文逗号与顿号：整串连同标签都会被闸门读进界面(全盘总结失败时那条原因里就有它)，
    // 所以间隔号、全角空格和破折号一律不许出现。
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
  if (flat.length > 1) await fixedMapLimit<BaziAnalysisTask>(flat.slice(1), FIXED_CONCURRENCY.scope, (task) => step(task), (t) => roundOf(t.taskId).budget);
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
    await fixedMapLimit<BaziAnalysisTask>([adjustmentTask], 1, (task) => step(task), (t) => roundOf(t.taskId).budget);
  }
  // 全盘总结：把已算出的大运/流年/流月要点交给模型，判断「哪些时间节点真正值得关注」。
  // 必须排在时段任务之后 —— 它依赖前序结论；单独一条请求，不参与并发。
  const findings = collectFindings(record, aiTasks, tasks, now);
  // 一条要点都没有就不会发总结，进度总数也不留这一格。
  const hasFindings = findings.annuals.length + findings.monthlies.length + findings.decades.length > 0;
  if (!hasFindings) summarySlot = false;   // 建队列时判有、跑完却一条要点都没攒出来：撤回占位，不虚报
  if (hasFindings) {
    const overviewTask: BaziAnalysisTask = { taskId: OVERVIEW_TASK_ID, type: 'overview', baseline: { summary: baselineSummaryText, analysis: baselineResult.analysis } as never, findings };
    tasks.push(overviewTask);
    await fixedMapLimit<BaziAnalysisTask>([overviewTask], 1, (task) => step(task, roundOf(task.taskId)), (t) => roundOf(t.taskId).budget);   // 上一轮已跑出正文时 step() 原样复用，不再发请求
  }
  ensureLive();
  // 整批跑完后自动“补跑一轮”：把仍然失败(且属于可重试因素)的任务再调一次 AI，
  // 不直接让失败停在界面上 —— 只有多轮都失败才在最后如实展示。
  // 判据必须读**本轮结束时的账本 aiTasks**(不是 record.aiTasks 那份开跑前的快照)：旧写法拿快照筛，
  // 于是主队列里已经跑成功的任务也被当成「仍失败」整批重发一遍 —— 实测缺陷 #109：桩即时 resolve、
  // 并发 8 时第一轮发出 113 口，其中 @67..@89 那 23 口与 @90..@112 那 23 口是两遍全量重发，
  // 而每一遍都以 failed 收尾 ⇒ 同一份结论最多被买三次，钱烧在两遍纯浪费上。
  const stillFailed = tasks.filter((task) => {
    const item = aiTasks[task.taskId];
    return item?.status === 'failed' && isRetryableFailure(item.error);
  });
  // 【缺陷 #117】补跑名单还必须**这条任务在补跑阶段还有余额**：旧写法不看账本，池子退队重发已经
  // 把补跑那份额度扣光的条目仍被整批重发(实测恒超时形态下每条固定多烧一口、批次逐轮不收敛)。
  const repairable = stillFailed.filter((task) => roundOf(task.taskId).repairBudget.retriesLeft > 0);
  if (repairable.length > 0 && !signal?.aborted) {
    const waitMs = isTest ? 0 : REPAIR_WAIT_MS;
    if (waitMs > 0) await sleep(waitMs);
    // total 必须走 totalShown()：这里若写 tasks.length，会把收尾刚撤回的「全盘总结」占位又摆回来
    // —— 实测缺陷 #119：retries:0、无要点的盘末条读 24/25(界面停在「共二五」而实际只有二四条)。
    if (!signal?.aborted) await onProgress?.({ done, total: totalShown(), label: '自动重试失败任务，共' + cnCount(repairable.length) + '条', record: snapshot() });
    const repairStep = async (task: BaziAnalysisTask): Promise<BaziTaskResult> => {
      ensureLive();
      // 补跑花的是**这条任务在补跑阶段的那一次**(own.repairBudget，与主跑的 own.budget 分账，见 roundOf)。
      // 旧写法给整批共用一份 REPAIR_RETRIES、又不认池子的退队重发，于是恒超时下每条任务固定烧三次
      // (主 1 + 即时 1 + 补跑 1)，下一轮自动重试又把同样的失败全带回来 ⇒ 批次逐轮变大永不收敛
      // (实测缺陷 #108：第一轮 92 次、第二轮 20 次、第三轮 46 次)。
      // 未被主跑扣过账的任务(例如整批被限流挡在队列里)余额仍是 1，所以「失败不再直接停留」
      // 这条原有语义没丢：orchestration.test.ts 的「自动补跑」用例仍然能跑到第三次。
      const own = roundOf(task.taskId);
      // ⚠ 每一次发口(含第一次)都先过闸门：HEAD 把第一次 `await attemptOnce` 写在 while 之外，
      //   于是额度已被池子退队重发扣光的条目仍无条件再发一口。
      const sanitizeDone = (r: BaziTaskResult): BaziTaskResult => r.status === 'completed' && r.analysis ? { ...r, analysis: sanitizeAnalysis(r.analysis) } : r;
      const missingOfType = (r: BaziTaskResult): string[] => { const required = REQUIRED_SECTIONS[task.type]; const text = r.analysis ? (r.analysis.explanation || '') : ''; if (!required || !r.analysis) return []; if (!/【[^】]{1,16}】/.test(text)) return []; return required.filter((name) => !text.includes('【' + name + '】')); };
      let result: BaziTaskResult | undefined;
      for (;;) {
        if (own.repairBudget.retriesLeft <= 0) break;
        spend(own.repairBudget);
        const next = sanitizeDone(await attemptOnce(task));
        result = next;
        const missing = next.status === 'completed' ? missingOfType(next) : [];
        const retryable = next.status === 'failed' && isRetryableFailure(next.error);
        if (!retryable && missing.length === 0) break;
        if (retryDelayMs > 0) await sleep(retryDelayMs);
      }
      // 一条都没发到(上面的名单已拦住，留作兜底)：保持本轮已有的那份结论原样，不覆盖、不虚报。
      if (!result) return aiTasks[task.taskId] ?? { task, status: 'failed' as const, error: '本轮重试额度已用完' };
      ensureLive();
      aiTasks[task.taskId] = result;
      return result;
    };
    // 补跑轮的冷却重发也在池内走完(见 fixedMapLimit 的退队重发)，调用方不再另起一波 ——
    // 旧写法在函数返回后再发一整批，那一波全落在详情页的自动重试额度之外：界面已进入静默期，
    // 请求却还在滴灌，实测封顶之后仍多出 22 次调用。
    await fixedMapLimit<BaziAnalysisTask>(repairable, FIXED_CONCURRENCY.repair, repairStep, (t) => roundOf(t.taskId).repairBudget);
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
    aiError: failedTask?.error ?? (notConfigured ? '未配置访问凭据' : undefined),
  };
}