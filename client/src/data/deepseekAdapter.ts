import type { BaziRecord, BaziAIAnalysis, BaziAnalysisTask, BaziTaskResult, NonAiChart } from '../types/domain';
import { invoke } from '@tauri-apps/api/core';
import { getBrowserCredential } from './aiSettings';
import { isServerMode, runTaskOnServer, ServerError } from './serverClient';
import { countElements } from '../features/chart/elements';

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
  const selected = forced ?? (() => { try { return localStorage.getItem('mingli.provider') ?? 'qwen'; } catch { return 'qwen'; } })();
  const head = CHANNELS.filter((c) => c.id === selected);
  return [...head, ...CHANNELS.filter((c) => c.id !== selected)];
}

/** 阿里云百炼「上下文缓存」的最小可缓存前缀(约 1024 token)。中文近似一字一 token，
 *  低于它这次请求不可能建起缓存，打标只是白付 1.25 倍的建缓存费。 */
const QWEN_CACHE_MIN_CHARS = 1000;

/** Qwen 通道的显式缓存标记：content 从字符串换成数组段，并在段上打 cache_control。
 *  其它通道原样返回字符串 —— DeepSeek/Kimi 不认这个字段，改了反而可能被拒。
 *  注意这是**请求体包装**，不改动提示词正文本身，所以三通道提示词逐字节一致的约束不受影响。 */
function qwenCacheableContent(channel: ChannelSpec, content: string): unknown {
  if (channel.id !== 'qwen' || content.length < QWEN_CACHE_MIN_CHARS) return content;
  return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
}

/** 系统提示词：全通道共用同一条，逐字节一致(前缀缓存的第一层)。 */
const SYSTEM_SCOPE = '请把思考压缩到最短，直接输出符合要求的简体中文 JSON 正文；全篇不得出现繁体字。';

/* ── 提示词分段顺序：显式缓存命中率的唯一来源，改动前先读这段 ──────────────────────
 * 百炼的上下文缓存按「从 messages 开头到 cache_control 标记为止」整段做 key，所以命中率
 * 完全取决于各段**从哪一行开始分叉**。实测数字见 __tests__/qwen-prefix-measure.test.ts。
 * 排列原则：**跨任务恒定的内容一律排在会变化的内容之前**，且恒定段彼此相邻、不被可变段隔开。
 *   · 全任务共用(实测 1714 字，占最短全文 49%)：natalBlock(# 本命事实数据 + natal) → 任务指令。
 *     natalBlock 用同一个标题拼在指令之前，本命/流年/流月/大运四类任务因此共享这一整段；
 *     旧写法把各自不同的任务指令放在 natal 前面，公共前缀只剩 9 个字，等于每条任务各建一块缓存。
 *   · 从任务指令这一行开始分叉：BASELINE/SCOPE/OVERVIEW/ADJUST 四种指令文本互不相同。
 *     SYSTEM_SCOPE、输出硬性要求与语气要求都在分叉点之后，只有同一种指令的任务能共享，
 *     所以不能把它们前移到 natal 之前 —— 那里必须只放跨类型恒定的内容。
 *   · 分叉之后再排可变性递增的内容：本命结论摘要(同时段全部相同) → 年度段(同年相同)
 *     → 月度段(仅流月) → 目标行(每条都不同)。
 *   · SYSTEM_SCOPE 是独立的一条 system 消息，排在 user 正文之前且全通道逐字节相同，因此它也在
 *     这段公共前缀里(实测的 1714 字只算了 user 正文)。
 * 「延续之前的变动放最后」这条原则仍然成立，只是范围缩小到分叉点以后：那里已没有可再前移的
 * 恒定内容。若把任何可变段挪回前面，或让 natalBlock/toneText 的标题与拼装顺序在各分支间不
 * 一致，公共前缀立刻塌回几十个字 —— 测试会失败并指出是哪一对请求断的。*/

/** 指令段与输出要求之间的固定分隔标题：本身不随任务变化，用来把两端切开并保住前面的公共前缀。 */
export const INSTRUCTION_TAIL_MARK = '\n\n# 输出硬性要求(违反即整篇作废重写)\n';
/** natal 块的固定标题：内容随命盘不同，但同一命盘在四类任务里逐字节相同，所以公共前缀从它开始。 */
export const NATAL_BLOCK_HEAD = '\n\n# 本命事实数据(JSON，只依据此数据)\n';
/** 语气段标题：两端各写一份措辞文本，但标题必须一致，测试用它切开「恒定尾巴」。 */
export const TONE_HEAD = '\n\n# 语气要求(必须按此措辞把握全篇)\n';
/** 输出硬性要求：与任务类型无关的公共约束，紧跟上面的标题、排在语气要求之前。 */
export const OUTPUT_RULES_TEXT = '1. 全篇一律使用简体中文(UTF-8)，禁止任何繁体字、异体字混入。\n'
  + '2. explanation 的【】小节必须按本任务规定逐段出现、各只出现一次，顺序一致，不得合并、省略或改名。\n'
  + '3. 每个小节至少 1 条编号要点；每条单独一行、行首用 1. 2. 3. 编号，一句话一条，禁止整段连排。\n'
  + '4. 禁止输出注释、代码块或任何围栏标记，只给最终正文。\n'
  + '5. 正文只写中文，不得出现任何英文单词、英文字母缩写、拼音或英文字段代号；拉丁字母一个都不许有，数字也一律用中文数字表述。'
  + '事实数据里凡是形如拉丁字母连写的键名，都只是数据结构的内部代号，你要做的是把它对应的「数值与含义」用中文讲出来，绝不可把这个代号本身抄进正文。'
  + '凡是描述「是否得令」「月支藏干有无印比」「助身方得分」「克泄耗方得分」「净分」「档位」这类结论，一律用中文词组直接表述：'
  + '得令与否写成「月支是/不是日主禄刃之地，得令/不得令」；月支藏干有无印比写成「月支藏干中见/未见印比，有/无通根之助」；'
  + '不能用英文词加上括号注音，也不能在中文后面缀上英文取值。';

export const SCOPE_PREFIX = '你是资深子平命理师，仅分析时段运势。严格依据下方【事实数据(JSON)】作答，禁止自行推算干支、十神、五行或关系。'
  + '禁止输出注释或代码块/围栏标记，只给最终正文。本命格局与旺衰已由引擎算定并写在【事实数据】的「格局事实」「旺衰评分」里，你不得重判、不得改口径；本期吉凶只在既定喜忌下衡量该期干支的作用。'
  + '用 JSON(仅 JSON)返回，schema：{"title":"古风四字或对仗标题(可选)","explanation":长文}。'
  + 'title 只能用干支+四字直书(如：卯戌六合·和合之象)或古典口诀风格，不得编造伪古文引文。'
  + 'explanation 必须依次各出现一次【健康】【事业】【财运】【爱情】【刑冲克害批注】，顺序一致，不得合并、省略或改名。'
  + '\n\n# 时段判断标准(硬性)\n'
  + '1. 先读【事实数据】里「旺衰评分」的档位与其中的喜忌方向：本期干支(含大运)属喜用则论顺、属忌神则论逆，生扶与克制关系以【事实数据】的「藏干」和「本期命中的刑冲合害」为准，禁止自造五行关系。\n'
  + '2. 【刑冲克害批注】只依据【事实数据】里本期流年、流月、大运各自命中的刑冲合害逐条编号，每行格式：数字. 关系（干支实例）：一句影响，例如 1. 三合（巳酉丑半合）：…；若没有任何命中则写一条：1. 本期无重大刑冲克害（仅提示）。不得把本命已有的刑冲合害之说成本期新发生的作用。\n'
  + '3. 四个主题(健康/事业/财运/爱情)每段至少 1 条编号要点，须点明「本期相对本命是加力还是减力」并给出依据(哪个十神、什么作用)。\n'
  + '4. 各主题全文只出现一次，禁止先短句后长文重复两遍。每个主题内部必须分点陈述：每条单独一行、行首用 1. 2. 3. 编号，一句话一条，不要整段连排。\n'
  // 大运的年份区间来自引擎的起运推算；不写这条，模型会按「十年一运」想当然地报岁数。
  + '5. 提到大运时段与年龄时，必须照【本命事实数据】里「起运」一项与各柱起始/结束年份的原值说(如「X 年起入某运」)，不得自行换算起运年龄、不得改动区间。';

export const BASELINE_PREFIX = '你是资深子平命理师。严格依据下方【事实数据(JSON)】作答，禁止自行推算干支、十神、五行、藏干或关系。'
  + '当前分析目标：本命。用 JSON(仅 JSON)返回，schema：{"pattern":格局,"strength":身强/身弱/中和偏旺/中和偏弱,"usefulElements":[喜用],"avoidElements":[忌用],"explanation":长文}。'
  // —— 关键口径：格局与旺衰已由引擎按确定算法算出，写在 natal.patternFacts / natal.strengthScore 里，
  //    模型只负责「解读」与「定喜用」，不负责「重判」。这是消除同盘不同答案(命中率)的根本手段。
  + '\n\n# 判定标准(硬性，逐条遵守)\n'
  + '1. 格局：直接采用【事实数据】里「格局事实」给出的格局名，不得另立格局名、不得改写；其中「取格依据」须原样解释给用户。若「格局事实」给出变格候选，须先复核(从格须日主无有力之根且印比虚浮受制；专旺须满盘一气成势)，复核不成立要写明「不按变格论，仍以正格X取用」。\n'
  + '2. 旺衰：直接采用【事实数据】里「旺衰评分」给出的档位，不得改判。其算法：助身方(比劫加印)与克泄耗方(食伤加财加官杀)分别累加——天干每透一位 6 分(月干 9 分)；地支藏干按本气 10 / 中气 5 / 余气 3；月支只对日主自己的通根再乘 2(提纲秉令只增益日主之气，不给财官加倍)；最后按日主在该支的十二长生调整通根之力(帝旺乘 1.4、死绝则不为根)。净分等于(助身方减克泄耗方)除以(助身方加克泄耗方)再乘一百，不低于 25 为身强、不高于负 25 为身弱，其间为中和偏旺或中和偏弱。是否得令＝月支是日主的禄或刃之地(甲乙禄寅、丙戊禄巳、庚辛禄申、壬癸禄亥；甲卯丙戊午庚酉壬子为阳刃)，被邻支冲则破令不算得令。月支藏干有无印比，只表示月支藏干里出现过印比(含中余气)，不等于得令，勿混用。(以上所述算法仅为帮助你理解口径，正文里一律用中文讲结论，任何拉丁字母都不许出现。)\n'
  + '3. explanation 必须以【身强身弱与喜忌】开头，随后按顺序各出现一次【健康】【事业】【财运】【爱情】(不得合并、省略或改名)，末尾可加【总评/行为建议】。\n'
  + '4. 【身强身弱与喜忌】一段必须引用旺衰的数字与明细来写，至少包含：是否得令、助身方得分、克泄耗方得分、净分与档位；再点出命局最关键的病处(如某十神太旺/太弱、何物伤格)。禁止只写「日主偏弱」这类无数据结论。\n'
  + '5. 喜忌推导规则(通则，须写明所依通则)：先以扶抑定纲(身弱→喜印比、忌克泄耗；身强→喜克泄耗、忌印比)；再看【事实数据】中那条以季节(春/夏/秋/冬)起首、注明「调候」与「穷通宝鉴…参考」的字段：命局气候偏枯(生于严冬而局中火弱、或生于盛夏而局中水亏)时，调候优先于扶抑，据此微调喜忌并写明「从调候」；该项标注「非急」(多应在春秋)时，调候只作辅助印证，喜忌仍以扶抑与格局为准。凡该字段标注「参考」者，系《穷通宝鉴》按季节归并之论，两源或有出入，不得当作唯一结论。格局本身另有要求者(阳刃喜官杀制、建禄喜财官、从格须顺势、专旺须顺生)，以格局优先并说明与上述通则是否一致。\n'
  + '6. usefulElements / avoidElements 只能填 木/火/土/金/水 五项中的若干项，且必须与第 5 条推出的喜忌一致，不得凭印象填写。\n'
  + '7. 每个主题内部必须分点：每条单独一行、行首用 1. 2. 3. 编号，一句话一条，禁止整段连排。禁止在 JSON 顶层重复输出 overall/health/career/wealth/love/notice 等字段，也不要先给短句摘要再写长文。';

export const OVERVIEW_PREFIX = '你是资深子平命理师，现在做「全盘总结」。下面给出的是【已经算好的结论】：本命喜忌、以及未来十年的大运/流年/流月逐段批断要点。你的任务不是重新推算，也不是复述每一段，而是横向比较这些结论，挑出真正值得当事人注意的时间节点并说明理由。严格依据给定材料作答，禁止自行补充材料里没有的干支或事件；禁止输出注释或代码块/围栏标记，只给最终正文。用 JSON(仅 JSON)返回，schema：{"title":"古风四字或对仗标题(可选)","explanation":长文}。explanation 必须依次各出现一次【核心结论】【值得关注的时间节点】【行动建议】，顺序一致，不得合并、省略或改名。其中【值得关注的时间节点】是本文重点，要求：1. 按重要程度排序，每条单独一行、行首用 1. 2. 3. 编号；2. 每条写成「年份(或大运段) + 干支 + 为什么值得关注(引材料中的刑冲克害/喜忌依据) + 一句话怎么办」；3. 至少区分「机会窗口」与「风险窗口」两类，各自点明；4. 材料里若某年标注了六冲/三刑/六害等重大作用，必须纳入；5. 只写材料支持得起的结论，宁少勿滥，不要逐年流水账。【核心结论】用 2-4 条概括命局主线与该十年大势；【行动建议】用 2-4 条给出跨年份可执行的通用做法(贴合喜用五行，不重复时间节点里的原话)。全篇简体中文，每个主题内部一条一句，禁止整段连排。';

export const ADJUST_PREFIX = '你是资深子平命理师。根据【本命结论】的喜用五行与下方【资料库】中对应五行的后天调整/职业知识，输出该命局的【后天调整】与【事业职业适配】建议(长文，贴合资料，不要另造体系)。'
  + '禁止输出注释或代码块，只给最终正文。JSON schema：{"explanation":长文}，explanation 必须依次各出现一次【后天调整】【事业适配】【健康注意】(不得合并、省略或改名)。'
  + '\n\n# 判定标准(硬性)\n'
  + '1. 一切建议必须由【事实数据】里「旺衰评分」与「格局事实」给出的喜用五行推导出来，不得另立体系、不得假设未给出的事实。\n'
  + '2. 【后天调整】按方位、颜色、行业属性、日常作息分条；【事业适配】给出适配岗位类型与不宜方向各至少一条，并说明与喜用的对应关系；【健康注意】只谈体质倾向与调养方向，不下诊断、不给具体病名断言。\n'
  + '3. 每个主题内部必须分点：每条单独一行、行首 1. 2. 3. 编号，一句话一条，禁止整段连排。';

export type PromptTaskKind = 'baseline' | 'annual' | 'monthly' | 'decade' | 'overview' | 'adjustment';

/** 只拼装、不发请求：给定任务类型返回这条任务真实会发出的 user 正文(与 browserDirect 同一个函数)。
 *  专供跨通道一致性测试使用 —— 服务器侧 buildTaskPayload 的正文必须与之同源。
 *  anchor 是本命结论摘要：真实流程里由 task-01 的结果注入，测试按同一形状传入。 */
export function buildTaskPromptText(record: BaziRecord, kind: PromptTaskKind, year: number, month?: number, tone?: number, anchor?: string): string {
  const task: BaziAnalysisTask = {
    taskId: 'probe', type: kind, year,
    ...(month !== undefined ? { month } : {}),
    ...(anchor !== undefined ? { baseline: { summary: anchor } as never } : {}),
  };
  return assembleUserContent(record, task, tone).content;
}

/** natal 里跨通道必须同序的键：服务器多带了 gender/birthYear/lunarDate/elementRatio/naYin/
 *  twelveLongevity，两端只比「共有键的相对顺序」；这份清单与 promptSeams.mts 取样器同源。 */
export const NATAL_SHARED_KEYS = ['pillars', 'dayMaster', 'zodiac', 'solarDate', 'elements', 'tenGods', 'hiddenStems', 'patternFacts', 'strengthScore', 'tiaohouFacts', 'luckStart', 'shenSha', 'relationships'];

/** 拆成「跨通道应逐字节相同」的几段：natal 标题/共有键顺序 + 任务指令 + 输出硬性要求 + 语气标题。
 *  供 prompt-parity 测试比对两端**真实拼出的正文**，而不是只比常量定义(常量抄对了、但拼装顺序
 *  各写一份也能被拦下)。natal 的 JSON 取值本身不比：服务器多带了几项，两端只比「标题 + 共有键顺序」。 */
export function buildPromptSharedSeams(record: BaziRecord, kind: PromptTaskKind, year: number, month?: number) {
  const task: BaziAnalysisTask = { taskId: 'probe', type: kind, year, ...(month !== undefined ? { month } : {}) };
  const content = assembleUserContent(record, task).content;
  const start = content.indexOf(NATAL_BLOCK_HEAD);
  const toneAt = content.indexOf(TONE_HEAD);
  if (start < 0 || toneAt < 0) throw new Error('拼装结果缺少 natal 或语气标题，分段顺序被改坏了');
  const instruction = kind === 'baseline' ? BASELINE_PREFIX : kind === 'adjustment' ? ADJUST_PREFIX : kind === 'overview' ? OVERVIEW_PREFIX : SCOPE_PREFIX;
  const instrStart = content.indexOf(instruction.slice(0, 24), start);
  const rulesAt = content.indexOf(INSTRUCTION_TAIL_MARK, instrStart);
  if (instrStart < 0 || rulesAt < 0) throw new Error('拼装结果里找不到本任务的指令起点');
  const jsonText = content.slice(start + NATAL_BLOCK_HEAD.length, instrStart);
  const keys = Object.keys(JSON.parse(jsonText));
  return {
    natalHead: content.slice(start, start + NATAL_BLOCK_HEAD.length),
    // 过滤即断言：客户端natal若多出清单外的键，公共前缀会在服务器对不上的位置分叉
    natalKeys: keys.filter((k) => NATAL_SHARED_KEYS.includes(k)),
    instruction: content.slice(instrStart, rulesAt),
    rules: content.slice(rulesAt, toneAt),
    toneText: content.slice(toneAt),
  };
}

export async function browserDirect(record: BaziRecord, task?: BaziAnalysisTask, opts: AnalyzeOptions & { secret?: string } = {}): Promise<DeepSeekResult> {
  // 是否有任何一个通道填了凭据：决定「全部跳过」算未配置还是真失败(见函数末尾)。
  const anyCredential = opts.secret !== undefined || channelOrder().some((c) => !!getBrowserCredential(c.id));
  // 按“当前使用通道 → 其余已配置通道”依次尝试；每个通道用各自的端点/模型/参数
  // 按“当前使用通道 → 其余已配置通道”依次尝试；每个通道用各自的端点/模型/参数
  const { content, isBaselineTask, isAdjustment, isOverview } = assembleUserContent(record, task, opts.tone);
  const errors: string[] = [];
  for (const channel of channelOrder()) {
    const secret = opts.secret ?? getBrowserCredential(channel.id);
    if (!secret) { errors.push(channel.label + '：未配置凭据'); continue; }
    const payload: Record<string, unknown> = { model: channel.model, max_tokens: 32768, messages: [
      { role: 'system', content: SYSTEM_SCOPE },
      // Qwen 显式缓存：从 messages 开头到此标记为止的前缀会被做成缓存块，命中部分按输入价一折
      // 计费(新建那次 1.25 倍)。命中的前提是这段前缀**逐字节相同** —— 实测(qwen-prefix-measure.test.ts)
      // 一轮任务彼此共享 ≈1714 字全局公共前缀(natal + 各自指令之前的那一段)，同年流月与流年几乎整篇相同，
      // 所以除第一条建缓存外全部命中。不打标记时走隐式缓存(命中率由平台决定)；打了就强制显式轨，短内容宁可不打。
      { role: 'user', content: qwenCacheableContent(channel, content) },
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
  // 三个通道一个都没填凭据：这是「未配置」，不是「分析失败」。旧实现在这里也返回
  // failed，于是详情页挂着「余额不足/限流/网络超时」那一大段误导文案，还白跑两轮自动
  // 重试(重试判定只看错误文本)，用户对着一个根本没配密钥的界面找密钥之外的原因。
  if (!anyCredential) return { status: 'not_configured', error: errors.join('；') || '没有可用的通道凭据，请先在设置里配置' };
  return { status: 'failed', error: errors.join('；') || '没有可用的通道凭据，请先在设置里配置' };
}

/** 按「提示词分段顺序」拼出某条任务的 user 正文。单独成函数是为了让测试能只拼装、不发请求，
 *  直接拿它与服务器侧 buildTaskPayload 的正文比对 —— 两条路径不同源时，同一命盘会给出不同口径。 */
function assembleUserContent(record: BaziRecord, task?: BaziAnalysisTask, tone?: number) {
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
    // 五行计数按四柱现算，不取库里的存量数字：存储可能来自旧口径引擎，
    // 让模型数到「木+1 水-1」的假配比，比不给这项更糟。
    elements: countElements([record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar]).elements,
    tenGods: nonAi?.tenGods, hiddenStems: nonAi?.hiddenStems,
    // 引擎算定的格局与旺衰：模型只解读不重判(与服务器/桌面端同口径)
    patternFacts: nonAi?.patternFacts, strengthScore: nonAi?.strengthScore,
    // 调候：引擎按日主与月令季节算定的中文字符串(辅助判据)。与服务器 natal 同序：
    //      紧随 strengthScore、先于 luckStart，否则跨通道公共前缀分叉(见 prompt-parity)。
    tiaohouFacts: nonAi?.tiaohouFacts,
    luckStart: nonAi?.luckStart,
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
  // 缓存前缀只取决于「从哪一行开始分叉」，所以下面每个分支都必须以
  // natalBlock + instruction + toneText 开头(顺序与标题不许各分支各写一份)，
  // 之后才按「变化频率从低到高」追加可变内容。
  const instruction = isBaselineTask ? BASELINE_PREFIX : isAdjustment ? ADJUST_PREFIX : isOverview ? OVERVIEW_PREFIX : SCOPE_PREFIX;
  const toneText = INSTRUCTION_TAIL_MARK + OUTPUT_RULES_TEXT + TONE_HEAD + toneInstructionText(tone);
  const natalBlock = NATAL_BLOCK_HEAD + JSON.stringify(natal);
  const summaryOf = () => String((task?.baseline as { summary?: string } | undefined)?.summary ?? '');
  let content: string;
  if (isBaselineTask) {
    content = natalBlock + instruction + toneText;
  } else if (isAdjustment) {
    content = natalBlock + instruction + toneText
      + '\n\n# 本命结论(引擎已定，必须沿用，不得重算)\n' + summaryOf()
      + '\n\n# 资料库(喜用五行)\n' + JSON.stringify(task?.guide ?? {})
      + '\n\n# 当前分析目标\n' + when;
  } else if (isOverview) {
    content = natalBlock + instruction + toneText
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
    content = natalBlock + instruction + toneText
      + (note ? '\n\n# 本命结论(引擎已定，必须沿用，不得重算或推翻)\n' + note : '')
      + '\n\n# 本年度运势数据(JSON)\n' + JSON.stringify(yearPart)
      + (task?.month !== undefined ? '\n\n# 本月运势数据(JSON)\n' + JSON.stringify(monthPart) : '')
      + '\n\n# 当前分析目标\n' + when;
  } else {
    content = natalBlock + instruction + toneText;
  }
  return { content, isBaselineTask, isAdjustment, isOverview };
}

/* ---------- 聊天直连(排盘页「问问 AI」备用通道)：纯文本输出，不要求 JSON ---------- */
export type ChatDirectResult = { status: 'completed'; answer: string } | { status: 'failed' | 'not_configured'; error?: string };

export async function chatDirect(messages: Array<{ role: string; content: string }>, opts: { signal?: AbortSignal } = {}): Promise<ChatDirectResult> {
  const errors: string[] = [];
  let hasCredential = false;
  // 与任务通道同一回退顺序：当前使用通道 → 其余已配置通道
  for (const channel of channelOrder()) {
    const secret = getBrowserCredential(channel.id);
    if (!secret) { errors.push(channel.label + '：未配置凭据'); continue; }
    hasCredential = true;
    const payload: Record<string, unknown> = { model: channel.model, max_tokens: 8192, messages: messages.map((m) => (
      m.role === 'user' ? { ...m, content: qwenCacheableContent(channel, String(m.content ?? '')) } : m
    )) };
    if (channel.id === 'deepseek') payload.reasoning_effort = 'high'; // 聊天走思考模式，答复更有依据
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
      const raw = String(body?.choices?.[0]?.message?.content ?? '').trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
      if (!raw) { errors.push(channel.label + '：上游返回空正文'); continue; }
      return { status: 'completed', answer: raw };
    } catch (error) {
      if (opts.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return { status: 'failed', error: '已取消' };
      const msg = error instanceof Error ? error.message : '请求失败';
      errors.push(channel.label + '：' + (/abort|timeout|timed out/i.test(msg) ? '网络超时或不可达' : msg));
    }
  }
  return { status: hasCredential ? 'failed' : 'not_configured', error: errors.join('；') || '没有可用的通道凭据，请先在设置里配置' };
}