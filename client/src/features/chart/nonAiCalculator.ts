import { Solar } from 'lunar-javascript';
import { chinaYear } from '../../utils/date';
export { chinaYear }; // 兼容既有调用点

import { computeShenSha } from './shenSha';
import type { BaziRecord, Gender, NonAiChart, RelationshipFacts, RelationshipDetail, FortunePeriod, ShenShaItem } from '../../types/domain';

/* =============================================================================
 * 确定性命理计算核心 (non-AI engine) — 数学模型
 *
 * 分工：历法事实(节气/农历/四柱/藏干/纳音/长生/神煞)来自开源库
 * lunar-javascript(6tail)，本模块只做「以干支为符号的确定性代数」：
 *
 *  1) 干支序数化：六十甲子 = 序数 n(0..59)，天干 = n%10，地支 = n%12。
 *     任意干支只需一张 60 项查找表，不再散列映射。
 *  2) 五行：天干五行 = 干序 >> 1；地支五行 = 本气表(索引)。
 *     生克循环(木→火→土→金→水)在序数上即 +1/+2(mod 5)。
 *  3) 十神：元素差 d=(e1-e0+5)%5 → 0比劫 1食伤 2我克(财) 3克我(官杀) 4生我(印)；
 *     阴阳(干序奇偶)决定正偏。
 *  4) 地支关系：六合 (a+b)%12=1；六冲 |a-b|=6；六害 (a+b)%12=7；
 *     三合 a%4=b%4(申子辰0 巳酉丑1 寅午戌2 亥卯未3)；六破/三刑为规范对与同余类。
 *  5) 大运 = 月柱序数沿顺逆每次 ±1(十年一柱)，起运沿用「三天一岁」传统算法。
 *  6) 流年干支：立春锚定当前纪年序数，此后公历年每年 +1(mod 60)。
 *  7) 流月：每年 12 个节月(立春=寅月…)，月干由年干五虎遁：
 *     寅月干 = (年干序%5)*2+2，逐月 +1 —— 与 lunar-javascript buildLiuYue 同式。
 *
 * 全年流月序列按节气月排列(第1月=立春→惊蛰)，替代旧实现
 * 「公历每月 15 日取样」，无历法取样误差，边界完全确定。
 * ========================================================================== */

const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const ELEMENTS = ['木', '火', '土', '金', '水'] as const;
/** 地支本气五行索引(子水丑土寅木卯木辰土巳火午火未土申金酉金戌土亥水) */
const BRANCH_ELEMENT = [0, 2, 0, 0, 2, 1, 1, 2, 3, 3, 2, 4];
const YANG = '甲丙戊庚壬';                        // 阳干(序数为偶)
/** 六破规范对(小序在前)：子酉、丑辰、寅亥、卯午、巳申、未戌 */
const PO_PAIRS = [[0, 9], [1, 4], [2, 11], [3, 6], [5, 8], [7, 10]] as const;
const XING_SELF = new Set([4, 6, 9, 11]);          // 辰午酉亥 自刑
const XING_TRIPLES: ReadonlyArray<readonly number[]> = [[1, 7, 10], [2, 5, 8]]; // 丑戌未、寅巳申 三刑组
const FORECAST = 10;                               // 预测窗口(公历年)
const GREAT = 9;                                   // 排出的大运柱数

const GANZHI_60 = Array.from({ length: 60 }, (_, n) => STEMS[n % 10] + BRANCHES[n % 12]);
const indexOfStem = (s: string) => STEMS.indexOf(s);
const indexOfBranch = (b: string) => BRANCHES.indexOf(b);
const mod = (n: number, m: number) => ((n % m) + m) % m;
const gzAt = (n: number) => GANZHI_60[mod(n, 60)];
const gzIndex = (gz: string) => GANZHI_60.indexOf(gz);

/** 立春(交年)锚点：取当年 7 月 1 日的精确纪年(必在立春之后)。 */
const yearGanZhiExact = (year: number) =>
  Solar.fromYmdHms(year, 7, 1, 12, 0, 0).getLunar().getYearInGanZhiExact();

/** 十神(纯代数)：元素差与阴阳定类。 */
function tenGodOf(dayStem: string, otherStem: string): string {
  if (dayStem === otherStem) return '日主';
  const d = mod((indexOfStem(otherStem) >> 1) - (indexOfStem(dayStem) >> 1), 5);
  const same = YANG.includes(dayStem) === YANG.includes(otherStem);
  if (d === 0) return same ? '比肩' : '劫财';
  if (d === 1) return same ? '食神' : '伤官';
  if (d === 2) return same ? '偏财' : '正财';
  if (d === 3) return same ? '七杀' : '正官';
  return same ? '偏印' : '正印';
}

const emptyFacts = (): RelationshipFacts => ({ sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] });

/* ------------------------------------------------------------ 关系数学内核 */
type Hit = { type: RelationshipDetail['type']; status: RelationshipDetail['status'] };

/** 两个地支序 a,b 的全部成对关系命中(三合/三刑“成局”需要集合级判断)。 */
function branchHits(a: number, b: number): Hit[] {
  const out: Hit[] = [];
  if (mod(a + b, 12) === 1) out.push({ type: 'liuHe', status: 'binding' });
  if (mod(a - b, 12) === 6) out.push({ type: 'chong', status: 'complete' });
  if (mod(a + b, 12) === 7) out.push({ type: 'hai', status: 'complete' });
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (PO_PAIRS.some(([x, y]) => x === lo && y === hi)) out.push({ type: 'po', status: 'complete' });
  // 刑的“成局”程度需要在参与集内判断(见 pairHits 内的提升逻辑)，此处只报命中。
  if (isXingPair(a, b)) out.push({ type: 'xing', status: 'partial-punishment' });
  return out;
}

/** 两支是否构成刑关系：子卯、三刑组内两两、自刑(辰午酉亥)。 */
function isXingPair(a: number, b: number): boolean {
  if (a === b) return XING_SELF.has(a);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return XING_TRIPLES.some((t) => t.includes(lo) && t.includes(hi)) || (lo === 0 && hi === 3);
}

/** 两干之间是否存在相克(五行为环：不同且不相生即克，方向由循环唯一确定)。 */
function stemKe(a: string, b: string): Hit[] {
  const ea = indexOfStem(a[0]) >> 1;
  const eb = indexOfStem(b[0]) >> 1;
  if (ea === eb) return [];
  if (mod(ea + 1, 5) === eb || mod(eb + 1, 5) === ea) return []; // 相生，非克
  return [{ type: 'ke', status: 'complete' }];
}

/** 三合同余类 → 组内所有地支。 */
const SAN_HE_BRANCHES = ['申子辰', '巳酉丑', '寅午戌', '亥卯未'] as const;

interface Node { value: string; layer: RelationshipDetail['sourceLayer']; name: string; }

/** 把参与集合 items 的所有成对命中展开为关系明细；层序非命局优先为 source。 */
function pairHits(items: Node[]): RelationshipDetail[] {
  const out: RelationshipDetail[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      let left = items[i];
      let right = items[j];
      if (left.layer === 'natal' && right.layer !== 'natal') [left, right] = [right, left];
      const hits = [...branchHits(indexOfBranch(left.value[1]), indexOfBranch(right.value[1])), ...stemKe(left.value, right.value)];
      for (const hit of hits) {
        out.push({ type: hit.type, sourceLayer: left.layer, sourcePillar: left.value, targetLayer: right.layer, targetPillar: right.value, status: hit.status });
      }
    }
  }
  // 三合：≥2 个不同的同组地支 → 半合；3 支齐 → 成局(重复支不重复计)。
  for (let g = 0; g < 4; g += 1) {
    const members = items.filter((item) => indexOfBranch(item.value[1]) % 4 === g);
    const distinct = [...new Set(members.map((item) => item.value[1]))];
    if (distinct.length < 2) continue;
    const source = members.find((item) => item.layer !== 'natal') ?? members[0];
    const target = members.find((item) => item !== source) ?? source;
    out.push({ type: 'sanHe', sourceLayer: source.layer, sourcePillar: source.value, targetLayer: target.layer, targetPillar: SAN_HE_BRANCHES[g], status: distinct.length === 3 ? 'complete' : 'half-combination' });
  }
  // 刑的成局提升：子卯/自刑以及三刑三支齐 → complete；缺支 → 半刑(partial-punishment)。
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = indexOfBranch(items[i].value[1]);
      const b = indexOfBranch(items[j].value[1]);
      if (!isXingPair(a, b)) continue;
      const [va, vb] = [items[i].value, items[j].value];
      const entries = out.filter((hit) => hit.type === 'xing' && ((hit.sourcePillar === va && hit.targetPillar === vb) || (hit.sourcePillar === vb && hit.targetPillar === va)));
      if (entries.length === 0) continue;
      const upgrade = (() => {
        if (a === b || (Math.min(a, b) === 0 && Math.max(a, b) === 3)) return true; // 自刑 / 子卯
        const triple = XING_TRIPLES.find((t) => t.includes(a) && t.includes(b));
        return triple !== undefined && triple.every((branch) => items.some((item) => indexOfBranch(item.value[1]) === branch));
      })();
      if (upgrade) for (const entry of entries) entry.status = 'complete';
    }
  }
  return out;
}

const describe = (a: string, b: string) => a + '与' + b;
const describeKe = (winner: string, loser: string) => winner + '克' + loser;

/** 两柱之间全部关系的文字事实(一对只产出一条，天然无重复)。 */
function factBetween(a: string, b: string, forecastFirst: boolean): RelationshipFacts {
  const facts = emptyFacts();
  const x = forecastFirst ? b : a;
  const y = forecastFirst ? a : b;
  const push = (k: keyof RelationshipFacts, s: string) => { (facts[k] as string[]).push(s); };
  const ab = indexOfBranch(a[1]);
  const bb = indexOfBranch(b[1]);
  if (ab % 4 === bb % 4) push('sanHe', describe(x, y));
  for (const hit of branchHits(ab, bb)) {
    if (hit.type === 'liuHe') push('liuHe', describe(x, y));
    if (hit.type === 'chong') push('chong', describe(x, y));
    if (hit.type === 'hai') push('hai', describe(x, y));
    if (hit.type === 'po') push('po', describe(x, y));
    if (hit.type === 'xing') push('xing', describe(x, y));
  }
  const ea = indexOfStem(a[0]) >> 1;
  const eb = indexOfStem(b[0]) >> 1;
  // 生克循环方向唯一：ea 克 eb ⇔ eb = ea + 2(mod 5)；互不相克(相生/比和)不记录。
  if (mod(ea + 2, 5) === eb) push('ke', describeKe(a, b));
  else if (mod(eb + 2, 5) === ea) push('ke', describeKe(b, a));
  return facts;
}

/** 命局四柱两两间的关系事实。 */
function natalFacts(pillars: string[]): RelationshipFacts {
  const out = emptyFacts();
  for (let i = 0; i < pillars.length; i += 1) {
    for (let j = i + 1; j < pillars.length; j += 1) {
      const facts = factBetween(pillars[i], pillars[j], false);
      for (const key of Object.keys(out) as (keyof RelationshipFacts)[]) (out[key] as string[]).push(...facts[key]);
    }
  }
  return out;
}

/** 某运/年/月柱与命局四柱的关系事实(运方在前)。 */
function fortuneFacts(forecast: string, natal: string[]): RelationshipFacts {
  const out = emptyFacts();
  for (const pillar of natal) {
    const facts = factBetween(forecast, pillar, true);
    for (const key of Object.keys(out) as (keyof RelationshipFacts)[]) (out[key] as string[]).push(...facts[key]);
  }
  return out;
}

/* ------------------------------------------------------------ 起运估算 */
interface StartEstimate {
  forward: boolean;
  boundary: string;
  start: string;
  components: { days: number; hours: number; years: number; months: number; extraDays: number };
}
function startEstimate(candidate: ReturnType<typeof Solar.fromYmdHms>, gender: Gender, yearStem: string): StartEstimate {
  // 传统「三天一岁」：3天=1年，1天=4月，1时辰=10天；出生信息只到“日”，以正午为锚 → estimated。
  const birth = Solar.fromYmdHms(candidate.getYear(), candidate.getMonth(), candidate.getDay(), 12, 0, 0);
  const forward = YANG.includes(yearStem) === (gender === 'male'); // 阳男阴女顺、阴男阳女逆
  const boundary = (forward ? birth.getLunar().getNextJieQi(false) : birth.getLunar().getPrevJieQi(false)).getSolar();
  const diffHours = Math.abs(Date.parse(boundary.toYmd() + 'T12:00:00+08:00') - Date.parse(candidate.toYmd() + 'T12:00:00+08:00')) / 3600000;
  const days = Math.floor(diffHours / 24);
  const hours = Math.floor(diffHours % 24);
  const years = Math.floor(days / 3);
  const months = Math.floor((days % 3) * 4);
  const extraDays = Math.floor((hours / 2) * 10); // 1 时辰≈2h → 10 天
  const start = new Date(Date.parse(candidate.toYmd() + 'T12:00:00+08:00'));
  start.setUTCFullYear(start.getUTCFullYear() + years);
  start.setUTCMonth(start.getUTCMonth() + months);
  start.setUTCDate(start.getUTCDate() + extraDays);
  return { forward, boundary: boundary.toYmd(), start: start.toISOString().slice(0, 10), components: { days, hours, years, months, extraDays } };
}

const asList = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [String(value ?? '')];

interface DayGodsSource {
  getDayJiShen(): string[];
  getDayXiongSha(): string[];
  getDaySha(): string;
  getDayTianShen(): string;
  getTimeTianShen(): string;
}

/** 神煞结果：经典干支神煞(逐柱、结构化) + lunar-javascript 日神煞(择日类，辅助)。 */
function buildShenShaResult(lunar: DayGodsSource, pillars: string[]): NonAiChart['shenSha'] {
  const items = computeShenSha(pillars);
  const unique = (list: ShenShaItem[]) => [...new Set(list.map((item) => item.name))];
  return {
    auspicious: unique(items.filter((item) => item.category === '吉')),
    inauspicious: unique(items.filter((item) => item.category === '凶')),
    items,
    daySha: lunar.getDaySha(),
    dayTianShen: lunar.getDayTianShen(),
    timeTianShen: lunar.getTimeTianShen(),
    ruleVersion: 'classic-v1 + lunar-javascript-1.7.7-day-gods',
    source: 'classic stem-branch shensha classic-v1 + lunar-javascript day gods only',
  };
}

/* ================================================================ 主入口 */

/* ---------------- 袁天罡称骨(骨重表 · ruleVersion chenggu-v1，以通行古本为准) ---------------- */
// 年柱骨重(按六十甲子序数，单位:两)。称骨按农历年/月/日/时干支。
const CHENGGU_YEAR = [1.2,0.9,0.6,0.7,1.2,0.5,0.9,0.8,0.7,0.8,1.5,0.9,1.6,0.8,0.8,1.9,1.2,0.6,0.8,0.7,0.5,1.5,0.6,1.6,1.5,0.7,0.9,1.2,1.0,0.7,1.5,0.6,0.5,1.4,1.4,0.9,0.7,0.7,0.9,0.6,0.8,0.7,0.5,0.5,1.4,0.5,0.9,1.7,0.5,0.7,1.2,0.8,0.8,0.6,1.9,0.6,0.8,1.6,1.0,0.6];
const CHENGGU_MONTH = [0.6,0.7,1.8,0.9,0.5,1.6,0.9,1.5,1.8,0.8,0.9,0.5]; // 农历正月..腊月(闰月同本月)
const CHENGGU_DAY = [0.5,1.0,0.8,1.5,1.6,1.5,0.8,1.6,0.8,1.6,0.9,1.7,0.8,1.7,1.0,0.8,0.9,1.8,0.5,1.5,1.0,0.9,0.8,0.9,1.5,1.8,0.7,0.8,1.6,0.6]; // 初一..三十
const CHENGGU_HOUR = [1.6,0.6,0.7,1.0,0.9,1.6,1.0,0.8,0.8,0.9,0.6,0.6]; // 子..亥
const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const liangText = (liang: number) => {
  const whole = Math.floor(liang + 1e-9);
  const qian = Math.round((liang - whole) * 10);
  return (whole > 0 ? CN[whole] + '两' : '') + (qian > 0 ? CN[qian] + '钱' : whole > 0 ? '' : '零');
};
/** 袁天罡称骨：输入农历 干支年(60序数)、农历月、农历日、时支序。 */
export function calculateChenggu(lunarYearGanZhi: string, lunarMonth: number, lunarDay: number, hourBranch: string): { parts: { year: string; month: string; day: string; hour: string }; totalLiang: number; totalText: string; ruleVersion: string } {
  const yearIdx = gzIndex(lunarYearGanZhi);
  const m = Math.min(Math.max(lunarMonth, 1), 12);
  const d0 = Math.min(Math.max(lunarDay, 1), 30);
  const h = indexOfBranch(hourBranch);
  const parts = {
    year: liangText(CHENGGU_YEAR[yearIdx] ?? 0),
    month: liangText(CHENGGU_MONTH[m - 1] ?? 0),
    day: liangText(CHENGGU_DAY[d0 - 1] ?? 0),
    hour: liangText(CHENGGU_HOUR[Math.max(h, 0)] ?? 0),
  };
  const total = (CHENGGU_YEAR[yearIdx] ?? 0) + (CHENGGU_MONTH[m - 1] ?? 0) + (CHENGGU_DAY[d0 - 1] ?? 0) + (CHENGGU_HOUR[Math.max(h, 0)] ?? 0);
  return { parts, totalLiang: total, totalText: liangText(total), ruleVersion: 'chenggu-v1' };
}

export function calculateNonAi(
  input: Pick<BaziRecord, 'birthYear' | 'birthMonth' | 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'>,
  gender: Gender,
  now = new Date().toISOString(),
): NonAiChart {
  const pillars = [input.yearPillar, input.monthPillar, input.dayPillar, input.hourPillar];
  const valid = new RegExp('^[' + STEMS + '][' + BRANCHES + ']$');
  if (pillars.some((p) => !valid.test(p))) throw new Error('四柱必须填写有效的天干地支');
  // 干支合法性即“阴阳同气”：天干序与地支序奇偶一致。
  if (pillars.some((p) => (indexOfStem(p[0]) & 1) !== (indexOfBranch(p[1]) & 1))) throw new Error('每柱天干和地支必须阴阳相同');
  // 由四柱反查唯一(年、月匹配)的公历候选；sect=2 表示晚子时日柱按子正处理。
  const candidate = Solar.fromBaZi(input.yearPillar, input.monthPillar, input.dayPillar, input.hourPillar, 2, 1900)
    .find((solar) => solar.getYear() === input.birthYear && solar.getMonth() === input.birthMonth);
  if (!candidate) throw new Error('未找到 ' + input.birthYear + ' 年 ' + input.birthMonth + ' 月与四柱匹配的日期');
  const lunar = candidate.getLunar();
  const eight = lunar.getEightChar();
  const day = eight.getDayGan();
  const estimate = startEstimate(candidate, gender, input.yearPillar[0]);
  const chenggu = calculateChenggu(lunar.getYearInGanZhiExact(), lunar.getMonth(), lunar.getDay(), input.hourPillar[1]);

  // 五行计数：四天干 + 四地支本气 = 8 个观测，比例和为 1。
  const counts: Record<string, number> = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  for (const pillar of pillars) {
    counts[ELEMENTS[indexOfStem(pillar[0]) >> 1]] += 1;
    counts[ELEMENTS[BRANCH_ELEMENT[indexOfBranch(pillar[1])]]] += 1;
  }
  const elementRatio = Object.fromEntries(ELEMENTS.map((e) => [e, counts[e] / (pillars.length * 2)]));

  const natalItems: Node[] = pillars.map((value, index) => ({ value, layer: 'natal' as const, name: String(index) }));
  const relationships = natalFacts(pillars);
  const relationshipDetails = pairHits(natalItems);

  // 藏干 + 藏干十神(root/middle/residual)，顺序与 lunar-javascript 一致。
  const hiddenStems = [asList(eight.getYearHideGan()), asList(eight.getMonthHideGan()), asList(eight.getDayHideGan()), asList(eight.getTimeHideGan())];
  const hiddenGods = [asList(eight.getYearShiShenZhi()), asList(eight.getMonthShiShenZhi()), asList(eight.getDayShiShenZhi()), asList(eight.getTimeShiShenZhi())];
  const tenGodDetails = {
    heavenly: [eight.getYearShiShenGan(), eight.getMonthShiShenGan(), eight.getDayShiShenGan(), eight.getTimeShiShenGan()],
    hidden: hiddenStems.map((stemsInBranch, pi) => stemsInBranch.map((stem, si) => ({
      stem,
      tenGod: hiddenGods[pi][si] ?? tenGodOf(day, stem),
      position: (si === 0 ? 'root' : si === 1 ? 'middle' : 'residual') as 'root' | 'middle' | 'residual',
    }))),
  };

  const currentYear = chinaYear(now);

  // 流年：立春锚定当前干支年序，其后公历年每年 +1(六十甲子)。
  const baseIndex = gzIndex(yearGanZhiExact(currentYear));
  const annualFortunes: FortunePeriod[] = Array.from({ length: FORECAST }, (_, i) => {
    const year = currentYear + i;
    const ganZhi = gzAt(baseIndex + i);
    const participants = [...natalItems, { value: ganZhi, layer: 'annual' as const, name: String(year) }];
    return { year, month: 1, ganZhi, tenGod: tenGodOf(day, ganZhi[0]), relationships: fortuneFacts(ganZhi, pillars), relationshipDetails: pairHits(participants) };
  });

  // 流月：每年 12 个节月(立春起=寅月…)，五虎遁定月干 → 纯算术。
  const monthlyFortunes: FortunePeriod[] = annualFortunes.flatMap(({ year, ganZhi: ygz }) => {
    const firstStem = mod((indexOfStem(ygz[0]) % 5) * 2 + 2, 10); // 五虎遁：寅月干
    return Array.from({ length: 12 }, (_, m) => {
      const ganZhi = STEMS[mod(firstStem + m, 10)] + BRANCHES[mod(2 + m, 12)];
      const participants = [...natalItems, { value: ganZhi, layer: 'monthly' as const, name: year + '-' + (m + 1) }];
      return { year, month: m + 1, ganZhi, tenGod: tenGodOf(day, ganZhi[0]), relationships: fortuneFacts(ganZhi, pillars), relationshipDetails: pairHits(participants) };
    });
  });

  // 大运：月柱序数沿顺逆每次 ±1，十年一柱。
  const monthIndex = gzIndex(input.monthPillar);
  const greatFortunes = Array.from({ length: GREAT }, (_, k) => {
    const ganZhi = gzAt(monthIndex + (estimate.forward ? 1 : -1) * (k + 1));
    const startYear = Number(estimate.start.slice(0, 4)) + k * 10;
    const participants = [...natalItems, { value: ganZhi, layer: 'great-fortune' as const, name: String(startYear) }];
    return { ganZhi, startYear, endYear: startYear + 9, tenGod: tenGodOf(day, ganZhi[0]), relationships: fortuneFacts(ganZhi, pillars), relationshipDetails: pairHits(participants) };
  });

  return {
    pillars: { year: eight.getYear(), month: eight.getMonth(), day: eight.getDay(), hour: eight.getTime() },
    solarDate: candidate.toYmd(),
    lunarDate: lunar.toString(),
    zodiac: lunar.getYearShengXiao(),
    elements: counts,
    elementRatio,
    hiddenStems,
    tenGods: [eight.getYearShiShenGan(), eight.getMonthShiShenGan(), eight.getDayShiShenGan(), eight.getTimeShiShenGan()],
    naYin: [eight.getYearNaYin(), eight.getMonthNaYin(), eight.getDayNaYin(), eight.getTimeNaYin()],
    dayMaster: day,
    fortuneStart: estimate.start,
    currentTime: now,
    forecastRange: annualFortunes.map((item) => item.year),
    relationships,
    relationshipDetails,
    fortuneMethod: { method: 'three-days-one-year', estimated: true, boundary: estimate.boundary, components: estimate.components },
    tenGodDetails,
    greatFortunes,
    annualFortunes,
    monthlyFortunes,
    twelveLongevity: [eight.getYearDiShi(), eight.getMonthDiShi(), eight.getDayDiShi(), eight.getTimeDiShi()],
    shenSha: buildShenShaResult(lunar, pillars),
    shenShaRuleVersion: 'classic-v1 + lunar-javascript-1.7.7-day-gods',
    chenggu,
  };
}
/** 供“从今天起的未来十二个月”逐月调用：返回某公历年月的 干支月/十神/关系/命中明细。
 *  干支取该公历月 15 日所在节气月(月中代表日，避免边界歧义)。 */
export function singleCalendarMonth(
  natal: Pick<BaziRecord, 'birthYear' | 'birthMonth' | 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'>,
  year: number, month: number,
): FortunePeriod {
  const pillars = [natal.yearPillar, natal.monthPillar, natal.dayPillar, natal.hourPillar];
  const day = pillars[2][0];
  const ganZhi = Solar.fromYmdHms(year, month, 15, 12, 0, 0).getLunar().getMonthInGanZhiExact();
  const natalItems: Node[] = pillars.map((value, index) => ({ value, layer: 'natal' as const, name: String(index) }));
  const participants = [...natalItems, { value: ganZhi, layer: 'monthly' as const, name: year + '-' + month }];
  return {
    year, month, ganZhi,
    tenGod: tenGodOf(day, ganZhi[0]),
    relationships: fortuneFacts(ganZhi, pillars),
    relationshipDetails: pairHits(participants),
  };
}