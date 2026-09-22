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
