/* =============================================================================
 * 神煞(经典干支起法) — 确定性规则引擎
 *
 * 流派说明：以下均为流传较广、可逐条核验的经典起法（规则版本 classic-v1）：
 *  - 以日干取：天乙贵人、文昌贵人、禄神、羊刃(仅阳干)
 *  - 以年支(兼看日支)三合局取：桃花/咸池、驿马、华盖、将星、劫煞、亡神
 *  - 以月支取：天德贵人、月德贵人
 *  - 以年支三会取：孤辰、寡宿
 *  - 以日柱旬空取：空亡
 * 每条命中都记录 所在柱(年0月1日2时3)、干支位、依据，便于 UI 与审计。
 * lunar-javascript 的“日吉神/日凶煞”属择日神煞，单独保留，不混入本表。
 * ========================================================================== */
import type { ShenShaItem } from '../../types/domain';
const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const iStem = (c: string) => STEMS.indexOf(c);
const iBranch = (c: string) => BRANCHES.indexOf(c);
const mod = (n: number, m: number) => ((n % m) + m) % m;

type Item = Omit<ShenShaItem, 'pillarIndex' | 'position'>;
const add = (list: ShenShaItem[], pillarIndex: number, position: '天干' | '地支', item: Item) => {
  list.push({ ...item, pillarIndex, position } as ShenShaItem);
};

/** 以日干取贵人的起法表：name → 可坐的地支序 */
const BY_DAY_STEM_BRANCH: ReadonlyArray<ReadonlyArray<{ name: string; category: '吉' | '凶' | '中'; branches: number[]; how: string }>> = [
  // 甲(0)
  [
    { name: '天乙贵人', category: '吉', branches: [1, 7], how: '甲戊庚牛羊' },
    { name: '文昌贵人', category: '吉', branches: [5], how: '甲见巳' },
    { name: '禄神', category: '吉', branches: [2], how: '甲禄在寅' },
    { name: '羊刃', category: '凶', branches: [3], how: '甲羊刃在卯' },
  ],
  // 乙(1)
  [
    { name: '天乙贵人', category: '吉', branches: [0, 8], how: '乙己鼠猴乡' },
    { name: '文昌贵人', category: '吉', branches: [6], how: '乙见午' },
    { name: '禄神', category: '吉', branches: [3], how: '乙禄在卯' },
  ],
  // 丙(2)
  [
    { name: '天乙贵人', category: '吉', branches: [11, 9], how: '丙丁猪鸡位' },
    { name: '文昌贵人', category: '吉', branches: [8], how: '丙戊见申' },
    { name: '禄神', category: '吉', branches: [5], how: '丙禄在巳' },
    { name: '羊刃', category: '凶', branches: [6], how: '丙羊刃在午' },
  ],
  // 丁(3)
  [
    { name: '天乙贵人', category: '吉', branches: [11, 9], how: '丙丁猪鸡位' },
    { name: '文昌贵人', category: '吉', branches: [9], how: '丁己见酉' },
    { name: '禄神', category: '吉', branches: [6], how: '丁禄在午' },
  ],
  // 戊(4)
  [
    { name: '天乙贵人', category: '吉', branches: [1, 7], how: '甲戊庚牛羊' },
    { name: '文昌贵人', category: '吉', branches: [8], how: '丙戊见申' },
    { name: '禄神', category: '吉', branches: [5], how: '戊禄在巳' },
    { name: '羊刃', category: '凶', branches: [6], how: '戊羊刃在午' },
  ],
  // 己(5)
  [
    { name: '天乙贵人', category: '吉', branches: [0, 8], how: '乙己鼠猴乡' },
    { name: '文昌贵人', category: '吉', branches: [9], how: '丁己见酉' },
    { name: '禄神', category: '吉', branches: [6], how: '己禄在午' },
  ],
  // 庚(6)
  [
    { name: '天乙贵人', category: '吉', branches: [1, 7], how: '甲戊庚牛羊' },
    { name: '文昌贵人', category: '吉', branches: [11], how: '庚见亥' },
    { name: '禄神', category: '吉', branches: [8], how: '庚禄在申' },
    { name: '羊刃', category: '凶', branches: [9], how: '庚羊刃在酉' },
  ],
  // 辛(7)
  [
    { name: '天乙贵人', category: '吉', branches: [6, 2], how: '六辛逢马虎' },
    { name: '文昌贵人', category: '吉', branches: [0], how: '辛见子' },
    { name: '禄神', category: '吉', branches: [9], how: '辛禄在酉' },
  ],
  // 壬(8)
  [
    { name: '天乙贵人', category: '吉', branches: [3, 5], how: '壬癸兔蛇藏' },
    { name: '文昌贵人', category: '吉', branches: [2], how: '壬见寅' },
    { name: '禄神', category: '吉', branches: [11], how: '壬禄在亥' },
    { name: '羊刃', category: '凶', branches: [0], how: '壬羊刃在子' },
  ],
  // 癸(9)
  [
    { name: '天乙贵人', category: '吉', branches: [3, 5], how: '壬癸兔蛇藏' },
    { name: '文昌贵人', category: '吉', branches: [3], how: '癸见卯' },
    { name: '禄神', category: '吉', branches: [0], how: '癸禄在子' },
  ],
];

/** 三合局(g=branch%4)取 桃花/驿马/华盖/将星/劫煞/亡神 的目标地支 */
const GROUP_STAR: Record<string, number[]> = {
  桃花: [9, 6, 3, 0],   // 申子辰酉 巳酉丑午 寅午戌卯 亥卯未子
  驿马: [2, 11, 8, 5],
  华盖: [4, 1, 10, 7],
  将星: [0, 9, 6, 3],
  劫煞: [5, 2, 11, 8],
  亡神: [11, 8, 5, 2],
};
const GROUP_NAME = (b: number) => '申子辰巳酉丑寅午戌亥卯未'.slice((b % 4) * 3, (b % 4) * 3 + 3);

/** 月支 → 天德贵人(12 支序)；值为目标字符(或为干序、或为支序) */
const TIAN_DE: ReadonlyArray<{ stem?: number; branch?: number }> = [
  { branch: 5 },  // 子→巳
  { stem: 6 },    // 丑→庚
  { stem: 3 },    // 寅→丁
  { branch: 8 },  // 卯→申
  { stem: 8 },    // 辰→壬
  { stem: 7 },    // 巳→辛
  { branch: 11 }, // 午→亥
  { stem: 0 },    // 未→甲
  { stem: 9 },    // 申→癸
  { branch: 2 },  // 酉→寅
  { stem: 2 },    // 戌→丙
  { stem: 1 },    // 亥→乙
];
/** 月支三合 → 月德贵人(干序) */
const YUE_DE = [8, 6, 2, 0]; // 申子辰壬 巳酉丑庚 寅午戌丙 亥卯未甲

/** 神煞主入口：pillars = [年柱,月柱,日柱,时柱] */
export function computeShenSha(pillars: string[]): ShenShaItem[] {
  const items: ShenShaItem[] = [];
  const branchOf = (gz: string) => iBranch(gz[1]);
  const stemsIn = (gz: string) => gz[0];
  const branches = pillars.map(branchOf);

  const dayStem = pillars[2][0];
  const ds = iStem(dayStem);
  // 1) 日干取贵
  for (const rule of BY_DAY_STEM_BRANCH[ds] ?? []) {
    for (let p = 0; p < 4; p += 1) {
      if (rule.branches.includes(branches[p])) {
        add(items, p as ShenShaItem['pillarIndex'], '地支', { name: rule.name, category: rule.category, basis: '日干' + dayStem + '·' + rule.how });
      }
    }
  }
  // 2) 年支(兼看日支)三合局取神煞
  const anchorGroups = [branches[0], branches[2]];
  for (const anchor of anchorGroups) {
    const g = anchor % 4;
    const gName = GROUP_NAME(anchor);
    for (const [name, targets] of Object.entries(GROUP_STAR)) {
      for (let p = 0; p < 4; p += 1) {
        if (targets[g] === branches[p] && !items.some((it) => it.name === name && it.pillarIndex === p)) {
          add(items, p as ShenShaItem['pillarIndex'], '地支', { name, category: name === '劫煞' || name === '亡神' ? '凶' : '中', basis: (anchor === branches[0] ? '年支' : '日支') + BRANCHES[anchor] + '·' + gName + (name === '桃花' ? '局桃花' : name) });
        }
      }
    }
  }
  // 3) 月支取天德/月德
  const mb = branches[1];
  const td = TIAN_DE[mb];
  for (let p = 0; p < 4; p += 1) {
    const pillar = pillars[p];
    if (td.stem !== undefined && iStem(pillar[0]) === td.stem) {
      add(items, p as ShenShaItem['pillarIndex'], '天干', { name: '天德贵人', category: '吉', basis: '月支' + BRANCHES[mb] + '见' + STEMS[td.stem] });
    }
    if (td.branch !== undefined && branchOf(pillar) === td.branch) {
      add(items, p as ShenShaItem['pillarIndex'], '地支', { name: '天德贵人', category: '吉', basis: '月支' + BRANCHES[mb] + '见' + BRANCHES[td.branch] });
    }
    if (iStem(pillar[0]) === YUE_DE[mb % 4]) {
      add(items, p as ShenShaItem['pillarIndex'], '天干', { name: '月德贵人', category: '吉', basis: '月支' + BRANCHES[mb] + '·' + GROUP_NAME(mb) + '月德' });
    }
  }
  // 4) 年支三会取孤辰寡宿
  const yb = branches[0];
  const band = yb <= 1 || yb === 11 ? 0 : yb <= 4 ? 1 : yb <= 7 ? 2 : 3;
  const lonely = [2, 5, 8, 11][band];   // 孤辰：寅巳申亥
  const widow = [10, 1, 4, 7][band];    // 寡宿：戌丑辰未
  for (let p = 0; p < 4; p += 1) {
    if (branches[p] === lonely) add(items, p as ShenShaItem['pillarIndex'], '地支', { name: '孤辰', category: '凶', basis: '年支三会孤辰' });
    if (branches[p] === widow) add(items, p as ShenShaItem['pillarIndex'], '地支', { name: '寡宿', category: '凶', basis: '年支三会寡宿' });
  }
  // 5) 日柱旬空：找出日柱所在旬缺的两支，命中他柱则“空亡”
  const dayIdx = (() => {
    const s = iStem(pillars[2][0]);
    const b = iBranch(pillars[2][1]);
    for (let n = 0; n < 60; n += 1) if (n % 10 === s && n % 12 === b) return n;
    return -1;
  })();
  if (dayIdx >= 0) {
    const k = (dayIdx - (dayIdx % 10)) % 12;
    const kong = [(k + 10) % 12, (k + 11) % 12];
    for (let p = 0; p < 4; p += 1) {
      if (kong.includes(branches[p])) {
        add(items, p as ShenShaItem['pillarIndex'], '地支', { name: '空亡', category: '凶', basis: '日柱旬空' + kong.map((x) => BRANCHES[x]).join('') });
      }
    }
  }
  return items;
}
