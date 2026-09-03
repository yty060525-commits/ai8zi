import { getSetting, readCache, writeCache, setSetting } from './db.mjs';

export const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-reasoner' },
  { id: 'kimi', label: 'Kimi(Moonshot)', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'kimi-k2.6' },
];
export const currentProviderId = (db) => getSetting(db, 'ai.provider', 'deepseek');
export const providerOf = (id) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
export const providerKey = (db, id) => getSetting(db, 'ai.key.' + id, '');
export const saveProviderKey = (db, id, key) => { if (key && key.trim()) setSetting(db, 'ai.key.' + id, key.trim()); };
export const saveProviderId = (db, id) => setSetting(db, 'ai.provider', id);
export const providerOrder = (db) => {
  const selected = currentProviderId(db);
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

const BASELINE_PROMPT = '你是资深子平命理师。严格依据下方【事实数据(JSON)】中的确定性命理数据作答，禁止自行推算干支、十神、五行、藏干或干支关系。禁止输出/* */注释、HTML注释或任何代码块/围栏标记，只给最终正文。当前分析目标：本命。用 JSON(仅 JSON)返回，schema：{"pattern":格局,"strength":身强/身弱/中和,"usefulElements":[喜用],"avoidElements":[忌用],"explanation":长文}。explanation 从【身强身弱与喜忌】开始，依次【健康】【事业】【财运】【爱情】，以【总评/行为建议】收尾；每个主题内部必须分点陈述：每条单独一行、行首用 1. 2. 3. 编号，一句话一条，禁止整段连排。各主题全文只出现一次。';
const SCOPE_PROMPT = (when, ageSeg, hitsHint) => '你是资深子平命理师，仅分析时段运势。严格依据下方【事实数据(JSON)】作答，禁止自行推算干支、十神、五行或关系。禁止输出/* */注释、HTML注释或任何代码块/围栏标记，只给最终正文。当前分析目标：' + when + ageSeg + '。本命强弱/格局/喜忌已定，不要重复判断。用 JSON(仅 JSON)返回，schema：{"title":"古风四字或对仗标题(可选)","explanation":长文}。title 只能用干支+四字直书(如：卯戌六合·和合之象)或古典口诀风格，不得编造伪古文引文。explanation 按【健康】【事业】【财运】【爱情】分段展开' + (hitsHint ? '，末尾加【刑冲克害批注】' : '') + '；每个主题内部必须分点：每条单独一行、行首 1. 2. 3. 编号，一句话一条，不要整段连排。' + (hitsHint ? '【刑冲克害批注】必须是编号要点：每行格式 数字. 关系（干支实例）：一句影响。' : '') + '';

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
    shenSha: nonAi.shenSha, relationships: nonAi.relationships,
  };
  const y = task.year;
  const scope = {};
  if (y !== undefined) {
    scope.age = y - record.birthYear;
    if (task.type === 'decade') {
      const decade = pickDecade(nonAi.greatFortunes, y);
      if (decade) { scope.decade = decade; scope.decadeHits = summarizeHits(decade, gzOf(decade)); }
    } else {
      const annual = pickByYear(nonAi.annualFortunes, y);
      if (annual) { scope.annual = annual; scope.annualHits = summarizeHits(annual, gzOf(annual)); }
      const decade = pickDecade(nonAi.greatFortunes, y);
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
  let system = '请把思考压缩到最短，直接输出符合要求的 JSON 正文。';
  const natalNote = '';
  if (task.type === 'adjustment') {
    const guide = task.guide || {};
    const baseline = baselineSummaryOf(task.baseline) || '（暂无本命结论）';
    userContent = '你是资深子平命理师。根据【本命结论】的喜用五行与下方【资料库】中对应五行的后天调整/职业知识，输出该命局的【后天调整】与【事业职业适配】建议(长文，贴合资料，不要另造体系)。禁止输出注释或代码块，只给最终正文。JSON schema：{"explanation":长文}，explanation 用【后天调整】【事业适配】【健康注意】分段；每个主题内部必须分点：每条单独一行、行首 1. 2. 3. 编号，一句话一条。\n\n# 本命结论\n' + baseline + '\n\n# 资料库\n' + JSON.stringify(guide);
  } else if (task.type === 'baseline') {
    userContent = BASELINE_PROMPT + '\n\n# 事实数据(JSON)\n' + JSON.stringify({ natal, scope: {} });
  } else {
    const whenLabel = task.type === 'decade' ? '所处大运(含 ' + y + ' 年)' : (task.month !== undefined ? y + '年' + task.month + '月' : y + '年');
    const ageSeg = y !== undefined && record.birthYear ? '(年龄约 ' + (y - record.birthYear) + ')' : '';
    const hits = (scope.annualHits && scope.annualHits.length) || (scope.monthlyHits && scope.monthlyHits.length) || (scope.decadeHits && scope.decadeHits.length);
    const prompt = SCOPE_PROMPT(whenLabel, ageSeg, !!hits);
    const note = task.baseline ? baselineSummaryOf(task.baseline) : '';
    userContent = prompt + (note ? '\n# 本命结论(已定，必须沿用，不得重算)\n' + note : '') + '\n\n# 事实数据(JSON，只依据此数据)\n' + JSON.stringify({ natal, scope });
  }
  userContent += '\n\n# 语气要求(必须按此措辞把握全篇)\n' + toneInstruction(tone);
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }] };
}

export function cacheKey(record, task, model, tone = DEFAULT_TONE) {
  const toneBucket = Math.round(clampTone(tone) / 5) * 5; // 每 5 度一个缓存档，避免同一命盘缓存爆炸
  return ['v6', model, record.gender, record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar, task.type, task.year ?? 0, task.month ?? 0, record.birthYear, toneBucket].join('|');
}

/** 调一次上游(单 provider，最多 transport 重试一次)；失败返回 {error}。 */
async function callProvider(provider, key, messages) {
  const body = { model: provider.model, messages };
  if (provider.id !== 'deepseek') body.temperature = 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (attempt === 0 && (res.status === 429 || res.status >= 500)) continue;
        return { error: 'HTTP ' + res.status };
      }
      const data = await res.json();
      const raw = String(data?.choices?.[0]?.message?.content ?? '').trim();
      if (!raw) return { error: 'empty response' };
      const cleaned = raw.replace(/^\`\`\`json?\s*/i, '').replace(/\`\`\`\s*$/, '').trim();
      try { return { analysis: JSON.parse(cleaned) }; }
      catch { return { error: 'invalid response JSON' }; }
    }
    return { error: 'transport retries exhausted' };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 执行单个任务：命中服务器缓存 -> 调用所选/备用 provider -> 写缓存。 */
export async function runOneTask(db, record, task, tone = DEFAULT_TONE) {
  const t = clampTone(tone);
  const { messages } = buildTaskPayload(record, task, t);
  const order = providerOrder(db);
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
    const result = await callProvider(provider, key, messages);
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
  const r = await callProvider(provider, key, messages);
  if (r.analysis) return { ok: true, provider: provider.id, model: provider.model, latencyMs: Date.now() - started, reply: r.analysis };
  return { ok: false, message: provider.id + ' ' + (r.error || 'failed') };
}
