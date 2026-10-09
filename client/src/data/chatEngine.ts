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
import { hydrateRecord, listBaziRecords, unsyncedRecordIds } from './clientRepository';
import { isServerMode, serverFetch, ServerError } from './serverClient';
import { chatDirect, toneInstructionText } from './deepseekAdapter';
import { getBrowserCredential } from './aiSettings';
import { countElements, sanitizeChatText } from '../features/chart/elements';
/* 「本月/今年」这类相对时间锚点必须按北京口径读，不能用设备本地字段：机器时区不是东八区时，
   UTC 16:00–24:00 那段本地日期比北京早一天，「本月」会答成上个月、「今年」会答成去年。
   与详情页起运文案/大运表同一套收口(utils/date)，见 beijing-date-caliber.test.ts。 */
import { chinaDateParts, chinaYear } from '../utils/date';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatPlan { recordId: string | null; personName: string | null; matchedCount: number; year?: number; month?: number; topics: string[]; question?: string; scan?: boolean; scanFrom?: number; general?: boolean }
export interface ChatEvidence {
  person: { id: string; name: string; gender: string; birthYear: number };
  plan: { year?: number; month?: number; topics: string[] };
  natal: Record<string, unknown>;
  analyses: Array<{ heading: string; text: string }>;
  missing: string[];
  periodFacts?: Record<string, unknown>;
  /** 泛问时列给模型的「本盘已有小节」清单：只能从中选取，不得自行补写没有的小节。 */
  sectionIndex?: string[];
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

/** 汉字月名 → 月份数字。口语里「明年三月」比「明年3月」更常见，只认阿拉伯数字的话整段月份会凭空消失。 */
export const CN_MONTHS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
/** 长名必须排在前面：`十一月` 若让 `一月` 先匹配，会被切成「十」+ 残留的「一月」。 */
const CN_MONTH_ALT = '十一|十二|[一二三四五六七八九十]';

/** 开放式时间问法：问「什么时候/大约在何时」，不指定具体年份，需要扫未来若干年。 */
export const OPEN_TIMING_RE = /什么(时候|时间|年份|时期|阶段|时候能)|哪一?年|何时|多久|几年(内|后|能)|大约在|大致在|何时能/;
/** 扫年窗口：从「起算年」往后取多少年。太短会漏掉晚来的应期，太长则证据与成本失控。 */
export const SCAN_YEARS = 8;

/** 把「本月/下个月/三月/3月」统一解析成 1..12；解不出返回 undefined。单独成函数是为了让分句也能喂进来。 */
function monthFromText(text: string, now: Date): number | undefined {
  const q = String(text || '');
  const hit = q.match(/(\d{1,2})\s*月/) || q.match(new RegExp('(' + CN_MONTH_ALT + ')\\s*月'));
  if (hit) {
    const m = /^\d/.test(hit[1]) ? Number(hit[1]) : CN_MONTHS[hit[1]];
    if (m !== undefined && m >= 1 && m <= 12) return m;
  }
  /* 这里只取北京月份：本地 getMonth() 在非 +08 设备上会比北京早一个月(跨年那一刻还跨年)。 */
  const cm = chinaDateParts(now).month;
  if (/本月|这个月|当月|这月/.test(q)) return cm;
  if (/下个月|下月|来月/.test(q)) return cm + 1 > 12 ? 1 : cm + 1;
  if (/上个月|上月/.test(q)) return cm === 1 ? 12 : cm - 1;
  return undefined;
}

/** ⚠ 顺序即正确性：先把年月全解析完，最后才决定 scan。旧写法把 scan 分支夹在月份解析之前直接
 *  return，于是「明年三月什么时候发工资」里的月份被整段跳过。两位年份缩写(24年→2024)按当代
 *  出生区间回推 —— 这正是「答我没有24年信息」的根因：旧正则只吃 20\d{2}，解不出就继承了上一轮年份。 */
export function extractWhen(question: string, now = new Date()): { year?: number; month?: number; scan?: boolean; from?: number } {
  const q = String(question || '');
  let year: number | undefined; let month: number | undefined;
  /* 「今年/明年/去年」的锚点年份同样走北京口径(chinaYear)，理由见文件头的导入注释。 */
  const nowYear = chinaYear(now);
  const abs = q.match(/(20\d{2})\s*年/) || q.match(/(?:^|[^\d.])(\d{2})\s*年(?![\d])/);
  if (abs) {
    const raw = Number(abs[1]);
    year = String(raw).length === 4 ? raw : raw > 30 ? 1900 + raw : 2000 + raw;
  }
  if (year === undefined) {
    for (const [word, delta] of Object.entries(RELATIVE_YEAR)) {
      if (q.includes(word)) { year = nowYear + delta; break; }
    }
  }
  month = monthFromText(q, now);
  if (month !== undefined && year === undefined) year = nowYear; // 月份必然锚定在某一年
  // 年份与月份都没落地、且句子确实在开放式问时机 → 才转扫年。「明年什么时候」有年份锚点，不走这里。
  if (year === undefined && month === undefined && OPEN_TIMING_RE.test(q)) {
    const rel = Object.entries(RELATIVE_YEAR).find(([word]) => q.includes(word));
    return { year: undefined, month: undefined, scan: true, from: nowYear + (rel ? rel[1] : 0) };
  }
  return { year, month };
}

/** 从句子里挑出承载「所问时段」的那一小句再解析时间：「我本月失业了，接下来财运怎么样」的锚点在前半句。 */
function whenOfQuestion(q: string, now: Date): { year?: number; month?: number; scan?: boolean; from?: number } {
  const whole = extractWhen(q, now);
  const landed = whole.year !== undefined || whole.month !== undefined || whole.scan === true;
  if (landed) return whole;
  for (const clause of String(q).split(/[，,。;；！!？?\n]/)) {
    if (!clause.trim()) continue;
    const part = extractWhen(clause, now);
    if (part.year !== undefined || part.month !== undefined || part.scan === true) return { ...whole, ...part };
  }
  return whole;
}

/** 泛问识别：没命中任何主题词、但确实在问整体状况或适配方向。不识别它，「我这个人怎么样」
 *  只能拿到本命批断的开头几百字，【核心结论】与【事业适配】永远进不了上下文。 */
export const GENERAL_QUESTION_RE = /怎么样|如何|怎样|总体|整体|全面|概括|一生|一辈子|此命|命局|格局|此人|这个人|适合|方位|方向|行业|从事|发展|注意什么|运势|运程|运气|缺什么|喜用/;

/** 检索计划。人名用一轮子串扫描(命中长名优先)；记录很多时可按 name 长度降序提前 break 或预建前缀索引。 */
export function analyzeQuestion(question: string, records: Array<Pick<BaziRecord, 'id' | 'name'>>, now = new Date()): ChatPlan {
  const q = String(question || '');
  const matched: Array<{ id: string; name: string }> = [];
  for (const s of records) {
    const name = String(s.name || '').trim();
    if (name && q.includes(name)) matched.push({ id: s.id, name });
  }
  matched.sort((a, b) => b.name.length - a.name.length);
  const when = whenOfQuestion(q, now);
  const topics = [...new Set(TOPIC_RULES.filter((rule) => rule.re.test(q)).map((rule) => rule.topic))];
  return { recordId: matched[0]?.id ?? null, personName: matched[0]?.name ?? null, matchedCount: matched.length, year: when.year, month: when.month, scan: when.scan === true, scanFrom: when.from, topics, question: q, general: topics.length === 0 && GENERAL_QUESTION_RE.test(q) };
}

/** 本轮问题自带的人名要能覆盖上一轮命主。 */
function personFromText(text: string, records: Array<Pick<BaziRecord, 'id' | 'name'>>): { recordId: string; personName: string } | null {
  const q = String(text || '');
  let best: { id: string; name: string } | null = null;
  for (const s of records || []) {
    const name = String(s.name || '').trim();
    if (name && q.includes(name) && (!best || name.length > best.name.length)) best = { id: s.id, name };
  }
  return best ? { recordId: best.id, personName: best.name } : null;
}

/** 追问继承上文语境：上一轮问的是 2026 年爱情，这轮一句「那我明年呢」不该退化成全新问题。
 *  只做「有历史且本轮自己没说时间/主题」时的补全，本轮若已明说就以本轮为准。
 *  records 传入时会做人名继承/切换：本轮自己点了别的名字 → 换人；只说「那她呢」→ 沿用上一个人。 */
export function applyFollowUp(plan: ChatPlan, history: ChatMessage[], records: Array<Pick<BaziRecord, 'id' | 'name'>> = [], now = new Date()): ChatPlan {
  if (!Array.isArray(history) || history.length === 0) return plan;
  // 往前找到最近一条**点过人名**的用户消息，而不是只看上一条(「那她呢」这种短追问本身不含名字)。
  const userTurns = history.filter((m) => m?.role === 'user' && typeof m.content === 'string');
  let prevPerson: { recordId: string; personName: string } | null = null;
  for (let i = userTurns.length - 1; i >= 0 && !prevPerson; i -= 1) prevPerson = personFromText(userTurns[i].content, records);
  const prevUser = userTurns[userTurns.length - 1];
  const prevAssistant = [...history].reverse().find((m) => m?.role === 'assistant' && typeof m.content === 'string');
  const source = [prevUser?.content, prevAssistant?.content, plan.question].filter(Boolean).join('\n');
  const next: ChatPlan = { ...plan };
  // 人名：本轮自己说了就按本轮的来(可能换人)，没说才沿用上一轮，避免整段对话锁死在第一个命主上。
  const thisTurn = personFromText(plan.question ?? '', records);
  if (!thisTurn && prevPerson) { next.personName = prevPerson.personName; next.recordId = prevPerson.recordId; }
  else if (thisTurn) { next.personName = thisTurn.personName; next.recordId = thisTurn.recordId; }
  if (!plan.topics?.length) {
    const inherited = [...new Set(TOPIC_RULES.filter((rule) => rule.re.test(source)).map((rule) => rule.topic))];
    if (inherited.length) { next.topics = inherited; next.general = false; }
    // 主题与泛问互斥：继承了具体主题就不再按泛问铺开，否则「那她呢」会把三份长证据全塞进来。
    else next.general = plan.general === true && GENERAL_QUESTION_RE.test(source);
  }
  if (next.year === undefined && !next.scan) {
    const inheritedWhen = whenOfQuestion(prevUser?.content ?? '', now);
    if (inheritedWhen.year !== undefined) { next.year = inheritedWhen.year; next.month = inheritedWhen.month; }
    else if (inheritedWhen.scan) { next.scan = true; next.scanFrom = inheritedWhen.from; }
  }
  return next;
}

/* ---------- 证据摘录(与服务器 sliceSections 同口径) ---------- */
/** 批断正文里可能出现的【小节】标签全集：提问主题(健康/事业/…)与独立小节名(核心结论/…)的并集。
 *  提问主题里的「大运」「格局」「神煞」「五行」「流月」不在这里——它们不是批断小节的标签，
 *  但必须能落进 labels，否则过滤条件会被整条跳过、把全部小节都当成命中返回。 */
export const KNOWN_SECTION_LABELS = [
  '健康', '事业', '财运', '爱情', '刑冲克害批注', '后天调整', '事业适配', '健康注意',
  '核心结论', '值得关注的时间节点', '行动建议', '身强身弱与喜忌',
];
/** 按句读/条目收口的截断(与服务器 sliceSections 同口径)：正文超过 cap 时退到 cap 之内最后一个
 *  句末标点或换行处切，不把一句话或一条编号要点拦腰砍断(结论段被切一半正是取证失真的来源)。
 *  找不到合适切点(首句超长)时才切满 cap，但设下限避免只剩一两个字。 */
export function cutAtBoundary(text: string, cap: number): string {
  const str = String(text || '');
  if (str.length <= cap) return str;
  const head = str.slice(0, cap);
  let p = -1;
  for (const ch of ['。', '！', '？', '；', '\n']) {
    const idx = head.lastIndexOf(ch);
    if (idx > p) p = idx;
  }
  return p >= 15 ? head.slice(0, p + 1).replace(/\s+$/, '') : head;
}
export function sliceSections(text: string, topics: string[], capPer = 700): string {
  const source = String(text || '');
  if (!source) return '';
  const labels = (Array.isArray(topics) ? topics : []).slice();
  const realLabels = labels.filter((t) => KNOWN_SECTION_LABELS.includes(t));
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const part of source.split(/(?=【)/)) {
    const m = part.match(/^【([^】]+)】([\s\S]*)/);
    if (!m) continue;
    const label = m[1].trim(); const body = cutAtBoundary(m[2].trim(), capPer);
    // 提问主题里存在真实小节标签时才按标签过滤；只问「大运/格局」这类非小节主题时不过滤
    if (realLabels.length && !realLabels.some((t) => label.includes(t))) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    blocks.push('【' + label + '】' + body);
  }
  if (blocks.length) return blocks.join('\n');
  return labels.length ? '' : cutAtBoundary(source, capPer);
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

/** 时段运势事实：存储是瘦身的(大运/流年/流月数组落库时被清空)，所以记录必须先经 hydrateRecord
 *  重算再进来；否则这里三行查找恒为空，模型只剩一个年龄可引，问「某年某月」就答不出东西。 */
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
// 大运任务按「起运年」存；所问年份多半落在某步运中段，须先用 greatFortunes 找出覆盖它的运、按起运年取，
// 否则只有正好问起运年那一年才命中，其余九年的「所处大运批断」静默丢失。greatFortunes 缺失时退回精确匹配。
const coveringDecadeStart = (record: BaziRecord, year: number | undefined): number | undefined => {
  const rows = record.nonAiResult?.greatFortunes;
  if (Array.isArray(rows) && year !== undefined) { const g = rows.find((r: any) => Number(r.startYear) <= Number(year) && Number(year) <= Number(r.endYear)); if (g) return Number(g.startYear); }
  return undefined;
};
const decadeOf = (record: BaziRecord, tasks: any[], year: number | undefined) => {
  const keyYear = coveringDecadeStart(record, year) ?? (year === undefined ? undefined : Number(year));
  return findCompleted(tasks, 'decade', keyYear)
    || tasks.find((r: any) => r?.task?.type === 'decade' && r?.task?.decade && Number(r.task.decade.startYear) <= Number(year) && Number(year) <= Number(r.task.decade.endYear) && r.status === 'completed' && r.analysis);
};

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
    // 调候参考：与服务器/桌面端 natal 同源字段，令三通道聊天在本命/喜忌类问题上口径一致。
    tiaohouFacts: n?.tiaohouFacts,
    shenSha: compactShenSha(n?.shenSha), relationships: n?.relationships,
  };
  const evidence: ChatEvidence = {
    person: { id: record.id, name: record.name, gender: record.gender, birthYear: record.birthYear },
    plan: { year: plan.year, month: plan.month, topics: plan.topics },
    natal, analyses: [], missing: [],
  };
  const tasks = taskRecords(record);
  const wantsScan = plan.scan === true;
  const wantsPeriod = plan.year !== undefined || wantsScan;
  const topics = plan.topics;
  // 「泛问」(我这个人怎么样/适合做什么)：没有主题词当节标签，但用户要的恰恰是最依赖全局结论的答案。
  // 把本命 + 全盘总结 + 后天调整三份都端出来，并把已有小节清单交给模型按问题挑 —— 仍属取证，不属推测。
  const isGeneral = topics.length === 0 && plan.general === true;
  if (wantsScan) {
    // 开放式时机提问：把未来若干年的流年批断逐条列成时间线，让模型在证据里挑年限
    const labels = topics.length ? topics : ['健康', '事业', '财运', '爱情', '刑冲克害批注'];
    const from = Number(plan.scanFrom ?? chinaYear(new Date()));
    const lines: string[] = []; const gaps: number[] = []; const uncovered: number[] = [];
    for (let y = from; y < from + SCAN_YEARS; y += 1) {
      const annual = findCompleted(tasks, 'annual', y);
      if (!annual) { gaps.push(y); continue; }
      const body = sliceSections(annual.analysis.explanation, labels, 260);
      // 该年批断存在，但按提问主题过滤后一个字都没有 → 这一年答不了这个问题，必须点名
      if (!body) uncovered.push(y);
      lines.push(String(y) + '年(' + String(annual.analysis.title ?? '') + ')：' + body);
    }
    if (lines.length) {
      evidence.analyses.push({ heading: from + '年至' + (from + SCAN_YEARS - 1) + '年逐年批断，用于判断应期', text: lines.join('\n') });
      const decade = decadeOf(record, tasks, from);
      if (decade) evidence.analyses.push({ heading: '所处大运批断', text: sliceSections(decade.analysis.explanation, labels) });
    } else {
      evidence.missing.push(from + '年至' + (from + SCAN_YEARS - 1) + '年的流年批断一条都还没生成，无法判断应期');
    }
    if (gaps.length) evidence.missing.push('下列年份尚未生成流年批断，作答时只能在这些年份之外给应期：' + gaps.join('、') + '年');
    if (uncovered.length) evidence.missing.push('下列年份虽有流年批断，但其中没有与所问主题相关的小节，不得据其判断该主题的应期：' + uncovered.join('、') + '年');
    return evidence;
  }
  if (!wantsPeriod) {
    const baseline = findCompleted(tasks, 'baseline');
    if (baseline) {
      const text = sliceSections(baseline.analysis.explanation, topics.length ? [...topics, '身强身弱与喜忌'] : []) || cutAtBoundary(String(baseline.analysis.explanation ?? ''), 900);
      evidence.analyses.push({ heading: '本命批断', text });
    } else evidence.missing.push('本命批断尚未生成：可先在命盘详情页点批断分析');
    const adjustment = findCompleted(tasks, 'adjustment');
    if (adjustment && (!topics.length || topics.includes('五行'))) evidence.analyses.push({ heading: '后天调整与职业', text: sliceSections(adjustment.analysis.explanation, ['后天调整', '事业适配', '健康注意']) });
    const overview = findCompleted(tasks, 'overview');
    if (overview && !topics.length) evidence.analyses.push({ heading: '全盘总结', text: sliceSections(overview.analysis.explanation, ['核心结论', '值得关注的时间节点', '行动建议']) });
    if (isGeneral) {
      const available = [...new Set(evidence.analyses.flatMap((a) => [...String(a.text).matchAll(/【([^】]+)】/g)].map((m) => m[1])))];
      if (available.length) evidence.sectionIndex = available;
    }
  } else {
    const labels = topics.length ? topics : ['健康', '事业', '财运', '爱情', '刑冲克害批注'];
    const annual = findCompleted(tasks, 'annual', plan.year);
    if (annual) evidence.analyses.push({ heading: plan.year + '年流年批断，题为' + String(annual.analysis.title ?? '') , text: sliceSections(annual.analysis.explanation, labels) });
    else evidence.missing.push(plan.year + '年的流年分析尚未生成');
    const decade = decadeOf(record, tasks, plan.year);
    if (decade) evidence.analyses.push({ heading: '所处大运批断', text: sliceSections(decade.analysis.explanation, labels) });
    if (plan.month !== undefined) {
      const monthly = findCompleted(tasks, 'monthly', plan.year, plan.month);
      if (monthly) evidence.analyses.push({ heading: plan.year + '年' + plan.month + '月流月批断', text: sliceSections(monthly.analysis.explanation, labels) });
      else evidence.missing.push(plan.year + '年' + plan.month + '月的流月分析尚未生成');
    }
  }
  const periodFacts = buildPeriodFacts(record, plan);
  if (periodFacts) evidence.periodFacts = periodFacts;
  return evidence;
}

/* ---------- 消息构建(与服务器 buildChatMessages 同口径) ---------- */
export const CHAT_SYSTEM = '你是一位资深子平命理师，正在与用户实时对话答疑。'
  + '【唯一依据】回答只能引用消息中【命盘事实】【所问时段运势数据】【已算批断摘录】里已给出的内容。'
  + '【先看历史】若对话历史里已有你上一轮的回答，必须先读懂用户这一句在追问什么，再往下走：'
  + '追问是对上一轮某个结论的深挖或换角度，就在上一轮的基础上继续讲那一处，不得整段重述上一轮已经说过的话；'
  + '追问若是在纠正或否定你上一轮的理解，先承认理解偏了，再按用户真正想问的重答一次；'
  + '追问若含义不明、指代不清，只问一句最关键的澄清话(比如"你是想问姻缘的应期，还是想问今年的桃花？")，不要顺着猜。'
  + '【时机提问】用户问"什么时候/大约何时/多久/哪一年"这类不指定年份的应期问题时，'
  + '证据里会给出一个连续年份的【逐年批断(用于判断应期)】；'
  + '要逐个年份比对其中与该主题相关的小节，挑出最有利的一到两个年份作为应期作答，'
  + '并把支持这个判断的命理作用直接讲出来(只讲作用本身，不标注它出自哪条批断)；'
  + '证据里若点名了"尚未生成流年批断"的年份，只能在该范围之外给应期，绝不能给这批空缺年份下任何结论。'
  + '【缺口处理】只有当证据覆盖不了用户所问的时段与主题时(摘录为空，或只有【数据缺口提示】)，'
  + '才明确说出"数据库里还没有计算过这批数据"，逐条列出缺了什么，'
  + '并建议用户先到命盘详情页点批断分析把对应的本命、流年、流月批断算出来，然后再来提问；'
  + '此时只允许复述缺口与已有事实，一条都不许推测。'
  + '【所问时段以检索计划为准】用户问题里的年份/月份说法可能不规范(如把某年说成两位缩写)，'
  + '一律以本消息给出的检索计划与证据里标注的年份、月份为提问所指，不得因为问题原文的数字与你看到的年份写法不同，就回答"没有那一年的信息"。'
  + '【泛问处理】用户问的是整体状况或适配方向(没点定某个专题)时，证据会给出【本盘已算出的批断小节】清单：'
  + '先从清单里挑出与该问题最相关的小节作答，不要平铺所有小节，也不得引用清单里没有的小节名。'
  + '【绝对禁止】禁止自行推算或猜测干支、十神、五行、旺衰、格局、神煞；'
  + '禁止用命理常识、通书、经验、类比或"一般来说""通常""可能会"来补足缺失数据；'
  + '禁止在证据之外新增任何未给出的结论。'
  + '已有事实优先，格局与旺衰一律以命盘事实里「格局事实」「旺衰评分」两项为准，不得重判、不得改口径。'
  + '【说重点】先给结论，再把命理作用本身讲清楚，只讲与该问题直接相关的话，不铺垫、不寒暄、不重复问题、不写无关主题。'
  + '【正文只许中文】输出限死为纯中文：不得出现任何英文单词、英文缩写或拼音；'
  + '不得出现任何数字(要表达数量或年份一律写成中文，如「二零二七年」「三十岁」)；'
  + '不得出现括号、引号、书名号、连字符、下划线、百分号等任何半角或全角符号，只用汉字与顿号、逗号、冒号、句号、问号；'
  + '尤其禁止把证据里的英文字段名、变量名、代码标识符原样抄进正文，要说的内容一律翻译成中文说法。'
  + '【禁止引用出处】不要标注答案来自哪条批断、哪个小节、哪份数据或哪个字段，也不要写「依据」「根据」「引用」「见」之类出处说明；'
  + '直接给结论和理由本身，全篇不留任何参考与引用的痕迹。'
  + '输出为简体中文纯文本：不要 JSON、不要代码块/注释/围栏标记；总长一百五十字到三百五十字；'
  + '分点作答，每点单独一行、行首用中文顿号式序号(一、二、三)，无证据时直接说明缺数据并给出补算建议；全篇不得出现繁体字。';

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
  // 小节清单放在证据之后：它随命盘内容变化，不属于可缓存的稳定前缀。
  const sectionIndexText = evidence.sectionIndex?.length
    ? '\n\n# 本盘已算出的批断小节(只能从中选取作答，不得自行补写没有的小节)\n' + evidence.sectionIndex.map((s) => '【' + s + '】').join('、')
    : '';
  messages.push({
    role: 'user',
    content: evidenceText + sectionIndexText + '\n\n# 语气要求\n' + toneInstructionText(tone) + '\n\n# 用户问题\n' + String(question ?? '').slice(0, 500),
  });
  return messages;
}

/* ---------- 三通道入口 ---------- */
export interface AskChatInput { question: string; history?: ChatMessage[]; tone?: number; recordId?: string | null; signal?: AbortSignal }

/** 本机是否至少给一条通道填了凭据(决定服务器报错该报「未配置」还是继续往下走)。 */
function anyChannelConfigured(): boolean {
  try { return (['deepseek', 'kimi', 'qwen'] as const).some((id) => !!getBrowserCredential(id)); } catch { return false; }
}

/** 「谁都没配」这句话该指向哪儿：连着服务器时密钥在服务器那边，界面却写着「去设置」，
 *  用户点开的是本机凭据框 —— 填了也不会让服务器那条通道动起来。
 *  入口方位按实际位置写「右上角」：「设置」按钮靠行尾对齐，窄屏同样靠右。
 *  这句会原样显示给用户(闸门只在有正文时才跑)，所以里面不许出现英文缩写、括号与分号。 */
/** 中文计数与「闸门同款」的清洗：这两样原先在 PersonDetail / RecordsPage / SettingsPage 各抄一份，
 *  第三份出现在这里 —— 抄来抄去就会分叉(界面上「已配置 零 条」那种空格、以及漏洗的英文串都是这么来的)。
 *  读法统一放 shared/chineseReadAloud，清洗沿用上面已 import 的闸门那一份。 */
import { cnCount, cnCode } from '../shared/chineseReadAloud';

/** 通道原始报错 → 能上屏的中文。
 *  fetch 抛的是整句英文(带括号、冒号、状态码)，直接拼进 error 会被展示层的闸门整段判空，
 *  于是用户只看到「回答失败，请稍后重试」，真正的原因反而丢了 —— 这与「宁缺毋滥」的本意相反：
 *  这里不是要藏原因，而是要把原因读成人话。所以先删凭据痕迹、把 HTTP 三位数逐位读成中文
 *  (五零三比「HTTP 503」好懂，留阿拉伯数字又违反正式版口径)，再交给闸门做终检；
 *  闸门仍判空时退回一句固定中文，至少不丢掉「哪一段没成功」。 */
export function readableChannelError(raw?: string): string {
  const masked = String(raw ?? '')
    .replace(/sk-[a-z0-9_-]+/gi, '已隐藏的密钥')
    .replace(/github_pat_[a-z0-9_]+/gi, '已隐藏的令牌')
    .replace(/bearer\s+[^\s，。）]+/gi, '已隐藏的凭据')
    .replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, '$1已隐藏')
    .replace(/\bhttp\s*([0-9]{3})\b/gi, (_m, code: string) => '服务返回' + cnCode(code));
  return sanitizeChatText(masked) || '该通道未返回可显示的原因';
}

/** 姓名/账号名的统一读法(账号名与命主姓名共用)：两者都可能是登录或录入时的机器串
 *  (带字母、数字或下划线，如测试期建的 T_SOL_01)，直接印进正文就违反「只能中文」口径。
 *  纯中文名原样显示；含非中文字符时逐位读成中文(字母按近似读音，数字逐位)，界面这一行不留拉丁字母；
 *  原始串仍由调用方放进悬浮说明(title)供机主核对。空名回落「未命名」而非空白。 */
const LATIN_READ: Record<string, string> = {
  a: '阿', b: '比', c: '西', d: '地', e: '伊', f: '艾夫', g: '吉', h: '艾尺', i: '艾', j: '杰', k: '开',
  l: '艾勒', m: '艾姆', n: '恩', o: '欧', p: '皮', q: '克优', r: '阿', s: '艾斯', t: '提', u: '优',
  v: '维', w: '达不溜', x: '艾克斯', y: '外', z: '贼德',
};
export function readableName(name?: string): string {
  const raw = String(name ?? '').trim();
  if (!raw) return '未命名';
  if (/^[一-鿿]+$/.test(raw)) return raw;
  const read = [...raw.toLowerCase()].map((ch) => (/[0-9]/.test(ch) ? cnCode(ch) : LATIN_READ[ch] ?? '')).join('');
  return sanitizeChatText(read) || '该名称无法用中文念出，详见悬浮说明';
}

function serverOnlyReason(detail?: string): string {
  const where = isServerMode()
    ? '服务器那边还没配访问凭据，需要在服务器上配置，本客户端的设置页管不到它。想马上能问：点页面右上角设置，给任一通道填凭据，就走本机通道回答。'
    : '还没配访问凭据：配置后即可向我提问，服务器通道或本机通道均可。';
  // detail 是通道原始报错(常带 HTTP 状态码与整句英文)，读成人话再上屏，宁缺毋滥。
  const reason = detail ? readableChannelError(detail) : '';
  return where + (reason ? '原因：' + reason + '。' : '');
}

export async function askChat(input: AskChatInput): Promise<ChatReply> {
  const question = String(input.question || '').trim();
  if (!question) return { status: 'failed', error: '请输入问题' };
  if (question.length > 500) return { status: 'failed', error: '问题过长，请控制在五百字以内' };
  const history = Array.isArray(input.history) ? input.history : [];
  const tone = Number.isFinite(input.tone as number) ? Math.max(0, Math.min(100, Math.round(Number(input.tone)))) : 80;

  /* 服务器报错的原因：本机通道接着答时不必带；本机也失败时用它替掉重复的报错。 */
  let serverReason = '';
  if (isServerMode()) {
    let recordId = input.recordId ?? undefined;
    let periodFacts: Record<string, unknown> | undefined;
    // 列表记录是瘦身版，先重算出大运/流年数组再取证(服务器那边同样需要这份现算数据)。
    try {
      const records = await listBaziRecords();
      // 传 records：追问时本机也要能认出「那她呢」沿用上一轮命主，才能让 periodFacts 算在对的人身上。
      const plan = applyFollowUp(analyzeQuestion(question, records), history, records);
      const target = (recordId ? records.find((r) => r.id === recordId) : undefined)
        ?? (plan.recordId ? records.find((r) => r.id === plan.recordId) : undefined)
        ?? (records.length === 1 ? records[0] : undefined);
      if (target) {
        recordId = target.id;
        const full = await hydrateRecord(target);
        periodFacts = buildPeriodFacts(full, { ...plan, recordId: target.id });
      }
    } catch { /* 本地库读不到就让服务器完全按库内数据作答 */ }
    // #143 同类：上面那步取证是 await，慢盘上可达数百毫秒。旧写法只在 serverFetch 抛 AbortError
    // 时才认出取消，而那时 fetch 压根没发出去过 —— 「点停止 → 又上一条服务器请求」就是这么来的。
    if (input.signal?.aborted) return { status: 'failed', error: '已取消' };
    try {
      let provider: string | undefined;
      try { provider = localStorage.getItem('mingli.provider') ?? undefined; } catch { provider = undefined; }
      const { data } = await serverFetch<ChatReply>('/chat', { method: 'POST', body: { question, history, recordId, tone, periodFacts, provider }, signal: input.signal });
      const answer = data?.status === 'completed' ? sanitizeChatText(String(data.answer ?? '')) : data?.answer;
      // 服务器按它库里的名下记录作答，说「还没有任何命盘」时本机可能其实有离线建的盘。
      // 但「本机有盘」不等于「盘没传上去」：刚保存那一下推送还在后台进行，此刻服务器确实看不见，
      // 而旧文案会让人白跑一趟设置页(其实早已登录、马上就好)。所以现读一次待推送清单再定性。
      if (data?.status === 'need_record') {
        const [localCount, unsynced] = await Promise.all([
          listBaziRecords().then((r) => r.length).catch(() => 0),
          Promise.resolve().then(() => unsyncedRecordIds()),
        ]);
        if (localCount > 0) {
          return { ...data, reason: unsynced.length
            ? '本机有' + cnCount(unsynced.length) + '条命盘还没传上服务器，所以查不到。保持联网，稍等片刻，等列表里那条的未同步标记消失后再问一次。'
            : '本机这些盘都已同步到服务器，却仍查不到你的命盘：可能是当前登录账号与建盘时的账号不同，数据按账号隔离。请在设置里的服务器通道确认已连接的账号。' };
        }
      }
      // 服务器答完就到此为止：正文没过纯中文闸门时**不再静默改走本机通道**。
      // 理由一(死代码)：服务端 chat.mjs 自己就用同一份 chineseGate 洗过一遍，洗净为空即换 provider、
      // 全失败返回 failed，completed 带脏串这条路正常根本走不到。
      // 理由二(口径)：连着服务器又悄悄用浏览器里那份本机密钥重答，用户看不出回答出自哪条通道。
      // 落本机只保留两种明确情形：服务器不可达(status 0)、服务器自身报错且本机配了凭据(见下方 catch)。
      if (data?.status === 'completed' && !answer) {
        return { status: 'failed', error: '云端返回的正文不是纯中文，已拦下未展示。', evidence: data?.evidence };
      }
      return { ...data, answer: data?.status === 'not_configured' && data.error ? serverOnlyReason(data.error) : answer, evidence: data?.evidence };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return { status: 'failed', error: '已取消' };
      const offline = error instanceof ServerError && error.status === 0;
      // 服务器答不上来(它自己那条通道没密钥/调用失败)时，本机若配了凭据还能接着答；
      // 一条都没配才是真的「谁都用不了」，报「未配置」。
      if (!offline) {
        // serverFetch 已经把非 2xx 兜底成「服务返回五零三」，这里不再自己拼 HTTP 数字。
        const reason = error instanceof Error ? error.message : '服务器请求失败';
        if (!anyChannelConfigured()) return { status: 'not_configured', error: serverOnlyReason(reason) };
        serverReason = reason; // 本机配了凭据：继续往下落到本机通道
      }
      // 服务器不可达 → 同样落到本机通道(离线可用)
    }
  }
  const local = await askChatLocal({ ...input, question, history, tone });
  // 本机这条也失败时，光说「本机失败」会漏掉真正的原因(往往是服务器那边先报错的那条)。
  // 两段各自过读法再拼接：原始英文串直接拼进 error 会让展示层整段判空，原因反而丢了。
  if (serverReason && local.status === 'failed' && !local.error?.includes('已取消')) {
    return { ...local, error: '服务器：' + readableChannelError(serverReason) + '；本机通道：' + readableChannelError(local.error || '') };
  }
  // 本机也没配凭据、而用户其实连着服务器：别让人跑去填一个用不上的本机密钥。
  if (local.status === 'not_configured' && isServerMode()) return { ...local, error: serverOnlyReason(local.error) };
  return local;
}

async function askChatLocal(input: { question: string; history: ChatMessage[]; tone: number; recordId?: string | null; signal?: AbortSignal }): Promise<ChatReply> {
  const records = await listBaziRecords();
  if (records.length === 0) return { status: 'need_record', reason: '还没有任何命盘：请先在排盘页保存一条记录，再向我提问' };
  // records 一并传入：本轮没点人名时沿用上一个人，点了别人的名字则换人(否则整段对话锁死在第一个命主)。
  const plan = applyFollowUp(analyzeQuestion(input.question, records), input.history, records);
  let target = input.recordId ? records.find((r) => r.id === input.recordId) : undefined;
  if (!target && plan.recordId) target = records.find((r) => r.id === plan.recordId);
  if (!target && records.length === 1) target = records[0];
  if (!target) return { status: 'need_record', reason: '你的名下有多条命盘，请告诉我问的是谁，或点选下方命主', evidence: { plan, options: records.map((r) => ({ id: r.id, name: r.name })) } };
  // 证据要读大运/流年/流月数组，而存储里这些是空的(落库时瘦身)：只对定下来的这一条做重算。
  const fullTarget = await hydrateRecord(target);
  const evidence = buildEvidence(fullTarget, plan);
  const messages = buildChatMessages({ question: input.question, history: input.history, evidence, tone: input.tone });
  const meta = { recordId: target.id, personName: target.name, plan };
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (inTauri) {
    // #143：桌面这一支以前只看 invoke 的结果，signal 传进来也没人读；而 Rust 侧 run_ai_chat
    // 一条 session_cancelled() 闸门都没有(任务通道有 lib.rs:712/741/748)。于是「清空对话」或
    // 「发起新一问」(ChartChat 那两条只 abort 本地控制器、不调 cancelAiSession)之后照样白付一次：
    //   · 中止在 invoke **之前** —— 旧代码没有预检，这一次上游调用照发、照落缓存；
    //   · 中止在 invoke **之后** —— 那次调用已经花掉了，至少把结果拦在会话之外，不再显示。
    // 前者能靠这两句止住，后者要靠 Rust 补闸门(#143 的桌面侧那一半仍未闭合)。
    if (input.signal?.aborted) return { status: 'failed', error: '已取消', evidence: meta };
    try {
      const result = await invoke<{ status: string; answer?: string; error?: string; cached?: boolean }>('run_ai_chat', {
        chat: {
          gender: target.gender, birthYear: target.birthYear,
          yearPillar: target.yearPillar, monthPillar: target.monthPillar, dayPillar: target.dayPillar, hourPillar: target.hourPillar,
          question: input.question, tone: input.tone, cached: input.history.length === 0,
        },
        messages,
      });
      if (input.signal?.aborted) return { status: 'failed', error: '已取消', evidence: meta };
      const clean = result.answer ? sanitizeChatText(result.answer) : result.answer;
      if (result.status === 'completed' && !clean) return { status: 'failed', error: '批断返回的正文不是纯中文，已拦下未展示。', evidence: meta };
      return { status: result.status as ChatReply['status'], answer: clean, error: result.error, cached: result.cached, evidence: meta };
    } catch (error) {
      return { status: 'failed', error: readableChannelError(error instanceof Error ? error.message : String(error)), evidence: meta };
    }
  }
  const result = await chatDirect(messages, { signal: input.signal });
  const direct = (result as { answer?: string }).answer;
  const clean = direct ? sanitizeChatText(direct) : direct;
  if (result.status === 'completed' && !clean) return { status: 'failed', error: '批断返回的正文不是纯中文，已拦下未展示。', evidence: meta };
  return { status: result.status as ChatReply['status'], answer: clean, error: (result as { error?: string }).error, evidence: meta };
}
