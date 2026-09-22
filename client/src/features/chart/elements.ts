/* =============================================================================
 * 五行计数 —— 命盘引擎的唯一口径，单独成模块
 *
 * 为什么单独放一个文件：countElements 只依赖干支/藏干两张纯表，不需要历法库
 * (lunar-javascript) 那 300KB。仓库、聊天证据、服务器证据组装三端都要用它来
 * 校正「存进库里的旧计数」，若各自引一遍引擎就会把大库拖进首屏。
 *
 * 口径：本命八字 = 4 天干 + 4 地支「本气」= 8 个观测。
 * 地支本气不另立手抄索引表，直接取藏干表首位(子藏癸 → 水)。
 * 历史教训：早先的手抄表把「子」写成木，凡命局带子的盘一律 木+1、水-1，
 * 还跟按藏干算出来的旺衰/十神自相矛盾(引擎里两套口径打架)。故版本记为 branch-main-v2，
 * 读到旧版本或缺版本的存量时按本函数回填。
 * ========================================================================== */

export const STEMS = '甲乙丙丁戊己庚辛壬癸';
export const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
export const ELEMENTS = ['木', '火', '土', '金', '水'] as const;

/** 地支藏干，按 本气→中气→余气 排列(「巳」取通行印本 丙庚戊，本气丙火不变)。 */
export const HIDDEN_STEMS: Record<string, string[]> = {
  子: ['癸'], 丑: ['己', '癸', '辛'], 寅: ['甲', '丙', '戊'], 卯: ['乙'],
  辰: ['戊', '乙', '癸'], 巳: ['丙', '庚', '戊'], 午: ['丁', '己'], 未: ['己', '丁', '乙'],
  申: ['庚', '壬', '戊'], 酉: ['辛'], 戌: ['戊', '辛', '丁'], 亥: ['壬', '甲'],
};

/** 天干五行索引：甲乙→木 丙丁→火 戊己→土 庚辛→金 壬癸→水。 */
export const stemElementIndex = (stem: string) => Math.floor(STEMS.indexOf(stem) / 2);

export const ELEMENT_RULE_VERSION = 'branch-main-v2';

/** 计数/比例：无法识别的干支直接跳过(不污染比例)，比例分母取实际观测数。 */
export function countElements(pillars: string[]): { elements: Record<string, number>; elementRatio: Record<string, number>; elementRuleVersion: string } {
  const elements: Record<string, number> = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  let observed = 0;
  for (const pillar of pillars) {
    const stem = pillar?.[0] ?? '';
    const mainStem = (HIDDEN_STEMS[pillar?.[1] ?? ''] ?? [])[0] ?? '';
    if (STEMS.indexOf(stem) < 0 || !mainStem) continue;
    elements[ELEMENTS[stemElementIndex(stem)]] += 1;
    elements[ELEMENTS[stemElementIndex(mainStem)]] += 1;
    observed += 2;
  }
  const elementRatio = Object.fromEntries(ELEMENTS.map((element) => [element, elements[element] / (observed || 1)]));
  return { elements, elementRatio, elementRuleVersion: ELEMENT_RULE_VERSION };
}

/* ---------- 聊天正文去英文 ----------
 * 实测(deepseek-chat + reasoning_effort=high)模型会把证据 JSON 里的英文字段名
 * (patternFacts / strengthScore / dayMaster 等)原样抄进正文。提示词已明令禁止，
 * 但提示词只是软约束，故再加一道确定性清洗兜底。
 * 原则：只动「夹在中文语境里的英文词」，中文与标点一律不动；
 * 整段纯英文(模型跑偏/报错)宁可清空后由上层提示缺数据，也不把英文丢给用户看。 */
export const FIELD_NAME_ZH: Record<string, string> = {
  patternFacts: '格局事实', strengthScore: '旺衰评分', dayMaster: '日主', elementRatio: '五行比例',
  elements: '五行', hiddenStems: '藏干', tenGods: '十神', naYin: '纳音', twelveLongevity: '十二长生',
  shenSha: '神煞', relationships: '刑冲合害', solarDate: '公历日期', lunarDate: '农历日期',
  zodiac: '生肖', gender: '性别', birthYear: '出生年', pillars: '四柱', natal: '命盘事实',
  periodFacts: '时段运势', analyses: '已算批断', missing: '数据缺口', plan: '检索计划',
  verdict: '判定', favorites: '喜用', favorable: '喜用', unfavorable: '忌神', score: '分值',
};

export function sanitizeChatText(text: string): string {
  let out = String(text ?? '');
  // 1) 整段几乎全是英文(含连续英文词 ≥4 个且中文极少) → 视为跑偏，返回空交给上层兜底
  const cjk = (out.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = out.match(/[A-Za-z]{2,}/g) ?? [];
  if (cjk === 0 && latinWords.length >= 4) return '';
  // 2) 已知字段名 → 中文说法
  out = out.replace(/[A-Za-z_][A-Za-z0-9_]{1,}/g, (word) => FIELD_NAME_ZH[word] ?? word);
  // 3) 仍是纯英文词(未收录的标识符/变量名) → 删掉；保留单字母(AI 等缩写词由 4 步处理)
  out = out.replace(/(?<=[\u4e00-\u9fff\s、，。；：（）「」])[A-Za-z_][A-Za-z0-9_]{2,}/g, '');
  // 4) 常见英文缩写就地中文化
  out = out.replace(/\bAI\b/g, 'AI').replace(/\s{2,}/g, ' ').replace(/ +([，。、；：）])/g, '$1');
  return out.trim();
}

/** 批断正文(explanation 等)的英文清洗：先按字段名翻中文，再清掉残留标识符与 `xx: 值` 残句。
 *  与聊天不同，这里不做「整段英文→清空」的丢弃(批断长文里偶有一两个词不该毁掉整段)。 */
export function sanitizeAnalysisText(text: string): string {
  let out = String(text ?? '').replace(/\r/g, '');
  if (!/[A-Za-z]/.test(out)) return out;
  // 「得令与否(inSeason)为false」这类由提示词引导出的照抄 → 去掉括号注音，让中文说法留下。
  out = out.replace(/[（(]\s*(?:[A-Za-z_][A-Za-z0-9_]*)(?:\s*[:=]\s*[A-Za-z0-9_.+-]+)?\s*[)）]/g, '');
  out = out.replace(/[A-Za-z_][A-Za-z0-9_]{1,}/g, (word) => FIELD_NAME_ZH[word] ?? word);
  out = out.replace(/([^\s：:])[：:]\s*(?:true|false|null|undefined|None)\b/gi, '$1');
  out = out.replace(/(?<=[\u4e00-\u9fff、，。；：（）「」])[A-Za-z_][A-Za-z0-9_]{2,}/g, '');
  out = out.replace(/[A-Za-z_]{2,}/g, '');
  out = out.replace(/\bAI\b/g, 'AI').replace(/[ \t]{2,}/g, ' ').replace(/ +([，。、；：）])/g, '$1');
  return out.split('\n').map((line) => line.replace(/\s+$/, '')).join('\n').trim();
}
