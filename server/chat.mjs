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
import { natalFactsOf, providerOrder, providerKey, clampTone, toneInstruction, cacheKey, callProvider, PROVIDERS } from './ai.mjs';

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

/** 开放式时间问法：问「什么时候/大约在何时/多久」，不指定具体年份，需要扫未来若干年。 */
export const OPEN_TIMING_RE = /什么(时候|时间|年份|时期|阶段|时候能)|哪一?年|何时|多久|几年(内|后|能)|大约在|大致在|何时能/;
/** 扫年窗口：从「起算年」往后取多少年。太短会漏掉晚来的应期，太长则证据与成本失控。 */
export const SCAN_YEARS = 8;

/** 抽取「年份/月份」：支持绝对(2027年)与相对(今年/明年/本月/下个月…)表达。
 *  三态：具体年份 → {year}；明确问开放式时机 → {scan:true, from}；纯本命问题 → {}。 */
export function extractWhen(question, now = new Date()) {
  const q = String(question || '');
  let year; let month;
  const abs = q.match(/(20\d{2})\s*年/);
  if (abs) year = Number(abs[1]);
  if (year === undefined) {
    for (const [word, delta] of Object.entries(RELATIVE_YEAR)) {
      if (q.includes(word)) { year = now.getFullYear() + delta; break; }
    }
  }
  // 「明年什么时候」这种：句子里有明确年份锚点，不算开放式扫描，仍按那一年精确取证
  if (year === undefined && OPEN_TIMING_RE.test(q)) {
    const rel = Object.entries(RELATIVE_YEAR).find(([word]) => q.includes(word));
    return { year: undefined, month: undefined, scan: true, from: now.getFullYear() + (rel ? rel[1] : 0) };
  }
  const monthMatch = q.match(/(\d{1,2})\s*月/);
  if (monthMatch) {
    const m = Number(monthMatch[1]);
    if (m >= 1 && m <= 12) month = m;
  } else if (/本月|这个月|当月/.test(q)) month = now.getMonth() + 1;
  else if (/下个月|下月|来月/.test(q)) month = now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2;
  else if (/上个月|上月/.test(q)) month = now.getMonth() === 0 ? 12 : now.getMonth();
  if (month !== undefined && year === undefined) year = now.getFullYear(); // 月份必然锚定在某一年
  return { year, month };
}

/** 检索计划：命主(按姓名在已存记录中匹配，长名优先防「张三丰」被「张三」截胡) + 时间 + 主题。
 *  时间三态见 extractWhen：具体年份 / scan(开放式时机，扫未来若干年) / 都没有(纯本命问题)。 */
export function analyzeQuestion(question, summaries, now = new Date()) {
  const q = String(question || '');
  const matched = [];
  for (const s of summaries) {
    const name = String(s.name || '').trim();
    if (name && q.includes(name)) matched.push(s);
  }
  matched.sort((a, b) => String(b.name).length - String(a.name).length);
  const when = extractWhen(q, now);
  const topics = TOPIC_RULES.filter((rule) => rule.re.test(q)).flatMap((rule) => [rule.topic]);
  return {
    recordId: matched[0]?.id ?? null,
    personName: matched[0]?.name ?? null,
    matchedCount: matched.length,
    year: when.year, month: when.month,
    scan: when.scan === true, scanFrom: when.from,
    question: q,
    topics: [...new Set(topics)],
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

/** 从批断正文里只截取与提问主题相关的【小节】，控制上下文体积(命中率/成本)。 */
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
    const label = m[1].trim(); const body = m[2].trim().slice(0, capPer);
    // 提问主题里存在真实小节标签时才按标签过滤；只问「大运/格局」这类非小节主题时不过滤
    if (realLabels.length && !realLabels.some((t) => label.includes(t))) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    blocks.push('【' + label + '】' + body);
  }
  if (blocks.length) return blocks.join('\n');
  return labels.length ? '' : source.slice(0, capPer);
}

const findTask = (tasks, type) => tasks.find((r) => r?.task?.type === type && r.status === 'completed' && r.analysis);
const taskOfYear = (tasks, type, year, month) => tasks.find((r) => r?.task?.type === type
  && Number(r?.task?.year) === Number(year) && (month === undefined || Number(r?.task?.month) === Number(month))
  && r.status === 'completed' && r.analysis);
const decadeOf = (tasks, year) => tasks.find((r) => r?.task?.type === 'decade' && Number(r?.task?.year) === Number(year) && r.status === 'completed' && r.analysis);

/** 按任务参数从 ai_cache 精确补读(主键查找)：记录里 aiTasks 未同步全时，缓存仍是权威来源。 */
function cacheLookup(db, record, task, tone, providers) {
  for (const provider of providers) {
    const hit = readCache(db, cacheKey(record, task, provider.model, tone));
    if (hit) { try { return JSON.parse(hit); } catch { /* 坏缓存忽略 */ } }
  }
  return null;
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
  };
  const wantsScan = plan.scan === true;
  const wantsPeriod = plan.year !== undefined || wantsScan;
  const wantsNatal = !wantsPeriod;
  if (wantsNatal || wantTopics.length === 0 || wantTopics.some((t) => ['五行', '格局', '神煞'].includes(t))) {
    const baseline = findTask(tasks, 'baseline');
    if (baseline) evidence.analyses.push({ heading: '本命批断', text: (baseline.analysis.explanation || '') && sliceSections(baseline.analysis.explanation, wantTopics.length ? [...wantTopics, '身强身弱与喜忌'] : []) || String(baseline.analysis.explanation || '').slice(0, 900) });
    const adjustment = findTask(tasks, 'adjustment');
    if (adjustment && (wantTopics.length === 0 || wantTopics.includes('五行'))) evidence.analyses.push({ heading: '后天调整与职业', text: sliceSections(adjustment.analysis.explanation, ['后天调整', '事业适配', '健康注意']) });
    const overview = findTask(tasks, 'overview');
    if (overview && wantTopics.length === 0) evidence.analyses.push({ heading: '全盘总结', text: sliceSections(overview.analysis.explanation, ['核心结论', '值得关注的时间节点', '行动建议']) });
    if (!baseline) evidence.missing.push('本命批断尚未生成：可先在命盘详情页点「AI 分析」');
  }
  if (wantsScan) {
    // 开放式时机提问：把未来若干年的流年批断逐条列成时间线，让模型在证据里挑年限，
    // 而不是被迫回答「数据库里没有」。缺哪一年就逐个点名，别再笼统说「没有数据」。
    const labels = wantTopics.length ? wantTopics : ['健康', '事业', '财运', '爱情', '刑冲克害批注'];
    const from = Number(plan.scanFrom ?? new Date().getFullYear());
    const lines = [];
    const gaps = [];
    const uncovered = [];
    for (let y = from; y < from + SCAN_YEARS; y += 1) {
      let annual = taskOfYear(tasks, 'annual', y);
      if (!annual) { const a = cacheLookup(db, record, { type: 'annual', year: y, month: undefined }, tone, providers); if (a) annual = { status: 'completed', analysis: a, task: { type: 'annual', year: y } }; }
      if (!annual) { gaps.push(y); continue; }
      const body = sliceSections(annual.analysis.explanation, labels, 260);
      // 该年批断存在，但按提问主题过滤后一个字都没有 → 这一年答不了这个问题，必须点名
      if (!body) uncovered.push(y);
      lines.push(String(y) + '年(' + String(annual.analysis.title || '') + ')：' + body);
    }
    if (lines.length) {
      evidence.analyses.push({ heading: from + '—' + (from + SCAN_YEARS - 1) + '年·逐年批断(用于判断应期)', text: lines.join('\n') });
      // 起算年所在大运：判断这十年运势走向，缺了它只看流年会失真
      const decade = decadeOf(tasks, from);
      const decadeHit = decade || (() => { const d = cacheLookup(db, record, { type: 'decade', year: from }, tone, providers); return d ? { status: 'completed', analysis: d, task: { type: 'decade', year: from } } : null; })();
      if (decadeHit) evidence.analyses.push({ heading: '所处大运批断', text: sliceSections(decadeHit.analysis.explanation, labels) });
    } else {
      evidence.missing.push(from + '—' + (from + SCAN_YEARS - 1) + ' 年的流年批断一条都还没生成，无法判断应期');
    }
    if (gaps.length) evidence.missing.push('下列年份尚未生成流年批断，作答时只能在这些年份之外给应期：' + gaps.join('、') + '年');
    if (uncovered.length) evidence.missing.push('下列年份虽有流年批断，但其中没有与所问主题相关的小节，不得据其判断该主题的应期：' + uncovered.join('、') + '年');    if (periodFacts && typeof periodFacts === 'object') evidence.periodFacts = periodFacts;
    return evidence;
  }
  if (wantsPeriod) {
    const labels = wantTopics.length ? wantTopics : ['健康', '事业', '财运', '爱情', '刑冲克害批注'];
    let annual = taskOfYear(tasks, 'annual', plan.year);
    if (!annual) { const a = cacheLookup(db, record, { type: 'annual', year: plan.year, month: undefined }, tone, providers); if (a) annual = { status: 'completed', analysis: a, task: { type: 'annual', year: plan.year } }; }
    if (annual) evidence.analyses.push({ heading: plan.year + '年·流年批断(' + String(annual.analysis.title || '') + ')', text: sliceSections(annual.analysis.explanation, labels) });
    else evidence.missing.push(plan.year + ' 年的流年分析尚未生成');
    let decade = decadeOf(tasks, plan.year);
    if (!decade) { const d = cacheLookup(db, record, { type: 'decade', year: plan.year }, tone, providers); if (d) decade = { status: 'completed', analysis: d, task: { type: 'decade', year: plan.year } }; }
    if (decade) evidence.analyses.push({ heading: '所处大运批断', text: sliceSections(decade.analysis.explanation, labels) });
    if (plan.month !== undefined) {
      let monthly = taskOfYear(tasks, 'monthly', plan.year, plan.month);
      if (!monthly) { const mm = cacheLookup(db, record, { type: 'monthly', year: plan.year, month: plan.month }, tone, providers); if (mm) monthly = { status: 'completed', analysis: mm, task: { type: 'monthly', year: plan.year, month: plan.month } }; }
      if (monthly) evidence.analyses.push({ heading: plan.year + '年' + plan.month + '月·流月批断', text: sliceSections(monthly.analysis.explanation, labels) });
      else evidence.missing.push(plan.year + '年' + plan.month + '月 的流月分析尚未生成');
    }
    // 时段干支事实：记录里是瘦身存储，客户端随请求带来引擎现算的当期行(仍是确定性计算结果，非模型发挥)
    if (periodFacts && typeof periodFacts === 'object') evidence.periodFacts = periodFacts;
  }
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
  + '并说明是该年哪一条批断支持这个判断；'
  + '证据里若点名了"尚未生成流年批断"的年份，只能在该范围之外给应期，绝不能给这批空缺年份下任何结论。'
  + '【缺口处理】只有当证据覆盖不了用户所问的时段与主题时(摘录为空，或只有【数据缺口提示】)，'
  + '才明确说出"数据库里还没有计算过这批数据"，逐条列出缺了什么，'
  + '并建议用户先到命盘详情页点「AI 分析」把对应的本命/流年/流月批断算出来，然后再来提问；'
  + '此时只允许复述缺口与已有事实，一条都不许推测。'
  + '【绝对禁止】禁止自行推算或猜测干支、十神、五行、旺衰、格局、神煞；'
  + '禁止用命理常识、通书、经验、类比或"一般来说""通常""可能会"来补足缺失数据；'
  + '禁止在证据之外新增任何未给出的结论。'
  + '已有事实优先，格局与旺衰一律以命盘事实里「格局事实」「旺衰评分」两项为准，不得重判、不得改口径。'
  + '【说重点】先说结论，再给依据，只讲与该问题直接相关的话，不铺垫、不寒暄、不重复问题、不写无关主题。'
  + '【禁止英文】正文一律用中文表述，不得出现任何英文单词、英文缩写或拼音；'
  + '尤其禁止把证据 JSON 里的英文字段名、变量名、代码标识符原样抄进正文，要说的内容一律翻译成中文说法。'
  + '输出为简体中文纯文本：不要 JSON、不要代码块/注释/围栏标记；总长 150~350 字；'
  + '分点(1. 2. 3.)作答，有证据时每点都注明依据的批断小节，无证据时直接说明缺数据并给出补算建议；全篇不得出现繁体字。';

/** 聊天正文去英文(与客户端 features/chart/elements.ts 的 sanitizeChatText 同口径)。
 *  实测(deepseek + reasoning_effort=high)模型会把证据 JSON 里的英文字段名原样抄进正文，
 *  提示词只是软约束，故在此做确定性清洗兜底。 */
export const FIELD_NAME_ZH = {
  patternFacts: '格局事实', strengthScore: '旺衰评分', dayMaster: '日主', elementRatio: '五行比例',
  elements: '五行', hiddenStems: '藏干', tenGods: '十神', naYin: '纳音', twelveLongevity: '十二长生',
  shenSha: '神煞', relationships: '刑冲合害', solarDate: '公历日期', lunarDate: '农历日期',
  zodiac: '生肖', gender: '性别', birthYear: '出生年', pillars: '四柱', natal: '命盘事实',
  periodFacts: '时段运势', analyses: '已算批断', missing: '数据缺口', plan: '检索计划',
  verdict: '判定', favorites: '喜用', favorable: '喜用', unfavorable: '忌神', score: '分值',
};

export function sanitizeChatText(text) {
  let out = String(text ?? '');
  // 整段几乎纯英文(无中文且连续英文词 ≥4) → 视为跑偏，交回调用方按失败处理
  const cjk = (out.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = out.match(/[A-Za-z]{2,}/g) ?? [];
  if (cjk === 0 && latinWords.length >= 4) return '';
  out = out.replace(/[A-Za-z_][A-Za-z0-9_]{1,}/g, (word) => FIELD_NAME_ZH[word] ?? word);
  out = out.replace(/(?<=[\u4e00-\u9fff\s、，。；：（）「」])[A-Za-z_][A-Za-z0-9_]{2,}/g, '');
  out = out.replace(/\bAI\b/g, 'AI').replace(/\s{2,}/g, ' ').replace(/ +([，。、；：）])/g, '$1');
  return out.trim();
}

/** 证据摘要压成一段稳定前缀(同盘同题逐字节一致，吃上游前缀缓存)，可变尾巴只有问题本身。 */
export function buildChatMessages({ question, history = [], evidence, tone = 80 }) {
  const evidenceText = '# 命盘事实(JSON)\n' + JSON.stringify(evidence.natal)
    + (evidence.periodFacts ? '\n\n# 所问时段运势数据(JSON)\n' + JSON.stringify(evidence.periodFacts) : '')
    + '\n\n# 已算批断摘录\n' + (evidence.analyses.map((a) => '## ' + a.heading + '\n' + a.text).join('\n\n') || '（数据库中暂无该主题的已算批断）')
    + (evidence.missing?.length ? '\n\n# 数据缺口提示\n' + evidence.missing.map((m) => '- ' + m).join('\n') : '');
  const messages = [{ role: 'system', content: CHAT_SYSTEM }];
  for (const item of history.slice(-8)) {
    if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim()) {
      messages.push({ role: item.role, content: item.content.slice(0, 2000) });
    }
  }
  messages.push({
    role: 'user',
    content: evidenceText
      + '\n\n# 语气要求\n' + toneInstruction(tone)
      + '\n\n# 用户问题\n' + String(question || '').slice(0, 500),
  });
  return messages;
}

/* ---------- 聊天答案缓存与追问 ---------- */
/** 键位与任务缓存同构(第 2..6 段=性别+四柱) → chart_sig 索引自动覆盖聊天缓存。
 *  仅缓存首轮(无历史)答案：追问的答案依赖上文，键里放不下整段上文，做了就会张冠李戴。 */
export function chatCacheKey(record, question, model, tone) {
  const toneBucket = Math.round(clampTone(tone) / 5) * 5;
  const qhash = createHash('sha256').update(String(question).trim()).digest('hex').slice(0, 24);
  return ['chatv1', model, record.gender, record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar, 'chat', qhash, record.birthYear, toneBucket].join('|');
}

/** 追问继承上文语境：上一轮问的是 2026 年爱情，这轮一句「那我明年呢」不该退化成全新问题。
 *  只做「有历史且本轮自己没说时间/主题」时的补全，本轮若已明说就以本轮为准。 */
export function applyFollowUp(plan, history) {
  if (!Array.isArray(history) || history.length === 0) return plan;
  const asksClarify = /^[?？唔嗯哦啊这那]+$/.test(String(plan.question ?? '').trim());
  if (asksClarify) return plan;
  const prevUser = [...history].reverse().find((m) => m?.role === 'user' && typeof m.content === 'string');
  const prevAssistant = [...history].reverse().find((m) => m?.role === 'assistant' && typeof m.content === 'string');
  const source = [prevUser?.content, prevAssistant?.content, plan.question].filter(Boolean).join('\n');
  const next = { ...plan };
  if (!plan.topics?.length) {
    const inherited = TOPIC_RULES.filter((rule) => rule.re.test(source)).flatMap((rule) => [rule.topic]);
    if (inherited.length) next.topics = [...new Set(inherited)];
  }
  if (next.year === undefined && !next.scan) {
    const inheritedWhen = extractWhen(prevUser?.content ?? '', new Date());
    if (inheritedWhen.year !== undefined) { next.year = inheritedWhen.year; next.month = inheritedWhen.month; }
    else if (inheritedWhen.scan) { next.scan = true; next.scanFrom = inheritedWhen.from; }
  }
  return next;
}

/* ---------- 入口 ---------- */
export async function runChat(db, user, body = {}) {
  const question = String(body.question || '').trim();
  if (!question) return { status: 'failed', error: '请输入问题' };
  if (question.length > 500) return { status: 'failed', error: '问题过长，请控制在 500 字以内' };
  const tone = clampTone(body.tone ?? 80);
  const summaries = listRecordSummaries(db, user.id);
  if (summaries.length === 0) return { status: 'need_record', reason: '还没有任何命盘：请先在「排盘」页保存一条记录，再向我提问' };
  const providers = providerOrder(db, body.provider);

  // 目标命盘一律从「本人名下」的轻列表里解析(recordId 也必须命中)，杜绝越权读取他人记录。
  const history = Array.isArray(body.history) ? body.history : [];
  const plan = applyFollowUp(analyzeQuestion(question, summaries), history);
  let target = null;
  if (body.recordId) {
    target = summaries.find((s) => s.id === String(body.recordId)) || null;
    if (!target && user.role === 'admin') {
      const foreign = getRecordById(db, String(body.recordId));
      if (foreign) target = { id: foreign.id, name: foreign.name };
    }
    if (!target) return { status: 'failed', error: '记录不存在或无权访问' };
  }
  if (!target) target = plan.recordId ? summaries.find((s) => s.id === plan.recordId) : (summaries.length === 1 ? summaries[0] : null);
  if (!target) return { status: 'need_record', reason: '你的名下有多条命盘，请告诉我问的是谁(或点选命主)', options: summaries.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updated_at ?? s.updatedAt })) };

  const record = getRecordById(db, target.id);
  if (!record) return { status: 'failed', error: '记录读取失败' };
  const evidence = collectEvidence(db, record, plan, { tone, periodFacts: body.periodFacts, providers });
  const messages = buildChatMessages({ question, history, evidence, tone });
  const cacheable = history.length === 0; // 追问依赖上下文，不缓存
  const evidenceMeta = { recordId: record.id, personName: record.name, plan };  // 先查缓存：即便服务器当前没有配置任何密钥(或密钥被移除)，已入库的答案仍应可复用。
  // 缓存也过一遍去英文：早先落库的答案可能残留英文字段名，读时顺手洗净。
  if (cacheable) {
    for (const model of (providers.length ? providers.map((p) => p.model) : PROVIDERS.map((p) => p.model))) {
      const hit = readCache(db, chatCacheKey(record, question, model, tone));
      if (hit) { const clean = sanitizeChatText(hit); if (clean) return { status: 'completed', answer: clean, cached: true, evidence: evidenceMeta }; }
    }
  }
  if (providers.length === 0) return { status: 'not_configured', error: '服务器未配置 AI 密钥，请在服务器设置中填写后保存' };
  const errors = [];
  for (const provider of providers) {
    const ck = cacheable ? chatCacheKey(record, question, provider.model, tone) : null;
    const result = await callProvider(provider, providerKey(db, provider.id), messages, 'high', 'text');
    if (result.text) {
      const clean = sanitizeChatText(result.text);
      // 洗净后为空 = 模型整段跑成英文，当作该 provider 失败，换下一个通道再试
      if (!clean) { errors.push(provider.id + ': 模型输出不是中文'); continue; }
      if (ck) { try { writeCache(db, ck, clean); } catch { /* 写缓存失败不影响回答 */ } }
      return { status: 'completed', answer: clean, cached: false, evidence: evidenceMeta };
    }
    errors.push(provider.id + ': ' + (result.error || 'failed'));
  }
  return { status: 'failed', error: errors.join('；'), evidence: evidenceMeta };
}
