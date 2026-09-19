import { getSetting, readCache, writeCache, setSetting } from './db.mjs';

export const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek V4.1', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' },
  { id: 'kimi', label: 'Kimi(Moonshot)', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'kimi-k2.6' },
  { id: 'qwen', label: 'Qwen3.8-Flash', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen3.8-flash', disableThinking: true },
];
export const currentProviderId = (db) => getSetting(db, 'ai.provider', 'deepseek');
export const providerOf = (id) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
export const providerKey = (db, id) => getSetting(db, 'ai.key.' + id, '');
export const saveProviderKey = (db, id, key) => { if (key && key.trim()) setSetting(db, 'ai.key.' + id, key.trim()); };
export const saveProviderId = (db, id) => setSetting(db, 'ai.provider', id);
export const providerOrder = (db, preferred) => {
  const selected = preferred && PROVIDERS.some((p) => p.id === preferred) ? preferred : currentProviderId(db);
  const others = PROVIDERS.filter((p) => p.id !== selected);
  return [providerOf(selected), ...others].filter((p) => providerKey(db, p.id));
};


/* ---------- 语气(犀利↔温柔)滑杆：0 犀利 / 50 中立 / 100 温柔夸夸，默认 80(八成好话+两成委婉点不足) ---------- */
export const DEFAULT_TONE = 80;
export const clampTone = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TONE;
  return Math.min(100, Math.max(0, Math.round(n)));
};
export function toneInstruction(tone) {
  const t = clampTone(tone);
  if (t >= 90) return '语气：温柔夸夸。以积极、美好、有鼓励性的语言为主；如确有不足，先说优点亮点，再把不足放进“建议/期待/贵人提点”式的委婉表达里轻轻带过，避免直接批评。';
  if (t >= 60) return '语气：温和优先。正面与亮点先说、多说(约占八成篇幅)，不足只以委婉、建设性的方式简要点到(约占两成)，措辞照顾感受，不说重话。';
  if (t >= 45) return '语气：中立客观。好坏都如实、平衡地说明，不回避问题也不夸大优点，保持专业、就事论事。';
  if (t >= 10) return '语气：偏犀利。减少客套铺垫，直接点出风险、短板与容易踩坑之处，同时给出依据和可操作的改进方向，不粉饰。';
  return '语气：犀利直白。重点明显指出不利之处、性格短板与应戒之事，直截了当、不留情面，但每句都要有命理依据，不做人身攻击。';
}

/* ---------- 提示词与上下文(与桌面端保持一致口径，正文一律分点编号) ---------- */
/** 神煞压缩为「名称@柱位」列表：给模型足够信号，但不重复 basis/来源等冗余字段。 */
function compactShenSha(shenSha) {
  if (!shenSha) return undefined;
  const pillarNames = ['年', '月', '日', '时'];
  const items = Array.isArray(shenSha.items)
    ? shenSha.items.map((item) => item.name + '@' + (pillarNames[item.pillarIndex] ?? '?') + (item.position === '天干' ? '干' : '支'))
    : [];
  return { 吉: shenSha.auspicious ?? [], 凶: shenSha.inauspicious ?? [], 明细: items };
}

const pickByYear = (rows, year) => (Array.isArray(rows) ? rows.find((r) => Number(r.year) === Number(year)) : null);
const pickByYearMonth = (rows, year, month) => (Array.isArray(rows) ? rows.find((r) => Number(r.year) === Number(year) && Number(r.month) === Number(month)) : null);
const pickDecade = (rows, year) => (Array.isArray(rows) ? rows.find((r) => Number(r.startYear) <= Number(year) && Number(year) <= Number(r.endYear)) : null);
const gzOf = (row) => (row && typeof row.ganZhi === 'string' ? row.ganZhi : '');

function summarizeHits(row, ownGanZhi) {
  if (!row) return [];
  const labels = { sanHe: '三合', liuHe: '六合', chong: '六冲', xing: '相刑', hai: '六害', po: '六破', ke: '相克' };
  const out = [];
  const details = row.relationshipDetails;
  if (Array.isArray(details)) {
    for (const item of details) {
      const sp = String(item?.sourcePillar ?? '');
      const tg = String(item?.targetPillar ?? '');
      const st = String(item?.status ?? '');
      if (sp === ownGanZhi || tg === ownGanZhi || (!sp && !tg)) {
        const other = tg === ownGanZhi ? sp : tg;
        const extra = st === 'half-combination' ? '半合' : st === 'partial-punishment' ? '半刑' : '';
        out.push(labels[item?.type] + (other ? '(' + other + ')' : '') + extra);
      }
    }
  }
  return [...new Set(out)].sort();
}

const BASELINE_PROMPT = '你是资深子平命理师。严格依据下方【事实数据(JSON)】中的确定性命理数据作答，禁止自行推算干支、十神、五行、藏干或干支关系。禁止输出注释或代码块/围栏标记，只给最终正文。当前分析目标：本命。用 JSON(仅 JSON)返回，schema：{"pattern":格局,"strength":身强/身弱/中和,"usefulElements":[喜用],"avoidElements":[忌用],"explanation":长文}。explanation 必须以【身强身弱与喜忌】开头，随后按顺序各出现一次【健康】【事业】【财运】【爱情】(不得合并、省略或改名)，末尾可以加【总评/行为建议】收尾。判断身强身弱请按固定四步逐一写明依据再下结论：①得令：日主是否得月令生旺(看月支藏干旺衰及日主在月支的十二长生)；②得地：四支与藏干是否有日主印比禄刃的根气；③得势：四柱中印星比劫(生我、同我)出现几次(以五行个数与十神为准)；④克泄耗：食伤、财星、官杀(我生、我克、克我)出现几次。四步权衡后得出身强/身弱/中和；喜忌按子平通则推导并写明：身弱喜印比、忌克泄耗，身强反之，中和则以调候通关需要为准。';
const SCOPE_PROMPT = () => '你是资深子平命理师，仅分析时段运势。严格依据下方【事实数据(JSON)】作答，禁止自行推算干支、十神、五行或关系。禁止输出注释或代码块/围栏标记，只给最终正文。本命强弱/格局/喜忌已定，不要重复判断。用 JSON(仅 JSON)返回，schema：{"title":"古风四字或对仗标题(可选)","explanation":长文}。title 只能用干支+四字直书(如：卯戌六合·和合之象)或古典口诀风格，不得编造伪古文引文。explanation 必须依次各出现一次【健康】【事业】【财运】【爱情】【刑冲克害批注】，顺序一致，不得合并、省略或改名；【刑冲克害批注】依据 scope 中的 annualHits/monthlyHits/decadeHits 逐条编号，每行格式：数字. 关系（干支实例）：一句影响，例如 1. 三合（巳酉丑半合）：…；若没有任何相关命中，该段写一条：1. 本期无重大刑冲克害（仅提示）。各主题全文只出现一次，禁止重复说两遍。每个主题内部必须分点陈述：每条单独一行、行首用 1. 2. 3. 编号，一句话一条，禁止整段连排。';

const OVERVIEW_PROMPT = '你是资深子平命理师，现在做「全盘总结」。下面给出的是【已经算好的结论】：本命喜忌、以及未来十年的大运/流年/流月逐段批断要点。你的任务不是重新推算，也不是复述每一段，而是横向比较这些结论，挑出真正值得当事人注意的时间节点并说明理由。严格依据给定材料作答，禁止自行补充材料里没有的干支或事件；禁止输出注释或代码块/围栏标记，只给最终正文。用 JSON(仅 JSON)返回，schema：{"title":"古风四字或对仗标题(可选)","explanation":长文}。explanation 必须依次各出现一次【核心结论】【值得关注的时间节点】【行动建议】，顺序一致，不得合并、省略或改名。其中【值得关注的时间节点】是本文重点，要求：1. 按重要程度排序，每条单独一行、行首用 1. 2. 3. 编号；2. 每条写成「年份(或大运段) + 干支 + 为什么值得关注(引材料中的刑冲克害/喜忌依据) + 一句话怎么办」；3. 至少区分「机会窗口」与「风险窗口」两类，各自点明；4. 材料里若某年标注了六冲/三刑/六害等重大作用，必须纳入；5. 只写材料支持得起的结论，宁少勿滥，不要逐年流水账。【核心结论】用 2-4 条概括命局主线与该十年大势；【行动建议】用 2-4 条给出跨年份可执行的通用做法(贴合喜用五行，不重复时间节点里的原话)。全篇简体中文，每个主题内部一条一句，禁止整段连排。';

export function baselineSummaryOf(baseline) {
  if (!baseline) return '';
  const analysis = baseline.analysis;
  if (analysis) {
    const pick = (v) => (typeof v === 'string' ? v : '');
    return '格局：' + (pick(analysis.pattern) || '—') + ' · 强弱：' + (pick(analysis.strength) || '—')
      + '　喜：' + (Array.isArray(analysis.usefulElements) ? analysis.usefulElements.join('、') : '') + '　忌：' + (Array.isArray(analysis.avoidElements) ? analysis.avoidElements.join('、') : '');
  }
  if (baseline.summary) return String(baseline.summary);
  return '';
}

export function buildTaskPayload(record, task, tone = DEFAULT_TONE) {
  const nonAi = record?.nonAiResult || {};
  const natal = {
    gender: record.gender, birthYear: record.birthYear,
    pillars: { year: record.yearPillar, month: record.monthPillar, day: record.dayPillar, hour: record.hourPillar },
    solarDate: nonAi.solarDate, lunarDate: nonAi.lunarDate, zodiac: nonAi.zodiac, dayMaster: nonAi.dayMaster,
    elements: nonAi.elements, elementRatio: nonAi.elementRatio,
    hiddenStems: nonAi.hiddenStems, tenGods: nonAi.tenGods,
    naYin: nonAi.naYin, twelveLongevity: nonAi.twelveLongevity,
    shenSha: compactShenSha(nonAi.shenSha), relationships: nonAi.relationships,
  };
  const y = task.year;
  const scope = {};
  if (y !== undefined) {
    if (task.type !== 'decade') scope.age = y - record.birthYear;
    if (task.type === 'decade') {
      const decade = (task.decade && gzOf(task.decade)) ? task.decade : pickDecade(nonAi.greatFortunes, y);
      if (decade) { scope.decade = decade; scope.decadeHits = summarizeHits(decade, gzOf(decade)); }
    } else {
      const annual = (task.annual && gzOf(task.annual)) ? task.annual : pickByYear(nonAi.annualFortunes, y);
      if (annual) { scope.annual = annual; scope.annualHits = summarizeHits(annual, gzOf(annual)); }
      const decade = (task.decade && gzOf(task.decade)) ? task.decade : pickDecade(nonAi.greatFortunes, y);
      if (decade) { scope.decade = decade; scope.decadeHits = summarizeHits(decade, gzOf(decade)); }
      if (task.month !== undefined) {
        const monthly = task.monthly && gzOf(task.monthly)
          ? task.monthly
          : pickByYearMonth(nonAi.monthlyFortunes, y, task.month);
        if (monthly) { scope.monthly = monthly; scope.monthlyHits = summarizeHits(monthly, gzOf(monthly)); }
      }
    }
  }
  let userContent = '';
  const system = '请把思考压缩到最短，直接输出符合要求的简体中文 JSON 正文；全篇不得出现繁体字。';
  const OUTPUT_RULES = '\n\n# 输出硬性要求(违反即整篇作废重写)\n'
    + '1. 全篇一律使用简体中文(UTF-8)，禁止任何繁体字、异体字混入。\n'
    + '2. explanation 的【】小节必须按本任务规定逐段出现、各只出现一次，顺序一致，不得合并、省略或改名。\n'
    + '3. 每个小节至少 1 条编号要点；每条单独一行、行首用 1. 2. 3. 编号，一句话一条，禁止整段连排。\n'
    + '4. 禁止输出注释、代码块或任何围栏标记，只给最终正文。';
  const toneText = '\n\n# 语气要求(必须按此措辞把握全篇)\n' + toneInstruction(tone);
  if (task.type === 'adjustment') {
    const guide = task.guide || {};
    const baseline = baselineSummaryOf(task.baseline) || '（暂无本命结论）';
    userContent = '你是资深子平命理师。根据【本命结论】的喜用五行与下方【资料库】中对应五行的后天调整/职业知识，输出该命局的【后天调整】与【事业职业适配】建议(长文，贴合资料，不要另造体系)。禁止输出注释或代码块，只给最终正文。JSON schema：{"explanation":长文}，explanation 用【后天调整】【事业适配】【健康注意】分段；每个主题内部必须分点：每条单独一行、行首 1. 2. 3. 编号，一句话一条。\n\n# 本命结论\n' + baseline + '\n\n# 资料库\n' + JSON.stringify(guide) + OUTPUT_RULES + toneText;
  } else if (task.type === 'overview') {
    userContent = OVERVIEW_PROMPT
      + '\n# 本命结论(已定，必须沿用，不得重算)\n' + (baselineSummaryOf(task.baseline) || '（暂无本命结论）')
      + '\n\n# 本命事实数据(JSON，只依据此数据)\n' + JSON.stringify(natal)
      + OUTPUT_RULES + toneText
      + '\n\n# 各时段分析要点(JSON)\n' + JSON.stringify(task.findings ?? {})
      + '\n\n# 当前分析目标\n全盘总结：未来十年中值得关注的节点';
  } else if (task.type === 'baseline') {
    userContent = BASELINE_PROMPT + '\n\n# 事实数据(JSON)\n' + JSON.stringify({ natal, scope: {} }) + OUTPUT_RULES + toneText;
  } else {
    const whenLabel = task.type === 'decade' ? '所处大运(含 ' + y + ' 年)' : (task.month !== undefined ? y + '年' + task.month + '月' : y + '年');
    // 年龄仅对流年/流月有意义；大运不再推算年龄
    const ageSeg = task.type !== 'decade' && y !== undefined && record.birthYear ? '(年龄约 ' + (y - record.birthYear) + ')' : '';
    const note = task.baseline ? baselineSummaryOf(task.baseline) : '';
    // 大前缀放前面(全组一致)，目标+scope 放最后 → DeepSeek 前缀缓存可被同组任务复用
    userContent = SCOPE_PROMPT()
      + (note ? '\n# 本命结论(已定，必须沿用，不得重算)\n' + note : '')
      + '\n\n# 本命事实数据(JSON，只依据此数据)\n' + JSON.stringify(natal)
      + OUTPUT_RULES + toneText
      + '\n\n# 本时段数据(JSON)\n' + JSON.stringify(scope)
      + '\n\n# 当前分析目标\n' + whenLabel + ageSeg;
  }
  // 需要横向权衡的判断类任务用 high；单期批断用 low(省时)
  const effort = (task.type === 'baseline' || task.type === 'adjustment' || task.type === 'overview') ? 'high' : 'low';
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }], effort };
}

export function cacheKey(record, task, model, tone = DEFAULT_TONE) {
  const toneBucket = Math.round(clampTone(tone) / 5) * 5; // 每 5 度一个缓存档，避免同一命盘缓存爆炸
  // v8：本命事实里的藏干十神口径修正(与日主同干的藏干应为「比肩」而非「日主」)，旧缓存据此重算一次。
  return ['v8', model, record.gender, record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar, task.type, task.year ?? 0, task.month ?? 0, record.birthYear, toneBucket].join('|');
}

/* ---------- 失败原因分类：把上游错误翻译成用户能看懂的原因 ---------- */
/** 依据 HTTP 状态码 + 响应体文案判定失败类型。 */
export function classifyFailure(status, bodyText) {
  const text = String(bodyText || '');
  const lower = text.toLowerCase();
  // 余额/额度类：各家文案不同，命中即判
  if (status === 402 || /insufficient|balance|quota|arrears|欠费|余额|额度|配额|exceeded your current quota|free tier/i.test(text)) return '余额不足或额度已用完';
  if (status === 401 || status === 403 || /invalid.*(api.?key|token)|authentication|unauthorized|incorrect api key|api key.*invalid|密钥无效|鉴权/i.test(text)) return '密钥无效或无权限';
  if (status === 429 || /rate.?limit|too many requests|requests per|限流|频繁/i.test(lower)) return '请求过于频繁（已被限流）';
  if (status === 404 || /model.*(not found|not exist)|no such model|模型不存在/i.test(lower)) return '模型名不存在或已下线';
  if (status === 400 || /invalid.*request|bad request|参数/i.test(lower)) return '请求参数不被接受';
  if (status >= 500) return '服务端故障（上游 5xx）';
  if (status === 0) return '网络不可达或延迟过高';
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  return snippet ? ('上游报错：' + snippet) : ('HTTP ' + status);
}

/** 调一次上游(单 provider，最多 transport 重试一次)；失败返回 {error}。 */
async function callProvider(provider, key, messages, effort) {
  const body = { model: provider.model, messages, max_tokens: 32768 };
  // V4.1：思考模式默认开启；按任务类型控制思考力度(本命/后天调整=high，时段=low 以省时省钱)
  if (provider.id === 'deepseek' && effort) body.reasoning_effort = effort;
  // Qwen3.8-Flash 默认带思考(实测慢 ~3.8 倍且对我们的结构化 JSON 无增益)，显式关闭可大幅提速
  if (provider.disableThinking) body.enable_thinking = false;
  // Kimi 需要 temperature=1；已关闭思考的 Qwen 用低温度更稳定
  if (provider.id === 'kimi') body.temperature = 1;
  if (provider.id === 'qwen') body.temperature = 0.3;
  // V4.1：思考模式默认开启；按任务类型控制思考力度(本命/后天调整=high，时段=low 以省时省钱)
  if (provider.id === 'deepseek' && effort) body.reasoning_effort = effort;
  if (provider.id !== 'deepseek') body.temperature = 1;
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(provider.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (netErr) {
        // 网络层失败：区分超时与不可达，并给出耗时便于判断
        if (netErr?.name === 'AbortError') return { error: '网络超时：上游 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒未响应（' + provider.label + '）' };
        if (attempt === 0) continue;
        return { error: '网络不可达或延迟过高（' + provider.label + '）：' + String(netErr?.message || netErr) };
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        // 限流/上游抖动重试一次
        if (attempt === 0 && (res.status === 429 || res.status >= 500)) continue;
        return { error: classifyFailure(res.status, errText) + '（HTTP ' + res.status + ' · ' + provider.label + '）' };
      }
      let data;
      try { data = await res.json(); }
      catch { return { error: '上游返回内容无法解析（' + provider.label + '）' }; }
      const raw = String(data?.choices?.[0]?.message?.content ?? '').trim();
      if (!raw) {
        const finish = String(data?.choices?.[0]?.finish_reason ?? '');
        return { error: '上游返回空正文' + (finish ? '（finish_reason=' + finish + '）' : '') + '（' + provider.label + '）' };
      }
      const cleaned = raw.replace(/^\`\`\`json?\s*/i, '').replace(/\`\`\`\s*$/, '').trim();
      try { return { analysis: JSON.parse(cleaned) }; }
      catch { return { error: '模型输出不是合法 JSON（' + provider.label + '）' }; }
    }
    return { error: '多次重试仍失败（' + provider.label + '）' };
  } catch (err) {
    return { error: (err?.name === 'AbortError' ? '网络超时' : '调用异常') + '（' + provider.label + '）：' + String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}


export async function runOneTask(db, record, task, tone = DEFAULT_TONE, preferred) {
  const t = clampTone(tone);
  const { messages, effort } = buildTaskPayload(record, task, t);
  const order = providerOrder(db, preferred);
  if (order.length === 0) return { status: 'not_configured', error: '服务器未配置 AI 密钥，请在服务器设置中填写后保存' };
  const errors = [];
  for (const provider of order) {
    const model = provider.model;
    const key = providerKey(db, provider.id);
    const ck = cacheKey(record, task, model, t);
    const hit = readCache(db, ck);
    if (hit) {
      try { return { status: 'completed', analysis: JSON.parse(hit) }; } catch { /* 坏缓存忽略，重算 */ }
    }
    const result = await callProvider(provider, key, messages, effort);
    if (result.analysis) {
      try { writeCache(db, ck, JSON.stringify(result.analysis)); } catch { /* 写缓存失败忽略 */ }
      return { status: 'completed', analysis: result.analysis };
    }
    errors.push(provider.id + ': ' + (result.error || 'failed'));
  }
  return { status: 'failed', error: errors.join('；') };
}

export async function runSelfTest(db) {
  const order = providerOrder(db);
  if (order.length === 0) return { ok: false, message: '未配置 AI 密钥' };
  const provider = order[0];
  const key = providerKey(db, provider.id);
  const messages = [{ role: 'user', content: '只回复两个字母：ok' }];
  const started = Date.now();
  const r = await callProvider(provider, key, messages, 'low');
  if (r.analysis) return { ok: true, provider: provider.id, model: provider.model, latencyMs: Date.now() - started, reply: r.analysis };
  return { ok: false, message: provider.id + ' ' + (r.error || 'failed') };
}
