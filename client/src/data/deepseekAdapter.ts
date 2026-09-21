import type { BaziRecord, BaziAIAnalysis, BaziAnalysisTask, BaziTaskResult, NonAiChart } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';
import { getBrowserCredential } from './aiSettings';
import { isServerMode, runTaskOnServer, ServerError } from './serverClient';

export type DeepSeekResult = { status: 'completed'; analysis: BaziAIAnalysis } | { status: 'not_configured' | 'failed'; error?: string };
type SecureRunner = (record: BaziRecord, task?: BaziAnalysisTask, options?: AnalyzeOptions) => Promise<BaziTaskResult>;
let secureRunner: SecureRunner | undefined;
export function configureAiTaskRunner(runner?: SecureRunner): void { secureRunner = runner; }

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const abortResult = (): DeepSeekResult => ({ status: 'failed', error: 'cancelled' });

/** 失败原因分类(与服务器/桌面端口径一致)：网络延迟、余额不足、密钥无效、限流、模型不存在等。 */
export function classifyFailure(status: number, bodyText?: string): string {
  const text = String(bodyText || '');
  const lower = text.toLowerCase();
  if (status === 402 || /insufficient|balance|quota|arrears|余额|额度|配额/i.test(text)) return '余额不足或额度已用完';
  if (status === 401 || status === 403 || /invalid.*(api.?key|token)|authentication|unauthorized|incorrect api key|密钥无效|鉴权/i.test(text)) return '密钥无效或无权限';
  if (status === 429 || /rate.?limit|too many requests|限流|频繁/i.test(lower)) return '请求过于频繁（已被限流）';
  if (status === 404 || /model.*(not found|not exist)|no such model|模型不存在/i.test(lower)) return '模型名不存在或已下线';
  if (status === 400) return '请求参数不被接受';
  if (status >= 500) return '服务端故障（上游 5xx）';
  if (status === 0) return '网络不可达或延迟过高';
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  return snippet ? ('上游报错：' + snippet) : ('HTTP ' + status);
}

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
    model: 'deepseek-flash', reasoning_effort: 'low', forecastRange, forecastScopes: ['大运', '流年', '流月'], task,
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
export async function browserFallback(record: BaziRecord, task: BaziAnalysisTask | undefined, tone: number | undefined, secret: string | undefined, signal?: AbortSignal) {
  const result = await browserDirect(record, task, { signal, tone, secret });
  if (result.status === 'completed' && result.analysis) return { ok: true };
  return { ok: false, reason: (result.status === 'failed' || result.status === 'not_configured') ? (result.error || '备用直连失败') : '备用直连失败' };
}

/** PWA/网页直连（密钥本机保存，仅作为无服务器时的备用通道）。 */
/** 通道定义：端点/模型/参数与服务器端、桌面端保持一致。 */
interface ChannelSpec { id: 'deepseek' | 'kimi' | 'qwen'; label: string; endpoint: string; model: string; temperature?: number; disableThinking?: boolean }
const CHANNELS: ChannelSpec[] = [
  { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' },
  { id: 'kimi', label: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'kimi-k2.6', temperature: 1 },
  { id: 'qwen', label: 'Qwen3.8-Flash', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen3.8-flash', temperature: 0.3, disableThinking: true },
];
/** 当前优先通道 + 其余已配置通道（依次回退），与设置页的“使用中/已配置”一致。 */
function channelOrder(forced?: string): ChannelSpec[] {
  const selected = forced ?? (() => { try { return localStorage.getItem('mingli.provider') ?? 'deepseek'; } catch { return 'deepseek'; } })();
  const head = CHANNELS.filter((c) => c.id === selected);
  return [...head, ...CHANNELS.filter((c) => c.id !== selected)];
}

/** 系统提示词：全通道共用同一条，逐字节一致(前缀缓存的第一层)。 */
const SYSTEM_SCOPE = '请把思考压缩到最短，直接输出符合要求的简体中文 JSON 正文；全篇不得出现繁体字。';
/** 输出硬性要求：与任务类型无关的公共约束，紧跟 natal 之后。 */
const OUTPUT_RULES_TEXT = '\n\n# 输出硬性要求(违反即整篇作废重写)\n'
  + '1. 全篇一律使用简体中文(UTF-8)，禁止任何繁体字、异体字混入。\n'
  + '2. explanation 的【】小节必须按本任务规定逐段出现、各只出现一次，顺序一致，不得合并、省略或改名。\n'
  + '3. 每个小节至少 1 条编号要点；每条单独一行、行首用 1. 2. 3. 编号，一句话一条，禁止整段连排。\n'
  + '4. 禁止输出注释、代码块或任何围栏标记，只给最终正文。';

const SCOPE_PREFIX = '你是资深子平命理师，仅分析时段运势。严格依据下方【事实数据(JSON)】作答，禁止自行推算干支、十神、五行或关系。'
  + '禁止输出注释或代码块/围栏标记，只给最终正文。本命格局与旺衰已由引擎算定并写在 natal.patternFacts / natal.strengthScore 中，你不得重判、不得改口径；本期吉凶只在既定喜忌下衡量该期干支的作用。'
  + '用 JSON(仅 JSON)返回，schema：{"title":"古风四字或对仗标题(可选)","explanation":长文}。'
  + 'title 只能用干支+四字直书(如：卯戌六合·和合之象)或古典口诀风格，不得编造伪古文引文。'
  + 'explanation 必须依次各出现一次【健康】【事业】【财运】【爱情】【刑冲克害批注】，顺序一致，不得合并、省略或改名。'
  + '\n\n# 时段判断标准(硬性)\n'
  + '1. 先读 natal.strengthScore.label 与 natal 中的喜忌方向：本期干支(含大运)属喜用则论顺、属忌神则论逆，生扶/克制关系以 natal.hiddenStems、scope.*Hits 为准，禁止自造五行关系。\n'
  + '2. 【刑冲克害批注】只依据 scope 里的 annualHits/monthlyHits/decadeHits 逐条编号，每行格式：数字. 关系（干支实例）：一句影响，例如 1. 三合（巳酉丑半合）：…；若数组为空则写一条：1. 本期无重大刑冲克害（仅提示）。不得把 natal.relationships 里已有之说成本期新发生的作用。\n'
  + '3. 四个主题(健康/事业/财运/爱情)每段至少 1 条编号要点，须点明「本期相对本命是加力还是减力」并给出依据(哪个十神、什么作用)。\n'
  + '4. 各主题全文只出现一次，禁止先短句后长文重复两遍。每个主题内部必须分点陈述：每条单独一行、行首用 1. 2. 3. 编号，一句话一条，不要整段连排。';

const BASELINE_PREFIX = '你是资深子平命理师。严格依据下方【事实数据(JSON)】作答，禁止自行推算干支、十神、五行、藏干或关系。'
  + '当前分析目标：本命。用 JSON(仅 JSON)返回，schema：{"pattern":格局,"strength":身强/身弱/中和偏旺/中和偏弱,"usefulElements":[喜用],"avoidElements":[忌用],"explanation":长文}。'
  // —— 关键口径：格局与旺衰已由引擎按确定算法算出，写在 natal.patternFacts / natal.strengthScore 里，
  //    模型只负责「解读」与「定喜用」，不负责「重判」。这是消除同盘不同答案(命中率)的根本手段。
  + '\n\n# 判定标准(硬性，逐条遵守)\n'
  + '1. 格局：直接采用 natal.patternFacts.name，不得另立格局名、不得改写；patternFacts.basis 是取格依据，须原样解释给用户。若 patternFacts.special 给出变格候选，须先复核(从格须日主无有力之根且印比虚浮受制；专旺须满盘一气成势)，复核不成立要写明「不按变格论，仍以正格X取用」。\n'
  + '2. 旺衰：直接采用 natal.strengthScore.label，不得改判。其算法：助身方(比劫+印)与克泄耗方(食伤+财+官杀)分别累加——天干每透一位 6 分(月干 9 分)；地支藏干按本气 10 / 中气 5 / 余气 3；月支只对日主自己的通根再乘 2(提纲秉令只增益日主之气，不给财官加倍)；最后按日主在该支的十二长生调整通根之力(帝旺×1.4、死绝则不为根)。index=(support-drain)/(support+drain)×100，>=25 身强、<=-25 身弱，其间为中和偏旺/偏弱。inSeason＝月支是日主的禄或刃之地(甲乙禄寅、丙戊禄巳、庚辛禄申、壬癸禄亥；甲卯丙戊午庚酉壬子为阳刃)，被邻支冲则破令不算得令。monthHasSupport 只表示月支藏干里出现过印比(含中余气)，不等于得令，勿混用。\n'
  + '3. explanation 必须以【身强身弱与喜忌】开头，随后按顺序各出现一次【健康】【事业】【财运】【爱情】(不得合并、省略或改名)，末尾可加【总评/行为建议】。\n'
  + '4. 【身强身弱与喜忌】一段必须引用 strengthScore 的数字与明细来写，至少包含：得令与否(inSeason)、助身方得分(support)与克泄耗方得分(drain)、净分(index)与档位(label)；再点出命局最关键的病处(如某十神太旺/太弱、何物伤格)。禁止只写「日主偏弱」这类无数据结论。\n'
  + '5. 喜忌推导规则(通则，须写明所依通则)：身弱→喜印比、忌克泄耗；身强→喜克泄耗、忌印比；中和偏旺/偏弱→以调候与通关需要为主，兼顾抑扬。若格局本身另有要求(如阳刃喜官杀制、建禄喜财官、从格须顺势、专旺须顺生)，以格局要求优先并在文中说明为何与扶抑通则一致或冲突。\n'
  + '6. usefulElements / avoidElements 只能填 木/火/土/金/水 五项中的若干项，且必须与第 5 条推出的喜忌一致，不得凭印象填写。\n'
  + '7. 每个主题内部必须分点：每条单独一行、行首用 1. 2. 3. 编号，一句话一条，禁止整段连排。禁止在 JSON 顶层重复输出 overall/health/career/wealth/love/notice 等字段，也不要先给短句摘要再写长文。';

const OVERVIEW_PREFIX = '你是资深子平命理师，现在做「全盘总结」。下面给出的是【已经算好的结论】：本命喜忌、以及未来十年的大运/流年/流月逐段批断要点。你的任务不是重新推算，也不是复述每一段，而是横向比较这些结论，挑出真正值得当事人注意的时间节点并说明理由。严格依据给定材料作答，禁止自行补充材料里没有的干支或事件；禁止输出注释或代码块/围栏标记，只给最终正文。用 JSON(仅 JSON)返回，schema：{"title":"古风四字或对仗标题(可选)","explanation":长文}。explanation 必须依次各出现一次【核心结论】【值得关注的时间节点】【行动建议】，顺序一致，不得合并、省略或改名。其中【值得关注的时间节点】是本文重点，要求：1. 按重要程度排序，每条单独一行、行首用 1. 2. 3. 编号；2. 每条写成「年份(或大运段) + 干支 + 为什么值得关注(引材料中的刑冲克害/喜忌依据) + 一句话怎么办」；3. 至少区分「机会窗口」与「风险窗口」两类，各自点明；4. 材料里若某年标注了六冲/三刑/六害等重大作用，必须纳入；5. 只写材料支持得起的结论，宁少勿滥，不要逐年流水账。【核心结论】用 2-4 条概括命局主线与该十年大势；【行动建议】用 2-4 条给出跨年份可执行的通用做法(贴合喜用五行，不重复时间节点里的原话)。全篇简体中文，每个主题内部一条一句，禁止整段连排。';

const ADJUST_PREFIX = '你是资深子平命理师。根据【本命结论】的喜用五行与下方【资料库】中对应五行的后天调整/职业知识，输出该命局的【后天调整】与【事业职业适配】建议(长文，贴合资料，不要另造体系)。'
  + '禁止输出注释或代码块，只给最终正文。JSON schema：{"explanation":长文}，explanation 必须依次各出现一次【后天调整】【事业适配】【健康注意】(不得合并、省略或改名)。'
  + '\n\n# 判定标准(硬性)\n'
  + '1. 一切建议必须由 natal.strengthScore / natal.patternFacts 给出的喜用五行推导出来，不得另立体系、不得假设未给出的事实。\n'
  + '2. 【后天调整】按方位、颜色、行业属性、日常作息分条；【事业适配】给出适配岗位类型与不宜方向各至少一条，并说明与喜用的对应关系；【健康注意】只谈体质倾向与调养方向，不下诊断、不给具体病名断言。\n'
  + '3. 每个主题内部必须分点：每条单独一行、行首 1. 2. 3. 编号，一句话一条，禁止整段连排。';

export async function browserDirect(record: BaziRecord, task?: BaziAnalysisTask, opts: AnalyzeOptions & { secret?: string } = {}): Promise<DeepSeekResult> {
  const nonAi = record.nonAiResult;
  // 神煞压缩为「名称@柱位」：与服务器/桌面端同一口径(实测省约 89% 体积)
  const compactShenSha = (shenSha: NonAiChart['shenSha'] | undefined) => {
    if (!shenSha) return undefined;
    const pillarNames = ['年', '月', '日', '时'];
    const items = Array.isArray(shenSha.items)
      ? shenSha.items.map((item) => item.name + '@' + (pillarNames[item.pillarIndex] ?? '?') + (item.position === '天干' ? '干' : '支'))
      : [];
    return { 吉: shenSha.auspicious ?? [], 凶: shenSha.inauspicious ?? [], 明细: items };
  };
  // 把与本期干支相关的命中压成可读串，供【刑冲克害批注】逐条引用(与服务器/桌面端一致)
  const summarizeHits = (row: unknown, ownGanZhi: string): string[] => {
    const details = (row as { relationshipDetails?: unknown } | undefined)?.relationshipDetails;
    if (!Array.isArray(details) || !ownGanZhi) return [];
    const labels: Record<string, string> = { sanHe: '三合', liuHe: '六合', chong: '六冲', xing: '相刑', hai: '六害', po: '六破', ke: '相克' };
    const out: string[] = [];
    for (const item of details as Array<Record<string, unknown>>) {
      const sp = String(item?.sourcePillar ?? ''); const tg = String(item?.targetPillar ?? ''); const st = String(item?.status ?? '');
      if (sp === ownGanZhi || tg === ownGanZhi || (!sp && !tg)) {
        const other = tg === ownGanZhi ? sp : tg;
        const extra = st === 'half-combination' ? '半合' : st === 'partial-punishment' ? '半刑' : '';
        out.push((labels[String(item?.type)] ?? String(item?.type)) + (other ? '(' + other + ')' : '') + extra);
      }
    }
    return [...new Set(out)].sort();
  };
  const gzOf = (row: unknown): string => (row && typeof row === 'object' ? String((row as { ganZhi?: unknown }).ganZhi ?? '') : '');
  const natal = {
    pillars: { year: record.yearPillar, month: record.monthPillar, day: record.dayPillar, hour: record.hourPillar },
    dayMaster: nonAi?.dayMaster, zodiac: nonAi?.zodiac, solarDate: nonAi?.solarDate,
    elements: nonAi?.elements, tenGods: nonAi?.tenGods, hiddenStems: nonAi?.hiddenStems,
    // 引擎算定的格局与旺衰：模型只解读不重判(与服务器/桌面端同口径)
    patternFacts: nonAi?.patternFacts, strengthScore: nonAi?.strengthScore,
    shenSha: compactShenSha(nonAi?.shenSha), relationships: nonAi?.relationships,
  };
  // 存储是瘦身过的(流年/流月/大运数组落库即清空)，因此必须优先采用任务自带的内联行，
  // 否则离线直连会发出空的「本时段数据」——模型拿不到本期干支，只能凭空编。与服务器/桌面端口径一致。
  const hasGz = (row: unknown): boolean => !!(row && typeof row === 'object' && typeof (row as { ganZhi?: unknown }).ganZhi === 'string' && (row as { ganZhi: string }).ganZhi.length > 0);
  const scope: Record<string, unknown> = {};
  const y = task?.year;
  if (y !== undefined) {
    if (task?.type !== 'decade') scope.age = y - record.birthYear;
    const annual = hasGz(task?.annual) ? task!.annual : (nonAi?.annualFortunes ?? []).find((row) => row.year === y);
    if (annual) { scope.annual = annual; scope.annualHits = summarizeHits(annual, gzOf(annual)); }
    const decade = hasGz(task?.decade) ? task!.decade : (nonAi?.greatFortunes ?? []).find((row) => y >= row.startYear && y <= row.endYear);
    if (decade) { scope.decade = decade; scope.decadeHits = summarizeHits(decade, gzOf(decade)); }
    if (task?.month !== undefined) {
      const monthly = hasGz(task?.monthly) ? task!.monthly : (nonAi?.monthlyFortunes ?? []).find((row) => row.year === y && row.month === task.month);
      if (monthly) { scope.monthly = monthly; scope.monthlyHits = summarizeHits(monthly, gzOf(monthly)); }
    }
  }
  const isOverview = task?.type === 'overview';
  const isAdjustment = task?.type === 'adjustment';
  const isBaselineTask = !task || task.type === 'baseline';
  const scopeTypes = !task || task.type === 'annual' || task.type === 'monthly' || task.type === 'decade';
  const when = isOverview ? '全盘总结：未来十年中值得关注的节点'
    : isAdjustment ? '后天调整与职业适配'
    : task?.type === 'annual' ? String(task.year) + '年'
    : task?.type === 'monthly' ? String(task.year) + '年' + String(task.month) + '月'
    : task?.type === 'decade' ? '所处大运(含 ' + String(task.year) + ' 年)'
    : '本命';
  // 公共前缀一律取模块级常量(逐字节一致)，可变内容按「变化频率从低到高」追加在后面。
  const instruction = isBaselineTask ? BASELINE_PREFIX : isAdjustment ? ADJUST_PREFIX : isOverview ? OVERVIEW_PREFIX : SCOPE_PREFIX;
  const toneText = OUTPUT_RULES_TEXT + '\n\n# 语气要求(必须按此措辞把握全篇)\n' + toneInstructionText(opts.tone);
  const natalBlock = '\n\n# 本命事实数据(JSON，只依据此数据)\n' + JSON.stringify(natal);
  const summaryOf = () => String((task?.baseline as { summary?: string } | undefined)?.summary ?? '');
  let content: string;
  if (isBaselineTask) {
    content = instruction + natalBlock + toneText;
  } else if (isAdjustment) {
    content = instruction
      + '\n\n# 本命结论(引擎已定，必须沿用，不得重算)\n' + summaryOf()
      + natalBlock + toneText
      + '\n\n# 资料库(喜用五行)\n' + JSON.stringify(task?.guide ?? {})
      + '\n\n# 当前分析目标\n' + when;
  } else if (isOverview) {
    content = instruction + natalBlock + toneText
      + '\n\n# 本命结论(引擎已定，必须沿用，不得重算)\n' + summaryOf()
      + '\n\n# 各时段分析要点(JSON)\n' + JSON.stringify(task?.findings ?? {})
      + '\n\n# 当前分析目标\n' + when;
  } else if (scopeTypes) {
    // 年度段在前、月度段在后：同一公历年的流年与该年各流月共享到年度段末尾的长前缀。
    const yearPart: Record<string, unknown> = {};
    for (const k of ['annual', 'decade', 'annualHits', 'decadeHits']) if (scope[k] !== undefined) yearPart[k] = scope[k];
    // 「年龄」属于该期事实，流年放年度段、流月放月度段；大运不带年龄。
    if (scope.age !== undefined && task?.type !== 'decade' && task?.month === undefined) yearPart.age = scope.age;
    const monthPart: Record<string, unknown> = {};
    if (task?.month !== undefined) {
      for (const k of ['monthly', 'monthlyHits']) if (scope[k] !== undefined) monthPart[k] = scope[k];
      if (scope.age !== undefined) monthPart.age = scope.age;
    }
    const note = summaryOf();
    content = instruction + natalBlock + toneText
      + (note ? '\n\n# 本命结论(引擎已定，必须沿用，不得重算或推翻)\n' + note : '')
      + '\n\n# 本年度运势数据(JSON)\n' + JSON.stringify(yearPart)
      + (task?.month !== undefined ? '\n\n# 本月运势数据(JSON)\n' + JSON.stringify(monthPart) : '')
      + '\n\n# 当前分析目标\n' + when;
  } else {
    content = instruction + natalBlock + toneText;
  }
  // 按“当前使用通道 → 其余已配置通道”依次尝试；每个通道用各自的端点/模型/参数
  const errors: string[] = [];
  for (const channel of channelOrder()) {
    const secret = opts.secret ?? getBrowserCredential(channel.id);
    if (!secret) { errors.push(channel.label + '：未配置凭据'); continue; }
    const payload: Record<string, unknown> = { model: channel.model, max_tokens: 32768, messages: [
      { role: 'system', content: SYSTEM_SCOPE },
      { role: 'user', content },
    ] };
    if (channel.id === 'deepseek') payload.reasoning_effort = (isBaselineTask || isAdjustment || isOverview) ? 'high' : 'low';
    if (channel.disableThinking) payload.enable_thinking = false;
    if (channel.temperature !== undefined) payload.temperature = channel.temperature;
    try {
      const res = await fetch(channel.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret }, body: JSON.stringify(payload), signal: opts.signal });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        errors.push(channel.label + '：' + classifyFailure(res.status, errText) + '（HTTP ' + res.status + '）');
        continue;
      }
      const body = await res.json();
      const raw = String(body?.choices?.[0]?.message?.content ?? '').trim();
      if (!raw) { errors.push(channel.label + '：上游返回空正文（可能被内容过滤或达到输出上限）'); continue; }
      const cleaned = raw.replace(/^```json?\\s*/i, '').replace(/```\\s*$/, '');
      try { return { status: 'completed', analysis: JSON.parse(cleaned) as BaziAIAnalysis }; }
      catch { errors.push(channel.label + '：输出不是合法 JSON'); continue; }
    } catch (error) {
      if (opts.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return abortResult();
      const msg = error instanceof Error ? error.message : '请求失败';
      errors.push(channel.label + '：' + (/abort|timeout|timed out/i.test(msg) ? '网络超时或不可达' : msg));
    }
  }
  return { status: 'failed', error: errors.join('；') || '没有可用的通道凭据，请先在设置里配置' };
}