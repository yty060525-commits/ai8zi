/* =============================================================================
 * AI 聊天(排盘页「问问 AI」) —— 提问理解 → 查库取证 → 思考式回答
 *
 * 与批量分析任务的分工：任务管线产出「确定性事实 + 逐段批断」并全部落库
 * (records.non_ai_result / records.ai_tasks / ai_cache)；聊天不重复推算，
 * 而是把用户问题解析成检索计划(命主/年份/月份/主题)，从数据库精准取证，
 * 让模型仅依据证据作答。
 *
 * 查询与索引配合(见 db.mjs)：
 *  1) 定位命主用 listRecordSummaries —— 只取短列 + (user_id, updated_at) 复合索引，
 *     不为一次提问解析几十 KB 的 non_ai_result JSON；
 *  2) 补读历史批断用 ai_cache 主键精确查找(cache_key)；
 *  3) 聊天答案本身也写入 ai_cache，键含命盘签名段 → 删除/清缓存时按 chart_sig
 *     索引一并清理，不留孤儿行；
 *  4) 首轮(无历史)问题按 归一化问题+命盘+模型+语气档 缓存，同题再问零成本命中。
 * ========================================================================== */
import { createHash } from 'node:crypto';
import { listRecordSummaries, getRecordById, readCache, writeCache } from './db.mjs';
import { natalFactsOf, providerOrder, providerKey, clampTone, toneInstruction, cacheKey, birthTimeSignature, callProvider, PROVIDERS, PROVIDER_LABEL, AI_SERVER_UNCONFIGURED, AI_NO_CREDENTIAL_REPLY } from './ai.mjs';
/* 正文中文闸门：与浏览器端共用的唯一一份实现(features/chart/elements.ts 再导出同一模块)。 */
import { FIELD_NAME_ZH, isChineseOnly, nonChineseKinds, enforceChinese, sanitizeChatText } from '../client/src/shared/chineseGate.ts';
import { factLabels, sectionNames, stableJson, uncoveredTopics } from '../client/src/shared/chatRetrieval.ts';

/* 「本月/今年」这类相对时间锚点按北京口径读，不用宿主时区的本地字段。
   服务端从未设置 process.env.TZ，于是读数取决于部署机：机器不在东八区时，
   UTC 16:00–24:00 这一整天里「本月」会答成上个月、「今年」会答成去年，
   递给模型的证据整段换到另一个年份。与客户端 chatEngine / PersonDetail 同一套收口，
   判据见 client/src/__tests__/beijing-chat-anchor.test.ts 与 server/test/chat-timezone.test.mjs。 */
const chinaParts = (value) => {
  const d = typeof value === 'string' ? new Date(value) : value;
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
};

/* ---------- 提问理解(检索计划) ---------- */
/** 主题规则：命中即作为检索的节标签/证据范围。顺序即展示优先级。 */
export const TOPIC_RULES = [
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

const RELATIVE_YEAR = { 今年: 0, 明年: 1, 后年: 2, 去年: -1, 前年: -2 };

/** 汉字月名 → 月份数字。口语提问里「明年三月」比「明年3月」更常见，只认阿拉伯数字的话
 *  整段月份会凭空消失(只剩流年)，模型就答不出用户真正问的那个月。 */
export const CN_MONTHS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
/** 长名必须排在前面：`十一月` 若让 `一月` 先匹配，会被切成「十」+ 残留的「一月」。 */
const CN_MONTH_ALT = '十一|十二|[一二三四五六七八九十]';

/** 开放式时间问法：问「什么时候/大约在何时/多久」，不指定具体年份，需要扫未来若干年。 */
export const OPEN_TIMING_RE = /什么(时候|时间|年份|时期|阶段|时候能)|哪一?年|何时|多久|几年(内|后|能)|大约在|大致在|何时能/;
/** 扫年窗口：从「起算年」往后取多少年。太短会漏掉晚来的应期，太长则证据与成本失控。 */
export const SCAN_YEARS = 8;

/** 把「本月/下个月/三月/3月」统一解析成 1..12；解不出返回 undefined。单独成函数是为了让分句也能喂进来。 */
function monthFromText(text, now) {
  const q = String(text || '');
  const hit = q.match(/(\d{1,2})\s*月/) || q.match(new RegExp('(' + CN_MONTH_ALT + ')\\s*月'));
  if (hit) {
    const m = /^\d/.test(hit[1]) ? Number(hit[1]) : CN_MONTHS[hit[1]];
    if (m >= 1 && m <= 12) return m;
  }
  /* 北京月份只算一次：下面三个相对月说法共用它(原先「本月」分支自己 return 了一次，
     紧接着又声明同值的 cm —— 那行是永远走不到的死代码)。 */
  const cm = chinaParts(now).month;
  if (/本月|这个月|当月|这月/.test(q)) return cm;
  if (/下个月|下月|来月/.test(q)) return cm + 1 > 12 ? 1 : cm + 1;
  if (/上个月|上月/.test(q)) return cm === 1 ? 12 : cm - 1;
  return undefined;
}

/** 抽取「年份/月份」：支持绝对(2027年)、两位缩写(27年)、相对(今年/明年…)与汉字月份(明年三月)。
 *  三态：具体时段 → {year,month}；开放式时机 → {scan:true,from}；纯本命问题 → {}。
 *  ⚠ 顺序即正确性：先把年月全解析完，最后才决定 scan。旧写法把 scan 分支夹在月份解析之前直接
 *  return，于是「明年三月什么时候发工资」里的月份被整段跳过。 */
export function extractWhen(question, now = new Date()) {
  const q = String(question || '');
  let year; let month;
  /* 「今年/明年/去年」的锚年与「本月」同源，都走北京口径(见文件头 chinaParts 注释)。 */
  const nowYear = chinaParts(now).year;
  const abs = q.match(/(20\d{2})\s*年/) || q.match(/(?:^|[^\d.])(\d{2})\s*年(?![\d])/);
  if (abs) {
    const raw = Number(abs[1]);
    // 两位缩写按当代出生区间回推：命理语境里的「84年」「27年」都指 19xx/20xx，不会是 18xx/21xx。
    // 「24年」→2024(过去)而非 2124；这条回推正是「我告诉他这个月失业，他答我没有24年信息」的根因：
    // 旧正则只吃 20\d{2}，「24年」解不出 → 继承上一轮年份 → 递给模型的证据全是另一年的批断。
    year = String(raw).length === 4 ? raw : raw > 30 ? 1900 + raw : 2000 + raw;
  }
  if (year === undefined) {
    for (const [word, delta] of Object.entries(RELATIVE_YEAR)) {
      if (q.includes(word)) { year = nowYear + delta; break; }
    }
  }
  month = monthFromText(q, now);
  if (month !== undefined && year === undefined) {
    const currentMonth = chinaParts(now).month;
    const yearDelta = /下个月|下月|来月/.test(q) && currentMonth === 12 ? 1 : /上个月|上月/.test(q) && currentMonth === 1 ? -1 : 0;
    year = nowYear + yearDelta;
  } // 月份必然锚定在某一年
  // 年份与月份都没落地、且句子确实在开放式问时机 → 才转扫年。「明年什么时候」有年份锚点，不走这里。
  if (year === undefined && month === undefined && OPEN_TIMING_RE.test(q)) {
    const rel = Object.entries(RELATIVE_YEAR).find(([word]) => q.includes(word));
    return { year: undefined, month: undefined, scan: true, from: nowYear + (rel ? rel[1] : 0) };
  }
  return { year, month };
}

/** 从句子里挑出承载「所问时段」的那一小句再解析时间。
 *  「我本月失业了，接下来财运怎么样」的时间锚点在前半句；整句一起匹配时容易被后半句的
 *  「什么时候」之类干扰词带偏，所以按子句边界切开逐句试，第一个命中的即为所问时段。 */
function whenOfQuestion(q, now) {
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

/** 泛问识别：没命中任何主题词、但确实在问整体状况或适配方向。
 *  不识别它，「我这个人怎么样」「适合做什么工作」只能拿到本命批断的开头几百字，
 *  【核心结论】与【事业适配】永远进不了上下文 —— 这是「答不到点子上」的头号来源。 */
export const GENERAL_QUESTION_RE = /怎么样|如何|怎样|总体|整体|全面|概括|一生|一辈子|此命|命局|格局|此人|这个人|适合|方位|方向|行业|从事|发展|注意什么|运势|运程|运气|缺什么|喜用/;

/** 检索计划：命主(按姓名在已存记录中匹配，长名优先防「张三丰」被「张三」截胡) + 时间 + 主题。
 *  时间三态见 whenOfQuestion：具体时段 / scan(开放式时机，扫未来若干年) / 都没有(纯本命问题)。
 *  general=true 表示「泛问」：没抽到主题词但确实在问整体或适配方向，取证时按全主题铺开。 */
export function analyzeQuestion(question, summaries, now = new Date()) {
  const q = String(question || '');
  const matched = [];
  for (const s of summaries) {
    const name = String(s.name || '').trim();
    if (name && q.includes(name)) matched.push(s);
  }
  matched.sort((a, b) => String(b.name).length - String(a.name).length);
  const when = whenOfQuestion(q, now);
  const topics = TOPIC_RULES.filter((rule) => rule.re.test(q)).flatMap((rule) => [rule.topic]);
  return {
    recordId: matched[0]?.id ?? null,
    personName: matched[0]?.name ?? null,
    matchedCount: matched.length,
    year: when.year, month: when.month,
    scan: when.scan === true, scanFrom: when.from,
    question: q,
    topics: [...new Set(topics)],
    general: topics.length === 0 && GENERAL_QUESTION_RE.test(q),
  };
}

/* ---------- 查库取证 ---------- */
/** 批断正文里可能出现的【小节】标签全集：提问主题(健康/事业/…)与独立小节名(核心结论/…)的并集。
 *  提问主题里的「大运」「格局」「神煞」「五行」「流月」不在这里——它们不是批断小节的标签，
 *  但必须能落进 labels，否则过滤条件会被整条跳过、把全部小节都当成命中返回。 */
export const KNOWN_SECTION_LABELS = [
  '健康', '事业', '财运', '爱情', '刑冲克害批注', '后天调整', '事业适配', '健康注意',
  '核心结论', '值得关注的时间节点', '行动建议', '身强身弱与喜忌',
];

/** 从批断正文里只截取与提问主题相关的【小节】，控制上下文体积(命中率/成本)。
 *  ⚠ 兜底路径取的是**开头** capPer 字，而命盘正文开头通常是【身强身弱与喜忌】这类技术节，
 *  【核心结论】【行动建议】在更靠后的位置 —— 所以调用方在无主题命中时不能只靠这个兜底。 */
/** 按句读/条目收口的截断：正文超过 cap 时，退到 cap 之内最后一个句末标点或换行处切，
 *  不把一句话或一条编号要点拦腰砍断(结论段被切一半正是取证失真的来源)。找不到合适切点
 *  (首句就超长)时才切满 cap，但设一个下限避免只剩一两个字。 */
export function cutAtBoundary(text, cap) {
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

export function sliceSections(text, topics, capPer = 700) {
  const source = String(text || '');
  if (!source) return '';
  const labels = (Array.isArray(topics) && topics.length ? topics : []).slice();
  const realLabels = labels.filter((t) => KNOWN_SECTION_LABELS.includes(t));
  const blocks = [];
  const seen = new Set();
  const all = source.split(/(?=【)/);
  for (const part of all) {
    const m = part.match(/^【([^】]+)】([\s\S]*)/);
    if (!m) continue;
    const label = m[1].trim(); const body = cutAtBoundary(m[2].trim(), capPer);
    // 提问主题里存在真实小节标签时才按标签过滤；只问「大运/格局」这类非小节主题时不过滤
    if (realLabels.length && !realLabels.some((t) => label.includes(t))) continue;
    if (!body.trim()) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    blocks.push('【' + label + '】' + body);
  }
  if (blocks.length) return blocks.join('\n');
  return labels.length || /【[^】]+】/.test(source) ? '' : cutAtBoundary(source, capPer);
}

const findTask = (tasks, type) => tasks.find((r) => r?.task?.type === type && r.status === 'completed' && r.analysis);
const taskOfYear = (tasks, type, year, month) => tasks.find((r) => r?.task?.type === type
  && Number(r?.task?.year) === Number(year) && (month === undefined || Number(r?.task?.month) === Number(month))
  && r.status === 'completed' && r.analysis);
// 大运任务按「起运年」存；所问年份多半落在某步运中段，须先用 greatFortunes 找出覆盖它的运、按起运年取，
// 否则只有正好问起运年那一年才命中，其余九年的「所处大运批断」静默丢失(模型只剩流年，看十年走向就失真)。
// greatFortunes 缺失时退回精确匹配，不比以前更差。
const coveringDecadeStart = (record, year) => {
  const rows = record?.nonAiResult?.greatFortunes;
  if (Array.isArray(rows)) { const g = rows.find((r) => Number(r.startYear) <= Number(year) && Number(year) <= Number(r.endYear)); if (g) return Number(g.startYear); }
  return undefined;
};
const decadeOf = (record, tasks, year) => {
  const keyYear = coveringDecadeStart(record, year) ?? Number(year);
  return tasks.find((r) => r?.task?.type === 'decade' && Number(r?.task?.year) === keyYear && r.status === 'completed' && r.analysis)
    || tasks.find((r) => r?.task?.type === 'decade' && r?.task?.decade && Number(r.task.decade.startYear) <= Number(year) && Number(year) <= Number(r.task.decade.endYear) && r.status === 'completed' && r.analysis);
};

/** 按任务参数从 ai_cache 精确补读(主键查找)：记录里 aiTasks 未同步全时，缓存仍是权威来源。 */
function cacheLookup(db, record, task, tone, providers) {
  for (const provider of (providers.length ? providers : PROVIDERS)) {
    const hit = readCache(db, cacheKey(record, task, provider.model, tone));
    if (hit) { try { return JSON.parse(hit); } catch { /* 坏缓存忽略 */ } }
  }
  return null;
}

function addAnalysis(evidence, record, result, heading, text, meta = {}) {
  const body = String(text || '').trim();
  if (!body) return false;
  if (meta.includeInAnalyses !== false) evidence.analyses.push({ heading, text: body });
  const task = result?.task || {};
  const source = { kind: 'analysis', recordId: record.id, heading, sections: sectionNames(body), text: body, origin: meta.origin || 'record' };
  if (task.taskId) source.taskId = task.taskId;
  if (task.type) source.taskType = task.type;
  const year = meta.year ?? task.year; const month = meta.month ?? task.month;
  if (year !== undefined) source.year = year;
  if (month !== undefined) source.month = month;
  evidence.sources.push(source);
  return true;
}

function addFactSources(evidence, record) {
  const natalSections = factLabels(evidence.natal);
  if (natalSections.length) evidence.sources.push({ kind: 'natal', recordId: record.id, heading: '本命事实', sections: natalSections });
  if (evidence.periodFacts && typeof evidence.periodFacts === 'object') {
    const labels = { annual: '流年事实', annualHits: '流年干支关系', decade: '大运事实', decadeHits: '大运干支关系', monthly: '流月事实', monthlyHits: '流月干支关系', age: '所问年龄' };
    const sections = factLabels(evidence.periodFacts, labels);
    if (sections.length) evidence.sources.push({ kind: 'period', recordId: record.id, heading: '所问时段事实', year: evidence.plan.year ?? evidence.plan.scanFrom, month: evidence.plan.month, sections });
  }
}

function topicSlice(explanation, labels, cap = 700) {
  const source = String(explanation || '');
  const sliced = sliceSections(source, labels, cap);
  return sliced || (!/【[^】]+】/.test(source) ? cutAtBoundary(source, cap) : '');
}

/** 汇总本次提问需要的全部数据库证据。 */
export function collectEvidence(db, record, plan, { tone = 80, periodFacts, providers = [] } = {}) {
  const tasks = record.aiTasks ? Object.values(record.aiTasks) : [];
  const wantTopics = Array.isArray(plan.topics) ? plan.topics : [];
  const evidence = {
    person: { id: record.id, name: record.name, gender: record.gender, birthYear: record.birthYear, birthMonth: record.birthMonth },
    plan: { year: plan.year, month: plan.month, topics: wantTopics, scan: plan.scan === true, scanFrom: plan.scanFrom },
    natal: natalFactsOf(record),
    analyses: [],
    missing: [],
    sources: [],
  };
  const wantsScan = plan.scan === true;
  const wantsPeriod = plan.year !== undefined || wantsScan;
  const wantsNatal = !wantsPeriod;
  // 「泛问」(我这个人怎么样/适合做什么)：没有主题词可当节标签，但用户要的恰恰是最依赖全局结论的那类答案。
  // 此时把本命 + 全盘总结 + 后天调整三份都端出来，并把可用小节标题清单交给模型按问题挑 —— 仍属取证，不属推测。
  const isGeneral = wantTopics.length === 0 && plan.general === true;
  if (wantsNatal || wantTopics.length === 0 || wantTopics.some((t) => ['五行', '格局', '神煞'].includes(t))) {
    const baseline = findTask(tasks, 'baseline');
    if (baseline) {
      if (!addAnalysis(evidence, record, baseline, '本命批断', topicSlice(baseline.analysis.explanation, wantTopics.length ? [...wantTopics, '身强身弱与喜忌'] : [], 900))) evidence.missing.push('本命批断已完成，但没有可用于回答的正文');
    }
    const adjustment = findTask(tasks, 'adjustment');
    if (adjustment && (wantTopics.length === 0 || wantTopics.includes('五行'))) addAnalysis(evidence, record, adjustment, '后天调整与职业', sliceSections(adjustment.analysis.explanation, ['后天调整', '事业适配', '健康注意']));
    const overview = findTask(tasks, 'overview');
    if (overview && wantTopics.length === 0) addAnalysis(evidence, record, overview, '全盘总结', sliceSections(overview.analysis.explanation, ['核心结论', '值得关注的时间节点', '行动建议']));
    if (!baseline) evidence.missing.push('本命批断尚未生成：可先在命盘详情页点批断分析');
    if (isGeneral) {
      const available = [...new Set(evidence.analyses.flatMap((a) => sectionNames(a.text)))];
      if (available.length) evidence.sectionIndex = available;
    }
  }
  if (wantsScan) {
    // 开放式时机提问：把未来若干年的流年批断逐条列成时间线，让模型在证据里挑年限，
    // 而不是被迫回答「数据库里没有」。缺哪一年就逐个点名，别再笼统说「没有数据」。
    const labels = wantTopics.length ? wantTopics : ['健康', '事业', '财运', '爱情', '刑冲克害批注'];
    const from = Number(plan.scanFrom ?? chinaParts(new Date()).year);
    const lines = [];
    const gaps = [];
    const uncovered = [];
    for (let y = from; y < from + SCAN_YEARS; y += 1) {
      let annual = taskOfYear(tasks, 'annual', y);
      let annualOrigin = 'record';
      if (!annual) { const a = cacheLookup(db, record, { type: 'annual', year: y, month: undefined }, tone, providers); if (a) { annual = { status: 'completed', analysis: a, task: { type: 'annual', year: y } }; annualOrigin = 'task_cache'; } }
      if (!annual) { gaps.push(y); continue; }
      const body = sliceSections(annual.analysis.explanation, labels, 260);
      // 该年批断存在，但按提问主题过滤后一个字都没有 → 这一年答不了这个问题，必须点名
      if (!body) uncovered.push(y);
      lines.push(String(y) + '年(' + String(annual.analysis.title || '') + ')：' + body);
      if (body) {
        addAnalysis(evidence, record, annual, String(y) + '年流年批断', body, { year: y, origin: annualOrigin, includeInAnalyses: false });
        const absent = uncoveredTopics(body, wantTopics);
        if (absent.length) evidence.missing.push(String(y) + '年流年批断缺少所问主题：' + absent.join('、'));
      }
    }
    if (lines.length) {
      evidence.analyses.push({ heading: from + '年至' + (from + SCAN_YEARS - 1) + '年逐年批断，用于判断应期', text: lines.join('\n') });
      // 起算年所在大运：判断这十年运势走向，缺了它只看流年会失真
      const decade = decadeOf(record, tasks, from);
      const decadeYear = coveringDecadeStart(record, from) ?? Number(from);
      let decadeHit = decade; let decadeOrigin = 'record';
      if (!decadeHit) { const d = cacheLookup(db, record, { type: 'decade', year: decadeYear }, tone, providers); if (d) { decadeHit = { status: 'completed', analysis: d, task: { type: 'decade', year: decadeYear } }; decadeOrigin = 'task_cache'; } }
      if (decadeHit) addAnalysis(evidence, record, decadeHit, '所处大运批断', sliceSections(decadeHit.analysis.explanation, labels), { origin: decadeOrigin });
    } else {
      evidence.missing.push(from + '年至' + (from + SCAN_YEARS - 1) + '年的流年批断一条都还没生成，无法判断应期');
    }
    if (gaps.length) evidence.missing.push('下列年份尚未生成流年批断，作答时只能在这些年份之外给应期：' + gaps.join('、') + '年');
    if (uncovered.length) evidence.missing.push('下列年份虽有流年批断，但其中没有与所问主题相关的小节，不得据其判断该主题的应期：' + uncovered.join('、') + '年');    if (periodFacts && typeof periodFacts === 'object') evidence.periodFacts = periodFacts;
    addFactSources(evidence, record);
    return evidence;
  }
  if (wantsPeriod) {
    const labels = wantTopics.length ? wantTopics : ['健康', '事业', '财运', '爱情', '刑冲克害批注'];
      let annual = taskOfYear(tasks, 'annual', plan.year); let annualOrigin = 'record';
      if (!annual) { const a = cacheLookup(db, record, { type: 'annual', year: plan.year, month: undefined }, tone, providers); if (a) { annual = { status: 'completed', analysis: a, task: { type: 'annual', year: plan.year } }; annualOrigin = 'task_cache'; } }
      if (annual) {
        const heading = plan.year + '年流年批断，题为' + String(annual.analysis.title || '');
        const body = topicSlice(annual.analysis.explanation, labels);
        if (!addAnalysis(evidence, record, annual, heading, body, { year: plan.year, origin: annualOrigin })) evidence.missing.push(plan.year + '年的流年批断没有与所问主题相关的小节（' + wantTopics.join('、') + '），无法据此回答');
        else { const absent = uncoveredTopics(body, wantTopics); if (absent.length) evidence.missing.push(plan.year + '年流年批断缺少所问主题：' + absent.join('、')); }
      }
    else evidence.missing.push(plan.year + '年的流年分析尚未生成');
    const decadeYear = coveringDecadeStart(record, plan.year) ?? Number(plan.year);
    let decade = decadeOf(record, tasks, plan.year);
      let decadeOrigin = 'record';
      if (!decade) { const d = cacheLookup(db, record, { type: 'decade', year: decadeYear }, tone, providers); if (d) { decade = { status: 'completed', analysis: d, task: { type: 'decade', year: decadeYear } }; decadeOrigin = 'task_cache'; } }
      if (decade) {
        const body = topicSlice(decade.analysis.explanation, labels);
        if (!addAnalysis(evidence, record, decade, '所处大运批断', body, { origin: decadeOrigin })) evidence.missing.push(plan.year + '年所处大运批断没有与所问主题相关的小节');
        else { const absent = uncoveredTopics(body, wantTopics); if (absent.length) evidence.missing.push(plan.year + '年所处大运批断缺少所问主题：' + absent.join('、')); }
      }
    if (plan.month !== undefined) {
      let monthly = taskOfYear(tasks, 'monthly', plan.year, plan.month);
      let monthlyOrigin = 'record';
      if (!monthly) { const mm = cacheLookup(db, record, { type: 'monthly', year: plan.year, month: plan.month }, tone, providers); if (mm) { monthly = { status: 'completed', analysis: mm, task: { type: 'monthly', year: plan.year, month: plan.month } }; monthlyOrigin = 'task_cache'; } }
      if (monthly) {
        const heading = plan.year + '年' + plan.month + '月流月批断';
        const body = topicSlice(monthly.analysis.explanation, labels);
        if (!addAnalysis(evidence, record, monthly, heading, body, { year: plan.year, month: plan.month, origin: monthlyOrigin })) evidence.missing.push(plan.year + '年' + plan.month + '月流月批断没有与所问主题相关的小节');
        else { const absent = uncoveredTopics(body, wantTopics); if (absent.length) evidence.missing.push(plan.year + '年' + plan.month + '月流月批断缺少所问主题：' + absent.join('、')); }
      }
      else evidence.missing.push(plan.year + '年' + plan.month + '月的流月分析尚未生成');
    }
    // 时段干支事实：记录里是瘦身存储，客户端随请求带来引擎现算的当期行(仍是确定性计算结果，非模型发挥)
    if (periodFacts && typeof periodFacts === 'object') evidence.periodFacts = periodFacts;
  }
  addFactSources(evidence, record);
  return evidence;
}

/* ---------- 对话消息构建 ---------- */
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

/* ── 正文中文闸门：唯一实现在 shared/chineseGate.ts，浏览器端经 features/chart/elements.ts 再导出。
 *    服务器直接 import 同一份 —— 两端曾各抄一遍，改一处忘另一处会让同一命盘在不同通道
 *    给出干净度不同的正文(一边漏括号、一边整段拦掉)。Node ≥22.6 可原生载入 .ts。 ── */
export { FIELD_NAME_ZH, isChineseOnly, nonChineseKinds, enforceChinese, sanitizeChatText } from '../client/src/shared/chineseGate.ts';

/** 证据摘要压成一段稳定前缀(同盘同题逐字节一致，吃上游前缀缓存)，可变尾巴只有问题本身。 */
export function buildChatMessages({ question, history = [], evidence, tone = 80 }) {
  const evidenceText = '# 命盘事实(JSON)\n' + stableJson(evidence.natal)
    + (evidence.periodFacts ? '\n\n# 所问时段运势数据(JSON)\n' + stableJson(evidence.periodFacts) : '')
    + '\n\n# 已算批断摘录\n' + (evidence.analyses.map((a) => '## ' + a.heading + '\n' + a.text).join('\n\n') || '（数据库中暂无该主题的已算批断）')
    + (evidence.missing?.length ? '\n\n# 数据缺口提示\n' + evidence.missing.map((m) => '- ' + m).join('\n') : '');
  const messages = [{ role: 'system', content: CHAT_SYSTEM }];
  for (const item of history.slice(-8)) {
    if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim()) {
      messages.push({ role: item.role, content: item.content.slice(0, 2000) });
    }
  }
  // 小节清单放在证据之后：它随命盘内容变化，不属于可缓存的稳定前缀。
  const sectionIndexText = evidence.sectionIndex?.length
    ? '\n\n# 本盘已算出的批断小节(只能从中选取作答，不得自行补写没有的小节)\n' + evidence.sectionIndex.map((s) => '【' + s + '】').join('、')
    : '';
  const planText = '\n\n# 本轮检索计划\n命主：' + evidence.person.name + '，记录：' + evidence.person.id
    + '\n年份：' + (evidence.plan.year ?? '未指定') + '\n月份：' + (evidence.plan.month ?? '未指定')
    + '\n主题：' + (evidence.plan.topics.join('、') || '未指定')
    + (evidence.plan.scan ? '\n扫年范围：' + evidence.plan.scanFrom + '年至' + (Number(evidence.plan.scanFrom) + SCAN_YEARS - 1) + '年' : '');
  const sourceDirectory = evidence.sources?.length
    ? '\n\n# 本轮检索资料目录\n' + evidence.sources.map((source) => '【' + source.heading + '】' + source.sections.join('、')
      + '；记录：' + source.recordId + (source.taskId ? '；任务：' + source.taskId : '')
      + (source.taskType ? '；类型：' + source.taskType : '') + (source.year !== undefined ? '；年份：' + source.year : '')
      + (source.month !== undefined ? '；月份：' + source.month : '') + (source.origin ? '；来源：' + source.origin : '')).join('\n')
    : '\n\n# 本轮检索资料目录\n无可用资料来源';
  messages.push({
    role: 'user',
    content: evidenceText + sectionIndexText + planText + sourceDirectory
      + '\n\n# 语气要求\n' + toneInstruction(tone)
      + '\n\n# 用户问题\n' + String(question || '').slice(0, 500),
  });
  return messages;
}

/* ---------- 聊天答案缓存与追问 ---------- */
/** 键位与任务缓存同构(第 2..6 段=性别+四柱) → chart_sig 索引自动覆盖聊天缓存。
 *  仅缓存首轮(无历史)答案：追问的答案依赖上文，键里放不下整段上文，做了就会张冠李戴。 */
export function chatCacheKey(record, question, model, tone, messages) {
  if (messages === undefined) throw new TypeError('chatCacheKey requires the exact messages used for this answer');
  const toneBucket = Math.round(clampTone(tone) / 5) * 5;
  const qhash = createHash('sha256').update(String(question).trim()).digest('hex').slice(0, 24);
  const evidenceHash = createHash('sha256').update(stableJson(messages)).digest('hex').slice(0, 24);
  // chatv3：大运取证改「覆盖年」匹配后，问中段年份(非起运年)的旧缓存里缺「所处大运批断」，只凭流年会把十年走向答偏 → 整体失效重取。
  //        (v2 那次是为「年份解错→证据是另一年的批断」，同属"检索口径变了旧答案必须作废"。)
  // chatv4：本命事实 natal 新增「调候参考」(natal.tiaohouFacts)，本命/喜忌类问答的作答口径随之变化，
  //        旧缓存里那套未含调候的答案一并作废重答。
  // chatv5：系统提示词改为「正文限死纯中文 + 禁止引用出处」，并加了确定性中文闸门(清洗不过即拦下)。
  //        旧缓存答案普遍带英文字段名、阿拉伯数字或「依据某小节」的出处说明，按新口径一律作废重写。
  // chatv6：正式版口径下证据标题与缺口提示不再出现括号、斜杠与「AI」字样(改读成中文)，
  //        提示词里指向入口的说法也从「点「AI 分析」」改成「点批断分析」。旧答案引用的正是那批措辞，作废重答。
  // chatv7：起运结论按完整出生时刻区分，旧盘以空尾段维持原缓存语义。
  return ['chatv8', model, record.gender, record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar, 'chat', qhash, record.birthYear, toneBucket, evidenceHash, birthTimeSignature(record.nonAiResult?.birthTime)].join('|');
}

/** 本轮问题自带的人名要能覆盖上一轮命主。返回 {personName, recordId}；解不出则 null。 */
function personFromText(text, summaries) {
  const q = String(text || '');
  let best = null;
  for (const s of summaries || []) {
    const name = String(s.name || '').trim();
    if (name && q.includes(name) && (!best || name.length > String(best.name).length)) best = s;
  }
  return best ? { personName: best.name, recordId: best.id ?? null } : null;
}

/** 追问继承上文语境：上一轮问的是 2026 年爱情，这轮一句「那我明年呢」不该退化成全新问题。
 *  只做「有历史且本轮自己没说时间/主题」时的补全，本轮若已明说就以本轮为准。
 *  summaries 传入时会做人名继承/切换：本轮自己点了别的名字 → 换人；只说「那她呢」→ 沿用上一个人。 */
export function applyFollowUp(plan, history, summaries = [], now = new Date()) {
  if (!Array.isArray(history) || history.length === 0) return plan;
  const asksClarify = /^[?？唔嗯哦啊这那]+$/.test(String(plan.question ?? '').trim());
  if (asksClarify) return plan;
  // 往前找到最近一条**点过人名**的用户消息，而不是只看上一条(「那她呢」这种短追问本身不含名字)。
  const userTurns = history.filter((m) => m?.role === 'user' && typeof m.content === 'string');
  let prevPerson = null;
  for (let i = userTurns.length - 1; i >= 0 && !prevPerson; i -= 1) prevPerson = personFromText(userTurns[i].content, summaries);
  const prevUser = userTurns[userTurns.length - 1];
  const prevAssistant = [...history].reverse().find((m) => m?.role === 'assistant' && typeof m.content === 'string');
  const source = [prevUser?.content, prevAssistant?.content, plan.question].filter(Boolean).join('\n');
  const next = { ...plan };
  // 人名：本轮自己说了就按本轮的来(可能换人)，没说才沿用上一轮，避免整段对话锁死在第一个命主上。
  const thisTurn = personFromText(plan.question, summaries);
  if (!thisTurn && prevPerson) { next.personName = prevPerson.personName; next.recordId = prevPerson.recordId; next.inheritedPerson = true; }
  else if (thisTurn) { next.personName = thisTurn.personName; next.recordId = thisTurn.recordId; }
  if (!plan.topics?.length) {
    const inherited = TOPIC_RULES.filter((rule) => rule.re.test(source)).flatMap((rule) => [rule.topic]);
    // 主题与泛问互斥：继承了具体主题就关掉泛问铺开，否则「那她呢」会把本命+全盘+调整三份长证据全塞进来。
    if (inherited.length) { next.topics = [...new Set(inherited)]; next.general = false; }
    else next.general = plan.general === true && GENERAL_QUESTION_RE.test(source);
  }
  if (next.year === undefined && !next.scan) {
    const inheritedWhen = whenOfQuestion(prevUser?.content ?? '', now);
    if (inheritedWhen.year !== undefined) { next.year = inheritedWhen.year; next.month = inheritedWhen.month; }
    else if (inheritedWhen.scan) { next.scan = true; next.scanFrom = inheritedWhen.from; }
  }
  return next;
}

function validatePeriodFacts(facts, context, record, plan) {
  const requestedYear = plan.year ?? (plan.scan ? plan.scanFrom : undefined);
  if (!facts || typeof facts !== 'object' || !context || typeof context !== 'object'
      || context.recordId !== record.id || requestedYear === undefined || Number(context.year) !== Number(requestedYear)
      || (context.month === undefined ? plan.month !== undefined : Number(context.month) !== Number(plan.month))) return undefined;
  const out = {};
  if (facts.annual && Number(facts.annual.year) === Number(requestedYear)) { out.annual = facts.annual; if (Array.isArray(facts.annualHits)) out.annualHits = facts.annualHits; }
  else if (facts.annual) return undefined;
  if (facts.monthly && plan.month !== undefined && Number(facts.monthly.year) === Number(requestedYear) && Number(facts.monthly.month) === Number(plan.month)) { out.monthly = facts.monthly; if (Array.isArray(facts.monthlyHits)) out.monthlyHits = facts.monthlyHits; }
  else if (facts.monthly) return undefined;
  if (facts.decade && Number(facts.decade.startYear) <= Number(requestedYear) && Number(requestedYear) <= Number(facts.decade.endYear)) { out.decade = facts.decade; if (Array.isArray(facts.decadeHits)) out.decadeHits = facts.decadeHits; }
  else if (facts.decade) return undefined;
  if (!out.annual && !out.monthly && !out.decade) return undefined;
  out.age = Number(requestedYear) - Number(record.birthYear);
  return out;
}

/* ---------- 入口 ---------- */
export async function runChat(db, user, body = {}, opts = {}) {
  const question = String(body.question || '').trim();
  if (!question) return { status: 'failed', error: '请输入问题' };
  if (question.length > 500) return { status: 'failed', error: '问题过长，请控制在五百字以内' };
  const tone = clampTone(body.tone ?? 80);
  const summaries = listRecordSummaries(db, user.id);
  if (summaries.length === 0) return { status: 'need_record', reason: '还没有任何命盘：请先在排盘页保存一条记录，再向我提问' };
  const providers = providerOrder(db, body.provider);

  // 目标命盘一律从「本人名下」的轻列表里解析(recordId 也必须命中)，杜绝越权读取他人记录。
  const history = Array.isArray(body.history) ? body.history : [];
  // summaries 传进 applyFollowUp：追问时才能认出「那她呢」该沿用上一个人、「换成李四呢」该换人。
  const currentPlan = analyzeQuestion(question, summaries);
  const plan = applyFollowUp(currentPlan, history, summaries, new Date());
  let suppliedTarget = null;
  if (body.recordId) {
    suppliedTarget = summaries.find((s) => s.id === String(body.recordId)) || null;
    if (!suppliedTarget && user.role === 'admin') {
      const foreign = getRecordById(db, String(body.recordId));
      if (foreign) suppliedTarget = { id: foreign.id, name: foreign.name };
    }
    if (!suppliedTarget) return { status: 'failed', error: '记录不存在或无权访问' };
  }
  const namedTarget = currentPlan.recordId ? summaries.find((s) => s.id === currentPlan.recordId) : null;
  let target = namedTarget || suppliedTarget || (plan.recordId ? summaries.find((s) => s.id === plan.recordId) : null);
  if (!target && summaries.length === 1) target = summaries[0];
  if (!target) return { status: 'need_record', reason: '你的名下有多条命盘，请告诉我问的是谁，或点选下方命主', options: summaries.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updated_at ?? s.updatedAt })) };

  const actualPlan = { ...plan, recordId: target.id, personName: target.name };

  const record = getRecordById(db, target.id);
  if (!record) return { status: 'failed', error: '记录读取失败' };
  const periodFacts = validatePeriodFacts(body.periodFacts, body.periodFactsContext, record, actualPlan);
  const evidence = collectEvidence(db, record, actualPlan, { tone, periodFacts, providers });
  const messages = buildChatMessages({ question, history, evidence, tone });
  const cacheable = history.length === 0; // 追问依赖上下文，不缓存
  const evidenceMeta = { recordId: record.id, personName: record.name, plan: actualPlan, sources: evidence.sources, missing: evidence.missing };  // 先查缓存：即便服务器当前没有配置任何密钥(或密钥被移除)，已入库的答案仍应可复用。
  // 缓存也过一遍去英文：早先落库的答案可能残留英文字段名，读时顺手洗净。
  if (cacheable) {
    for (const model of (providers.length ? providers.map((p) => p.model) : PROVIDERS.map((p) => p.model))) {
      const hit = readCache(db, chatCacheKey(record, question, model, tone, messages));
      if (hit) { const clean = sanitizeChatText(hit); if (clean) return { status: 'completed', answer: clean, cached: true, evidence: evidenceMeta }; }
    }
  }
  if (providers.length === 0) return { status: 'not_configured', error: AI_SERVER_UNCONFIGURED };
  const errors = [];
  /* 客户端断开(点「停止」/「清空对话」)后：不再换下一条通道，也不把这份没人读的答案写进缓存。
     后者尤其要紧 —— 首轮问答按 (record, question, model, tone) 落缓存，用户点停止往往正因为
     模型在跑偏；一旦让它占住这个键，下次重问同一句直接命中缓存、原样返回同一个坏答案。 */
  const abandoned = () => !!opts.signal?.aborted;
  for (const provider of providers) {
    if (abandoned()) return { status: 'failed', error: '这一问已经被取消，没有继续调用通道。', evidence: evidenceMeta };
    const ck = cacheable ? chatCacheKey(record, question, provider.model, tone, messages) : null;
    // opts.callProvider 只给测试留的接缝：#139 要直接钉住「路由有没有把请求中止接到通道调用上」，
    // 而真实 callProvider 内部自己 new AbortController，从外面只能间接看到转发给 fetch 的 signal。
    const result = await (opts.callProvider || callProvider)(provider, providerKey(db, provider.id), messages, 'high', 'text', opts.signal);
    if (result.text) {
      const clean = sanitizeChatText(result.text);
      // 洗净后为空 = 模型整段跑成英文，当作该 provider 失败，换下一个通道再试
      if (!clean) { errors.push(PROVIDER_LABEL[provider.id] + '：模型输出不是中文'); continue; }
      if (ck && !abandoned()) { try { writeCache(db, ck, clean); } catch { /* 写缓存失败不影响回答 */ } }
      return { status: 'completed', answer: clean, cached: false, evidence: evidenceMeta };
    }
    // 报错里必须用中文通道名：provider.id 是协议层标识(deepseek/kimi/qwen)，直接拼进 error
    // 会让客户端那句 sanitizeAnalysisText(error) || '回答失败' 整段判空 —— 原因反而丢了。
    errors.push(PROVIDER_LABEL[provider.id] + '：' + sanitizeChatText(result.error || ''));
  }
  // 全链路最后一道：errors 里若还残留闸门不认的形态(括号、数字)，整串清洗后再返回；
  // 清洗后为空则退回一句固定中文，保证「哪条通道、为什么没成」不会以半句英文的形式上屏。
  const joined = sanitizeChatText(errors.join('；'));
  return { status: 'failed', error: joined || AI_NO_CREDENTIAL_REPLY, evidence: evidenceMeta };
}
