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

/** 抽取「年份/月份」：支持绝对(2027年)与相对(今年/明年/本月/下个月…)表达。 */
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

/** 检索计划：命主(按姓名在已存记录中匹配，长名优先防「张三丰」被「张三」截胡) + 时间 + 主题。 */
export function analyzeQuestion(question, summaries, now = new Date()) {
  const q = String(question || '');
  const matched = [];
  for (const s of summaries) {
    const name = String(s.name || '').trim();
    if (name && q.includes(name)) matched.push(s);
  }
  matched.sort((a, b) => String(b.name).length - String(a.name).length);
  const { year, month } = extractWhen(q, now);
  const topics = TOPIC_RULES.filter((rule) => rule.re.test(q)).flatMap((rule) => [rule.topic]);
  return {
    recordId: matched[0]?.id ?? null,
    personName: matched[0]?.name ?? null,
    matchedCount: matched.length,
    year, month,
    topics: [...new Set(topics)],
  };
}

/* ---------- 查库取证 ---------- */
/** 从批断正文里只截取与提问主题相关的【小节】，控制上下文体积(命中率/成本)。 */
export function sliceSections(text, topics, capPer = 700) {
  const source = String(text || '');
  if (!source) return '';
  const labels = (Array.isArray(topics) && topics.length ? topics : [])
    .filter((t) => ['健康', '事业', '财运', '爱情', '刑冲克害批注', '后天调整', '事业适配', '健康注意', '核心结论', '值得关注的时间节点', '行动建议', '身强身弱与喜忌'].includes(t));
  const blocks = [];
  const seen = new Set();
  const all = source.split(/(?=【)/);
  for (const part of all) {
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
    plan: { year: plan.year, month: plan.month, topics: wantTopics },
    natal: natalFactsOf(record),
    analyses: [],
    missing: [],
  };
  const wantsPeriod = plan.year !== undefined;
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
  + '回答只能依据消息中提供的【命盘事实】【已算批断摘录】(均来自本地数据库，由确定性引擎与既有 AI 分析落库)与对话历史，'
  + '禁止自行推算干支、十神、五行或任何未给出的数据；格局与旺衰以 natal.patternFacts / natal.strengthScore 为准，不得重判、不得改口径。'
  + '若所问时段或主题在数据库中没有现成批断，先如实说明，再基于已有事实给倾向性参考，不得凭空编造。'
  + '输出为简体中文纯文本：不要 JSON、不要代码块/注释/围栏标记；300~600 字；分点(1. 2. 3.)作答，先结论后依据；全篇不得出现繁体字。';

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

/* ---------- 聊天答案缓存 ---------- */
/** 键位与任务缓存同构(第 2..6 段=性别+四柱) → chart_sig 索引自动覆盖聊天缓存。 */
export function chatCacheKey(record, question, model, tone) {
  const toneBucket = Math.round(clampTone(tone) / 5) * 5;
  const qhash = createHash('sha256').update(String(question).trim()).digest('hex').slice(0, 24);
  return ['chatv1', model, record.gender, record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar, 'chat', qhash, record.birthYear, toneBucket].join('|');
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
  const plan = analyzeQuestion(question, summaries);
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
  const history = Array.isArray(body.history) ? body.history : [];
  const messages = buildChatMessages({ question, history, evidence, tone });
  const cacheable = history.length === 0; // 追问依赖上下文，不缓存
  const evidenceMeta = { recordId: record.id, personName: record.name, plan };
  // 先查缓存：即便服务器当前没有配置任何密钥(或密钥被移除)，已入库的答案仍应可复用。
  if (cacheable) {
    for (const model of (providers.length ? providers.map((p) => p.model) : PROVIDERS.map((p) => p.model))) {
      const hit = readCache(db, chatCacheKey(record, question, model, tone));
      if (hit) return { status: 'completed', answer: hit, cached: true, evidence: evidenceMeta };
    }
  }
  if (providers.length === 0) return { status: 'not_configured', error: '服务器未配置 AI 密钥，请在服务器设置中填写后保存' };
  const errors = [];
  for (const provider of providers) {
    const ck = cacheable ? chatCacheKey(record, question, provider.model, tone) : null;
    const result = await callProvider(provider, providerKey(db, provider.id), messages, 'high', 'text');
    if (result.text) {
      if (ck) { try { writeCache(db, ck, result.text); } catch { /* 写缓存失败不影响回答 */ } }
      return { status: 'completed', answer: result.text, cached: false, evidence: evidenceMeta };
    }
    errors.push(provider.id + ': ' + (result.error || 'failed'));
  }
  return { status: 'failed', error: errors.join('；'), evidence: evidenceMeta };
}
