/* =============================================================================
 * 排盘页 AI 聊天引擎 —— 提问理解 → 查库取证 → 思考回答(三通道)
 *
 * 通道策略与批量分析一致：
 *  1) 服务器模式(默认)：POST /api/chat，由服务器查 SQLite(账号隔离、索引命中)；
 *     本机若已有该盘完整数据(引擎现算的流年/流月/大运行)，随请求附带 periodFacts，
 *     补上服务器「瘦身存储不含时段数组」的缺口。
 *  2) Tauri 离线：invoke run_ai_chat —— 证据来自本机 SQLite(listBaziRecords)，
 *     答案缓存与调用在 Rust 端(ai_cache + chart_sig 索引，删盘/清缓存一并生效)。
 *  3) 浏览器直连备用：chatDirect 按「当前通道→其余已配置通道」依次尝试。
 *
 * 提问解析(人名/年月/主题)与服务端 chat.mjs 同口径；人名匹配对全部记录做一轮
 * 子串扫描(O(n·len))，记录量大时可预构建姓名索引 —— 见 analyzeQuestion 注释。
 * ========================================================================== */
import { invoke } from '@tauri-apps/api/core';
import type { BaziRecord } from '../types/domain';
import { listBaziRecords } from './clientRepository';
import { isServerMode, serverFetch, ServerError } from './serverClient';
import { chatDirect, toneInstructionText } from './deepseekAdapter';
import { countElements } from '../features/chart/elements';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatPlan { recordId: string | null; personName: string | null; matchedCount: number; year?: number; month?: number; topics: string[] }
export interface ChatEvidence {
  person: { id: string; name: string; gender: string; birthYear: number };
  plan: { year?: number; month?: number; topics: string[] };
  natal: Record<string, unknown>;
  analyses: Array<{ heading: string; text: string }>;
  missing: string[];
  periodFacts?: Record<string, unknown>;
}
export interface ChatReply {
  status: 'completed' | 'failed' | 'not_configured' | 'need_record';
  answer?: string;
  error?: string;
  reason?: string;
  cached?: boolean;
  evidence?: { recordId?: string; personName?: string | null; plan?: ChatPlan; options?: Array<{ id: string; name: string }> };
}

/* ---------- 提问理解(与服务端 chat.mjs 同口径) ---------- */
export const TOPIC_RULES: Array<{ topic: string; re: RegExp }> = [
  { topic: '健康', re: /健康|身体|生病|疾病|养生|体检|精力|疲劳/ },
  { topic: '事业', re: /事业|工作|职业|升职|跳槽|创业|考试|学业|面试|上班|领导/ },
  { topic: '财运', re: /财运|钱财|赚钱|钱|收入|投资|理财|彩票|发财|破财|工资|加薪|生意/ },
  { topic: '爱情', re: /爱情|婚姻|感情|恋|桃花|配偶|对象|离婚|脱单|结婚|相亲|另一半/ },
  { topic: '五行', re: /五行|喜用|用神|忌神|缺[木火土金水]|补[木火土金水]/ },
  { topic: '格局', re: /格局|身强|身弱|从格|专旺|命格/ },
  { topic: '神煞', re: /神煞|贵人|驿马|华盖|羊刃|文昌|空亡|天德|月德|将星|劫煞/ },
  { topic: '大运', re: /大运|运程|这步运|十年/ },
  { topic: '流月', re: /流月|本月|这个月|当月|下个月|下月|上个月|上月|\d{1,2}\s*月/ },
];
const RELATIVE_YEAR: Record<string, number> = { 今年: 0, 明年: 1, 后年: 2, 去年: -1, 前年: -2 };

export function extractWhen(question: string, now = new Date()): { year?: number; month?: number } {
  const q = String(question || '');
  let year: number | undefined; let month: number | undefined;
  const abs = q.match(/(20\d{2})\s*年/);
  if (abs) year = Number(abs[1]);
  if (year === undefined) {
    for (const [word, delta] of Object.entries(RELATIVE_YEAR)) {
      if (q.includes(word)) { year = now.getFullYear() + delta; break; }
    }
  }
  const monthMatch = q.match(/(\d{1,2})\s*月/);
  if (monthMatch) { const m = Number(monthMatch[1]); if (m >= 1 && m <= 12) month = m; }
  else if (/本月|这个月|当月/.test(q)) month = now.getMonth() + 1;
  else if (/下个月|下月|来月/.test(q)) month = now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2;
  else if (/上个月|上月/.test(q)) month = now.getMonth() === 0 ? 12 : now.getMonth();
  if (month !== undefined && year === undefined) year = now.getFullYear();
  return { year, month };
}

/** 检索计划。人名用一轮子串扫描(命中长名优先)；记录很多时可按 name 长度降序提前 break 或预建前缀索引。 */
export function analyzeQuestion(question: string, records: Array<Pick<BaziRecord, 'id' | 'name'>>, now = new Date()): ChatPlan {
  const q = String(question || '');
  const matched: Array<{ id: string; name: string }> = [];
  for (const s of records) {
    const name = String(s.name || '').trim();
    if (name && q.includes(name)) matched.push({ id: s.id, name });
  }
  matched.sort((a, b) => b.name.length - a.name.length);
  const { year, month } = extractWhen(q, now);
  const topics = [...new Set(TOPIC_RULES.filter((rule) => rule.re.test(q)).map((rule) => rule.topic))];
  return { recordId: matched[0]?.id ?? null, personName: matched[0]?.name ?? null, matchedCount: matched.length, year, month, topics };
}

/* ---------- 证据摘录(与服务器 sliceSections 同口径) ---------- */
const SECTION_ALLOW = ['健康', '事业', '财运', '爱情', '刑冲克害批注', '后天调整', '事业适配', '健康注意', '核心结论', '值得关注的时间节点', '行动建议', '身强身弱与喜忌'];
export function sliceSections(text: string, topics: string[], capPer = 700): string {
  const source = String(text || '');
  if (!source) return '';
  const labels = (Array.isArray(topics) ? topics : []).filter((t) => SECTION_ALLOW.includes(t));
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const part of source.split(/(?=【)/)) {
    const m = part.match(/^【([^】]+)】([\s\S]*)/);
    if (!m) continue;
    const label = m[1].trim(); const body = m[2].trim().slice(0, capPer);
    if (labels.length && !labels.some((t) => label.includes(t))) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    blocks.push('【' + label + '】' + body);
  }
  if (blocks.length) return blocks.join('\n');
  return labels.length ? '' : source.slice(0, capPer);
}

const PILLAR_NAMES = ['年', '月', '日', '时'];
function compactShenSha(shenSha: BaziRecord['nonAiResult'] extends infer T ? any : never) {
  if (!shenSha) return undefined;
  const items = Array.isArray(shenSha.items)
    ? shenSha.items.map((item: any) => item.name + '@' + (PILLAR_NAMES[item.pillarIndex] ?? '?') + (item.position === '天干' ? '干' : '支'))
    : [];
  return { 吉: shenSha.auspicious ?? [], 凶: shenSha.inauspicious ?? [], 明细: items };
}
const HIT_LABELS: Record<string, string> = { sanHe: '三合', liuHe: '六合', chong: '六冲', xing: '相刑', hai: '六害', po: '六破', ke: '相克' };
function summarizeHits(row: any, ownGanZhi: string): string[] {
  const details = row?.relationshipDetails;
  if (!Array.isArray(details) || !ownGanZhi) return [];
  const out: string[] = [];
  for (const item of details) {
    const sp = String(item?.sourcePillar ?? ''); const tg = String(item?.targetPillar ?? ''); const st = String(item?.status ?? '');
    if (sp === ownGanZhi || tg === ownGanZhi || (!sp && !tg)) {
      const other = tg === ownGanZhi ? sp : tg;
      const extra = st === 'half-combination' ? '半合' : st === 'partial-punishment' ? '半刑' : '';
      out.push((HIT_LABELS[String(item?.type)] ?? String(item?.type)) + (other ? '(' + other + ')' : '') + extra);
    }
  }
  return [...new Set(out)].sort();
}

/** 时段运势事实：本地库经 hydrateRecord 已还原完整数组，直接取所问年份/月份行。 */
export function buildPeriodFacts(record: BaziRecord, plan: ChatPlan): Record<string, unknown> | undefined {
  const n = record.nonAiResult;
  const y = plan.year;
  if (!n || y === undefined) return undefined;
  const out: Record<string, unknown> = {};
  const annual = (n.annualFortunes ?? []).find((row) => Number(row.year) === Number(y));
  if (annual) { out.annual = annual; out.annualHits = summarizeHits(annual, annual.ganZhi); }
  const decade = (n.greatFortunes ?? []).find((row) => Number(row.startYear) <= Number(y) && Number(y) <= Number(row.endYear));
  if (decade) { out.decade = decade; out.decadeHits = summarizeHits(decade, decade.ganZhi); }
  if (plan.month !== undefined) {
    const monthly = (n.monthlyFortunes ?? []).find((row) => Number(row.year) === Number(y) && Number(row.month) === Number(plan.month));
    if (monthly) { out.monthly = monthly; out.monthlyHits = summarizeHits(monthly, monthly.ganZhi); }
  }
  out.age = Number(y) - Number(record.birthYear);
  return out;
}

const taskRecords = (record: BaziRecord) => (record.aiTasks ? Object.values(record.aiTasks) : []) as any[];
const findCompleted = (tasks: any[], type: string, year?: number, month?: number) => tasks.find((r) => r?.task?.type === type
  && (year === undefined || Number(r?.task?.year) === Number(year))
  && (month === undefined || Number(r?.task?.month) === Number(month))
  && r.status === 'completed' && r.analysis);

/** 本机离线通道证据组装(口径 = 服务器 collectEvidence，数据源 = 本机 SQLite/镜像库)。 */
export function buildEvidence(record: BaziRecord, plan: ChatPlan): ChatEvidence {
  const n = record.nonAiResult;
  // 五行按四柱现算(与批量分析同一口径)：库里存量可能是旧口径算出的假配比
  const counted = countElements([record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar]);
  const natal: Record<string, unknown> = {
    gender: record.gender, birthYear: record.birthYear,
    pillars: { year: record.yearPillar, month: record.monthPillar, day: record.dayPillar, hour: record.hourPillar },
    solarDate: n?.solarDate, lunarDate: n?.lunarDate, zodiac: n?.zodiac, dayMaster: n?.dayMaster,
    elements: counted.elements, elementRatio: counted.elementRatio, hiddenStems: n?.hiddenStems, tenGods: n?.tenGods,
    naYin: n?.naYin, twelveLongevity: n?.twelveLongevity,
    patternFacts: n?.patternFacts, strengthScore: n?.strengthScore,
    shenSha: compactShenSha(n?.shenSha), relationships: n?.relationships,
  };
  const evidence: ChatEvidence = {
    person: { id: record.id, name: record.name, gender: record.gender, birthYear: record.birthYear },
    plan: { year: plan.year, month: plan.month, topics: plan.topics },
    natal, analyses: [], missing: [],
  };
  const tasks = taskRecords(record);
  const wantsPeriod = plan.year !== undefined;
  const topics = plan.topics;
  if (!wantsPeriod) {
    const baseline = findCompleted(tasks, 'baseline');
    if (baseline) {
      const text = sliceSections(baseline.analysis.explanation, topics.length ? [...topics, '身强身弱与喜忌'] : []) || String(baseline.analysis.explanation ?? '').slice(0, 900);
      evidence.analyses.push({ heading: '本命批断', text });
    } else evidence.missing.push('本命批断尚未生成：可先在命盘详情页点「AI 分析」');
    const adjustment = findCompleted(tasks, 'adjustment');
    if (adjustment && (!topics.length || topics.includes('五行'))) evidence.analyses.push({ heading: '后天调整与职业', text: sliceSections(adjustment.analysis.explanation, ['后天调整', '事业适配', '健康注意']) });
    const overview = findCompleted(tasks, 'overview');
    if (overview && !topics.length) evidence.analyses.push({ heading: '全盘总结', text: sliceSections(overview.analysis.explanation, ['核心结论', '值得关注的时间节点', '行动建议']) });
  } else {
    const labels = topics.length ? topics : ['健康', '事业', '财运', '爱情', '刑冲克害批注'];
    const annual = findCompleted(tasks, 'annual', plan.year);
    if (annual) evidence.analyses.push({ heading: plan.year + '年·流年批断(' + String(annual.analysis.title ?? '') + ')', text: sliceSections(annual.analysis.explanation, labels) });
    else evidence.missing.push(plan.year + ' 年的流年分析尚未生成');
    const decade = findCompleted(tasks, 'decade', plan.year);
    if (decade) evidence.analyses.push({ heading: '所处大运批断', text: sliceSections(decade.analysis.explanation, labels) });
    if (plan.month !== undefined) {
      const monthly = findCompleted(tasks, 'monthly', plan.year, plan.month);
      if (monthly) evidence.analyses.push({ heading: plan.year + '年' + plan.month + '月·流月批断', text: sliceSections(monthly.analysis.explanation, labels) });
      else evidence.missing.push(plan.year + '年' + plan.month + '月 的流月分析尚未生成');
    }
  }
  const periodFacts = buildPeriodFacts(record, plan);
  if (periodFacts) evidence.periodFacts = periodFacts;
  return evidence;
}

/* ---------- 消息构建(与服务器 buildChatMessages 同口径) ---------- */
export const CHAT_SYSTEM = '你是一位资深子平命理师，正在与用户实时对话答疑。'
  + '【唯一依据】回答只能引用消息中【命盘事实】【所问时段运势数据】【已算批断摘录】里已给出的内容。'
  + '严格按下列顺序作答：'
  + '第一步，检查【已算批断摘录】里有没有覆盖用户所问的时段与主题；'
  + '第二步，只要有覆盖，就直接引用其中的结论与依据作答，不得改写其口径；'
  + '第三步，只要没有覆盖(摘录为空或只有【数据缺口提示】)，或有【数据缺口提示】，'
  + '就先明确说出"数据库里还没有计算过这批数据"，逐条列出缺了什么，'
  + '并建议用户先到命盘详情页点「AI 分析」把对应的本命/流年/流月批断算出来，然后再来提问；'
  + '此时只允许复述缺口与已有事实，一条都不许推测。'
  + '【绝对禁止】禁止自行推算或猜测干支、十神、五行、旺衰、格局、神煞；'
  + '禁止用命理常识、通书、经验、类比或"一般来说""通常""可能会"来补足缺失数据；'
  + '禁止在证据之外新增任何未给出的结论。'
  + '已有事实优先，格局与旺衰一律以 natal.patternFacts / natal.strengthScore 为准，不得重判、不得改口径。'
  + '【说重点】先说结论，再给依据，只讲与该问题直接相关的话，不铺垫、不寒暄、不重复问题、不写无关主题。'
  + '输出为简体中文纯文本：不要 JSON、不要代码块/注释/围栏标记；总长 150~350 字；'
  + '分点(1. 2. 3.)作答，有证据时每点都注明依据的批断小节，无证据时直接说明缺数据并给出补算建议；全篇不得出现繁体字。';

export function buildChatMessages(input: { question: string; history: ChatMessage[]; evidence: ChatEvidence; tone: number }): Array<{ role: string; content: string }> {
  const { question, history, evidence, tone } = input;
  const evidenceText = '# 命盘事实(JSON)\n' + JSON.stringify(evidence.natal)
    + (evidence.periodFacts ? '\n\n# 所问时段运势数据(JSON)\n' + JSON.stringify(evidence.periodFacts) : '')
    + '\n\n# 已算批断摘录\n' + (evidence.analyses.map((a) => '## ' + a.heading + '\n' + a.text).join('\n\n') || '（数据库中暂无该主题的已算批断）')
    + (evidence.missing.length ? '\n\n# 数据缺口提示\n' + evidence.missing.map((m) => '- ' + m).join('\n') : '');
  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: CHAT_SYSTEM }];
  for (const item of history.slice(-8)) {
    if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim()) {
      messages.push({ role: item.role, content: item.content.slice(0, 2000) });
    }
  }
  messages.push({
    role: 'user',
    content: evidenceText + '\n\n# 语气要求\n' + toneInstructionText(tone) + '\n\n# 用户问题\n' + String(question ?? '').slice(0, 500),
  });
  return messages;
}

/* ---------- 三通道入口 ---------- */
export interface AskChatInput { question: string; history?: ChatMessage[]; tone?: number; recordId?: string | null; signal?: AbortSignal }

export async function askChat(input: AskChatInput): Promise<ChatReply> {
  const question = String(input.question || '').trim();
  if (!question) return { status: 'failed', error: '请输入问题' };
  if (question.length > 500) return { status: 'failed', error: '问题过长，请控制在 500 字以内' };
  const history = Array.isArray(input.history) ? input.history : [];
  const tone = Number.isFinite(input.tone as number) ? Math.max(0, Math.min(100, Math.round(Number(input.tone)))) : 80;

  if (isServerMode()) {
    let recordId = input.recordId ?? undefined;
    let periodFacts: Record<string, unknown> | undefined;
    // 本机若已有该盘完整数据，把引擎现算的时段行一并带上(服务器存储是瘦身版)
    try {
      const records = await listBaziRecords();
      const plan = analyzeQuestion(question, records);
      const target = (recordId ? records.find((r) => r.id === recordId) : undefined)
        ?? (plan.recordId ? records.find((r) => r.id === plan.recordId) : undefined)
        ?? (records.length === 1 ? records[0] : undefined);
      if (target) { recordId = target.id; periodFacts = buildPeriodFacts(target, { ...plan, recordId: target.id }); }
    } catch { /* 本地库读不到就让服务器完全按库内数据作答 */ }
    try {
      let provider: string | undefined;
      try { provider = localStorage.getItem('mingli.provider') ?? undefined; } catch { provider = undefined; }
      const { data } = await serverFetch<ChatReply>('/chat', { method: 'POST', body: { question, history, recordId, tone, periodFacts, provider }, signal: input.signal });
      return { ...data, evidence: data?.evidence };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return { status: 'failed', error: '已取消' };
      const offline = error instanceof ServerError && error.status === 0;
      if (!offline) return { status: 'failed', error: error instanceof Error ? error.message : '服务器请求失败' };
      // 服务器不可达 → 落到本机通道(离线可用)
    }
  }
  return askChatLocal({ ...input, question, history, tone });
}

async function askChatLocal(input: { question: string; history: ChatMessage[]; tone: number; recordId?: string | null; signal?: AbortSignal }): Promise<ChatReply> {
  const records = await listBaziRecords();
  if (records.length === 0) return { status: 'need_record', reason: '还没有任何命盘：请先在「排盘」页保存一条记录，再向我提问' };
  const plan = analyzeQuestion(input.question, records);
  let target = input.recordId ? records.find((r) => r.id === input.recordId) : undefined;
  if (!target && plan.recordId) target = records.find((r) => r.id === plan.recordId);
  if (!target && records.length === 1) target = records[0];
  if (!target) return { status: 'need_record', reason: '你的名下有多条命盘，请告诉我问的是谁(或点选命主)', evidence: { plan, options: records.map((r) => ({ id: r.id, name: r.name })) } };
  const evidence = buildEvidence(target, plan);
  const messages = buildChatMessages({ question: input.question, history: input.history, evidence, tone: input.tone });
  const meta = { recordId: target.id, personName: target.name, plan };
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (inTauri) {
    try {
      const result = await invoke<{ status: string; answer?: string; error?: string; cached?: boolean }>('run_ai_chat', {
        chat: {
          gender: target.gender, birthYear: target.birthYear,
          yearPillar: target.yearPillar, monthPillar: target.monthPillar, dayPillar: target.dayPillar, hourPillar: target.hourPillar,
          question: input.question, tone: input.tone, cached: input.history.length === 0,
        },
        messages,
      });
      return { status: result.status as ChatReply['status'], answer: result.answer, error: result.error, cached: result.cached, evidence: meta };
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : '本机 AI 请求失败', evidence: meta };
    }
  }
  const result = await chatDirect(messages, { signal: input.signal });
  return { status: result.status as ChatReply['status'], answer: (result as { answer?: string }).answer, error: (result as { error?: string }).error, evidence: meta };
}
