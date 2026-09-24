import { Solar, Lunar } from 'lunar-javascript';
import { chinaYear } from '../../utils/date';
export { chinaYear }; // 兼容既有调用点

import { computeShenSha } from './shenSha';
import { STEMS, BRANCHES, ELEMENTS, HIDDEN_STEMS, stemElementIndex, ELEMENT_RULE_VERSION, countElements } from './elements';
import type { BaziRecord, Gender, NonAiChart, RelationshipFacts, RelationshipDetail, FortunePeriod, ShenShaItem } from '../../types/domain';
export { ELEMENT_RULE_VERSION, countElements }; // 口径唯一真源在 ./elements，这里转出以兼容既有引用

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
 *  5) 大运 = 月柱序数沿顺逆每次 ±1(十年一柱)，起点由「起运」推算：出生时刻到相邻节令
 *     的距离按每 3 天折 1 年(流派1)。缺精确出生日期时不硬编，退回对齐公历十年边界。
 *  6) 流年干支：立春锚定当前纪年序数，此后公历年每年 +1(mod 60)。
 *  7) 流月：每年 12 个节月(立春=寅月…)，月干由年干五虎遁：
 *     寅月干 = (年干序%5)*2+2，逐月 +1 —— 与 lunar-javascript buildLiuYue 同式。
 *
 * 全年流月序列按节气月排列(第1月=立春→惊蛰)，替代旧实现
 * 「公历每月 15 日取样」，无历法取样误差，边界完全确定。
 * ========================================================================== */

const YANG = '甲丙戊庚壬';                        // 阳干(序数为偶)

/** 起运信息：从出生到「起运」的时间跨度与对应的公历日期。 */
export interface LuckStart {
  years: number; months: number; days: number;
  /** 起运的公历日期 yyyy-mm-dd；库未给出时为空串 */
  date: string;
}

/** 起运推算：顺行取出生后下一个节、逆行取出生前上一个节，距离按每 3 天折 1 年、
 *  每 1 天折 4 个月(流派1)。方向由库按性别+年干阴阳自定，故此处不传方向。
 *  失败(极端日期/库异常)返回 null，让调用方走兜底而不是抛错打断排盘。 */
function computeLuckStart(at: ReturnType<typeof Solar.fromYmdHms>, gender: Gender): LuckStart | null {
  try {
    const yun = at.getLunar().getEightChar().getYun(gender === 'male' ? 1 : 0);
    const solar = yun.getStartSolar();
    if (!solar) return null;
    return {
      years: Number(yun.getStartYear()) || 0,
      months: Number(yun.getStartMonth()) || 0,
      days: Number(yun.getStartDay()) || 0,
      date: String(solar.toYmd()),
    };
  } catch { return null; }
}

/** 公历日期落在哪一「干支年」：立春(含当天)起算新一年，之前属上一年。
 *  固定按 2/4 判定 —— 实测各年立春只在 2/3~2/5 之间，而起运日期由「出生日 + 折年数」
 *  得到、跨度以年计，±1 天的误差不会改变大运段的十年归属，故无需引入学交节时刻。 */
function ganzhiYearOf(date: string): number | undefined {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(date);
  if (!m) return undefined;
  const year = Number(m[1]);
  const beforeLichun = Number(m[2]) < 2 || (Number(m[2]) === 2 && Number(m[3]) < 4);
  return beforeLichun ? year - 1 : year;
}

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

/* ---- 干支/藏干/五行计数在 ./elements(纯查表，与 lunar-javascript 逐支扫描比对一致)，
 *      单独成模块是因为仓库与聊天证据也要用同一口径，不该为此拖入历法库。 ---- */
/** 纳音五行(两柱一组，共 30 项)：甲子乙丑海中金 …… 壬戌癸亥大海水。 */
const NAYIN_30 = ['海中金', '炉中火', '大林木', '路旁土', '剑锋金', '山头火', '涧下水', '城头土', '白蜡金', '杨柳木', '泉中水', '屋上土', '霹雳火', '松柏木', '长流水', '沙中金', '山下火', '平地木', '壁上土', '金箔金', '覆灯火', '天河水', '大驿土', '钗钏金', '桑柘木', '大溪水', '沙中土', '天上火', '石榴木', '大海水'];
const naYinOf = (ganZhi: string) => { const i = GANZHI_60.indexOf(ganZhi); return i < 0 ? '' : NAYIN_30[Math.floor(i / 2)]; };
/** 十二长生：阳干顺行、阴干逆行，自「长生」起数。长生起点(甲亥 乙午 丙戊寅 丁己酉 庚巳 辛子 壬申 癸卯)。 */
const CHANG_SHENG_START = [11, 6, 2, 9, 2, 9, 5, 0, 8, 3];
const LONGEVITY_ORDER = ['长生', '沐浴', '冠带', '临官', '帝旺', '衰', '病', '死', '墓', '绝', '胎', '养'];
function longevityOf(dayStem: string, branch: string): string {
  const s = indexOfStem(dayStem);
  const b = indexOfBranch(branch);
  if (s < 0 || b < 0) return '';
  const forward = YANG.includes(dayStem);
  const delta = forward ? b - CHANG_SHENG_START[s] : CHANG_SHENG_START[s] - b;
  return LONGEVITY_ORDER[mod(delta, 12)];
}
const gzAt = (n: number) => GANZHI_60[mod(n, 60)];
const gzIndex = (gz: string) => GANZHI_60.indexOf(gz);

/** 立春(交年)锚点：取当年 7 月 1 日的精确纪年(必在立春之后)。 */
const yearGanZhiExact = (year: number) =>
  Solar.fromYmdHms(year, 7, 1, 12, 0, 0).getLunar().getYearInGanZhiExact();

/** 十神(纯代数)：元素差与阴阳定类。
 *  「日主」只用于日柱天干本身；别的柱(含藏干)与日主同干时应作「比肩」——
 *  实测这种情形极常见(一万天内 9636 次)，写成「日主」会让模型把比劫数错。 */
function tenGodOf(dayStem: string, otherStem: string, isDayPillar = false): string {
  if (isDayPillar && dayStem === otherStem) return '日主';
  const d = mod((indexOfStem(otherStem) >> 1) - (indexOfStem(dayStem) >> 1), 5);
  const same = YANG.includes(dayStem) === YANG.includes(otherStem);
  if (d === 0) return same ? '比肩' : '劫财';
  if (d === 1) return same ? '食神' : '伤官';
  if (d === 2) return same ? '偏财' : '正财';
  if (d === 3) return same ? '七杀' : '正官';
  return same ? '偏印' : '正印';
}

/* ---- 旺衰评分与取格(本地确定性算法) ------------------------------------------------
 * 目的：把「身强身弱」「什么格局」从模型的主观判断变成引擎算好的确定事实。
 * 提示词随后要求模型「沿用不重判」，同盘多次分析才会给出一致答案(命中率)。
 * 口径依《子平真诠》《滴天髓》通行规则：助身方=比劫+印星，克泄耗方=食伤+财星+官杀；
 * 力量分三层——天干透出(轻)、地支藏干按本气/中气/余气(重)、月令加倍(提纲秉令)，
 * 再按十二长生调整日主在该支的通根之力。参考跃渊 yueyuan-bazi skill v1.8 的告诫：
 * 反对「月令占 X%」式伪量化，故此处权重只是定性层级(本气>中气>余气、月支最重)的
 * 可复现实现，并在 detail 中逐项公开，任何一档都可回溯核对。
 * ------------------------------------------------------------------------------ */
/* 禄与刃按传统取法直接列表，**不从十二长生逆行表推导**。
 * 原因：十二长生有「阳顺阴逆」两套排法(乙长生在午、逆行临官在卯)，但论命取禄一律
 * 用「阴阳同宫」的那一套 —— 乙禄在寅(不是卯)、丁己禄在巳、辛禄在申、癸禄在亥。
 * 若照逆行表找「临官」，会把乙生寅月误判成「帝旺／阳刃」、把丁生午月误判成「建禄」。
 * 《子平真诠》论刃：「阳刃者，劫我正财之神…禄前一位，惟五阳有之」—— 阴干无刃。 */
/** 十干禄支(阴阳同宫)：甲寅 乙寅 丙巳 丁巳 戊巳 己巳 庚申 辛申 壬亥 癸亥。 */
export const STEM_LU: Record<string, string> = { 甲:'寅', 乙:'寅', 丙:'巳', 丁:'巳', 戊:'巳', 己:'巳', 庚:'申', 辛:'申', 壬:'亥', 癸:'亥' };
/** 阳刃＝禄前一位，只有阳干有；阴干古法无刃。 */
export const YANG_REN: Record<string, string> = { 甲:'卯', 丙:'午', 戊:'午', 庚:'酉', 壬:'子' };

/** 该月令是日主的「建禄(比劫当权)」还是「阳刃」，或都不是。 */
export function luRenOf(dayStem: string, monthBranch: string): '建禄' | '阳刃' | null {
  if (YANG_REN[dayStem] === monthBranch) return '阳刃';
  if (STEM_LU[dayStem] === monthBranch) return '建禄';
  // 阴干在禄支的对冲位不作刃论；月支本气与日主同类(如乙见寅中甲)亦以建禄归之。
  const main = (HIDDEN_STEMS[monthBranch] ?? [])[0] ?? '';
  if (main && ELEMENTS[indexOfStem(main) >> 1] === ELEMENTS[indexOfStem(dayStem) >> 1]) return '建禄';
  return null;
}
/** 六冲对(小序在前)：子午、丑未、寅申、卯酉、辰戌、巳亥 —— 冲动月支即动摇提纲。 */
const CHONG_PAIRS = [[0, 6], [1, 7], [2, 8], [3, 9], [4, 10], [5, 11]] as const;
const isChongPair = (a: number, b: number) => CHONG_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const ROOT_WEIGHT = [10, 5, 3] as const;
const STEM_WEIGHT = 6;
/** 十二长生对「日主通根」的乘数：旺相之地加倍，死绝之地不为根。 */
const STAGE_FACTOR: Record<string, number> = {
  长生: 1.0, 沐浴: 0.7, 冠带: 0.9, 临官: 1.2, 帝旺: 1.4, 衰: 0.7,
  病: 0.5, 死: 0.4, 墓: 0.6, 绝: 0.3, 胎: 0.4, 养: 0.5,
};
const TEN_GOD_SIDE: Record<string, 'support' | 'drain'> = {
  比肩: 'support', 劫财: 'support', 偏印: 'support', 正印: 'support', 日主: 'support',
  食神: 'drain', 伤官: 'drain', 偏财: 'drain', 正财: 'drain', 七杀: 'drain', 正官: 'drain',
};

export interface StrengthScore {
  support: number; drain: number; net: number; index: number;
  /** 身强 / 身弱 / 中和偏旺 / 中和偏弱 */
  label: string;
  /** 是否真得太旺之气：月支本气为印比，且未被冲、未作日主死绝之地 */
  inSeason: boolean;
  /** 月支藏干里出现助身方(含中余气)时置真，范围比 inSeason 宽得多 */
  monthHasSupport: boolean;
  /** 逐项明细：AI 引用此表即可，不必自己数 */
  detail: Array<{ pillar: string; stem: string; tenGod: string; side: string; weight: number; note?: string }>;
}

/** 旺衰评分：纯查表+纯代数，无历法依赖，任意环境可复现。 */
export function scoreStrength(pillars: string[], dayStem: string): StrengthScore {
  let support = 0, drain = 0;
  const detail: StrengthScore['detail'] = [];
  const names = ['年', '月', '日', '时'];
  for (let pi = 0; pi < pillars.length; pi++) {
    const gz = pillars[pi];
    if (!gz) continue;
    const isMonth = pi === 1;
    const hg = tenGodOf(dayStem, gz[0], pi === 2);
    const hSide = TEN_GOD_SIDE[hg] ?? 'drain';
    const hw = Math.round(STEM_WEIGHT * (isMonth ? 1.5 : 1) * 10) / 10;
    detail.push({ pillar: names[pi] + '干', stem: gz[0], tenGod: hg, side: hSide, weight: hw });
    if (hSide === 'support') support += hw; else drain += hw;
    // 十二长生乘数只作用于「与日主同类」的藏干(即日主在该支的通根)；其余藏干是该支
    // 自己的气(财官食伤)，其强弱不该被日主旺衰改写——早先乘到全部藏干上会把
    // 「甲日主生申月」误判成身强：申中庚金(七杀)被衰病系数削掉，等于替克我者减重。
    const dayElement = ELEMENTS[indexOfStem(dayStem) >> 1];
    const dayStage = longevityOf(dayStem, gz[1]);
    const rootlessHere = dayStage === '死' || dayStage === '绝';
    (HIDDEN_STEMS[gz[1]] ?? []).forEach((stem, si) => {
      const tg = tenGodOf(dayStem, stem);
      const side = TEN_GOD_SIDE[tg] ?? 'drain';
      // 月令加倍只作用于「日主自己的通根」：提纲所司是日主之气盛衰的总纲，
      // 不是把该支里财官食伤也一律翻倍——否则巳中庚金(七杀)被算成 20 分，
      // 任何甲日主生巳月都会被误判成「建禄格」(本气丁火实为伤官)。
      let w = (ROOT_WEIGHT[si] ?? 3) * ((isMonth && ELEMENTS[indexOfStem(stem) >> 1] === dayElement) ? 2 : 1);
      let note = '';
      if (ELEMENTS[indexOfStem(stem) >> 1] === dayElement && (tg === '比肩' || tg === '劫财')) {
        if (rootlessHere) { w = 0; note = '日主坐' + dayStage + '，此支不为根'; }
        else { const f = STAGE_FACTOR[dayStage] ?? 0.7; w *= f; note = '通根' + dayStage + '×' + f; }
      }
      w = Math.round(w * 10) / 10;
      detail.push({ pillar: names[pi] + '支·' + (si === 0 ? '本气' : si === 1 ? '中气' : '余气'), stem, tenGod: tg, side, weight: w, note });
      if (side === 'support') support += w; else drain += w;
    });
  }
  const net = support - drain;
  const total = support + drain || 1;
  const index = Math.round((net / total) * 100);
  const monthStems = HIDDEN_STEMS[pillars[1]?.[1] ?? ''] ?? [];
  const monthHasSupport = monthStems.some((s) => (TEN_GOD_SIDE[tenGodOf(dayStem, s)] ?? 'drain') === 'support');
  // 「得令」查 STEM_LU / YANG_REN(传统取法)，不用十二长生逆行表推的临官/帝旺：
  // 乙生寅、丁生午这类阴干盘用逆行表会得出相反的结论。
  const luRenMonth = luRenOf(dayStem, pillars[1]?.[1] ?? '');
  const inSeasonStrong = luRenMonth !== null;
  const mb = indexOfBranch(pillars[1]?.[1] ?? '');
  const clashedBy = mb < 0 ? [] : [0, 2, 3].filter((k) => isChongPair(mb, indexOfBranch(pillars[k]?.[1] ?? '')));

  const inSeason = inSeasonStrong && clashedBy.length === 0;
  if (monthHasSupport && clashedBy.length > 0) {
    detail.push({ pillar: '月令', stem: pillars[1][1], tenGod: '冲', side: 'drain', weight: 0, note: '月支被' + clashedBy.map((k) => names[k] + '支').join('、') + '冲开，当令之力受损(破令)' });
  }

  const label = index >= 25 ? '身强' : index <= -25 ? '身弱' : index > 0 ? '中和偏旺' : '中和偏弱';
  /* 三个显示值各自取整后，会出现「净分 ≠ 助身 − 克泄耗」(如 34.8 − 79.2 = −44.4 却显示 −44.5)。
     提示词要求 AI 同时引用这三项，对不上就会被当成算错。故以取整后的两项为准重算净分。 */
  const shownSupport = Math.round(support * 10) / 10;
  const shownDrain = Math.round(drain * 10) / 10;
  return { support: shownSupport, drain: shownDrain, net: Math.round((shownSupport - shownDrain) * 10) / 10, index, label, inSeason, monthHasSupport, detail };
}

export interface PatternInfo {
  name: string; tenGod: string; basis: string; special?: string;
}

/** 取格(《子平真诠》通行法)：月令为主、透干优先、本气定名；建禄/阳刃别取。 */
/* ---- 调候(《穷通宝鉴》日主×月令季节的寒暖燥湿) --------------------------------
 * 目的：把提示词里空泛的一句「以调候为主」变成引擎按季节算定的确定事实，供模型作为
 * 喜忌的「辅助判据」(不是硬结论)。口径刻意保守，分两层：
 *   · 季节与「调候方向」是古今公认的部分(冬寒→需火暖、夏热→需水润、春秋→平和非急)，
 *     作为可依赖的硬信号注入；
 *   · 逐日的用神天干，两份公开表(逐月细表 / 按季归并表)在「逐月」粒度上互有出入
 *     (如甲木申月：一说庚丁壬、一说主庚次丙)，故只取「按季归并」一份、原样转录，
 *     并一律明标「参考·须与格局扶抑合参」，不得当作唯一结论。见 TIAOHOU_REF_BY_SEASON。
 * 返回值整串为中文，键名 tiaohouFacts 只是 natal 的字段名(与 patternFacts 同类，非正文)。
 * -------------------------------------------------------------------------- */
/** 月支→季节(寅卯辰春 / 巳午未夏 / 申酉戌秋 / 亥子丑冬)。 */
const SEASON_OF_BRANCH: Record<string, string> = {
  寅: '春', 卯: '春', 辰: '春', 巳: '夏', 午: '夏', 未: '夏', 申: '秋', 酉: '秋', 戌: '秋', 亥: '冬', 子: '冬', 丑: '冬',
};
/** 季节气候与调候方向：冬火夏水为通义；春秋气候平和，调候非急。 */
const SEASON_CLIMATE: Record<string, { climate: string; need: string }> = {
  春: { climate: '温而余寒未尽', need: '调候非急(以扶抑格局为主)' },
  夏: { climate: '炎热燥土', need: '调候以水为急' },
  秋: { climate: '凉而偏燥', need: '调候非急(以扶抑格局为主)' },
  冬: { climate: '严寒', need: '调候以火为急' },
};
/** 穷通宝鉴「按季归并」主用神(佐)——原样转录一份自洽来源，逐月细表与此有分歧处不取。 */
const TIAOHOU_REF_BY_SEASON: Record<string, Record<string, string>> = {
  甲: { 春: '丙(佐癸)', 夏: '癸(佐庚)', 秋: '庚(佐丙)', 冬: '丙(佐戊)' },
  乙: { 春: '丙(佐癸)', 夏: '专癸', 秋: '丙(佐庚)', 冬: '丙丁(佐戊)' },
  丙: { 春: '壬(佐庚)', 夏: '壬(佐庚)', 秋: '甲(佐壬)', 冬: '甲(佐戊)' },
  丁: { 春: '甲(佐庚)', 夏: '壬(佐庚)', 秋: '甲(佐丙)', 冬: '甲' },
  戊: { 春: '丙(佐甲)', 夏: '癸(佐丙)', 秋: '丙(佐癸)', 冬: '丙(佐甲)' },
  己: { 春: '丙(佐癸)', 夏: '癸(佐丙)', 秋: '丙癸并重', 冬: '丙(佐戊)' },
  庚: { 春: '丙(佐甲)', 夏: '壬', 秋: '丁丙', 冬: '丙丁' },
  辛: { 春: '壬(佐丙)', 夏: '壬癸', 秋: '壬(佐丙)', 冬: '丙(佐壬)' },
  壬: { 春: '戊(佐丙)', 夏: '庚(佐壬癸)', 秋: '戊(佐甲)', 冬: '戊(佐丙)' },
  癸: { 春: '辛(佐丙)', 夏: '庚辛(佐壬癸)', 秋: '辛(佐丙)', 冬: '丙(佐戊)' },
};
/** 引擎按日主与月令季节算定的「调候」事实(中文字符串)。缺日主或月支时返回空串。 */
export function deriveTiaohou(dayStem: string, monthBranch: string): string {
  const season = SEASON_OF_BRANCH[monthBranch];
  const refRow = TIAOHOU_REF_BY_SEASON[dayStem];
  if (!season || !refRow) return '';
  const cl = SEASON_CLIMATE[season];
  const ref = refRow[season] ?? '';
  return season + '·' + cl.climate + '·' + cl.need
    + '·《穷通宝鉴》按季归并用神参考：' + ref
    + '〔季节归并之论，两源或有出入，仅供参考，须与格局扶抑合参〕';
}

export function derivePattern(pillars: string[], dayStem: string): PatternInfo {
  const monthGz = pillars[1] ?? '';
  const monthBranch = monthGz[1] ?? '';
  const stems = HIDDEN_STEMS[monthBranch] ?? [];
  const isBiJie = (t: string) => t === '比肩' || t === '劫财';
  const layerName = (k: number) => (k === 0 ? '本气' : k === 1 ? '中气' : '余气');
  // 透出的天干：年/月/时三干(日干恒为「日主」，不参与取格)
  const outer: Array<{ stem: string; tenGod: string; where: string }> = [
    { stem: pillars[0]?.[0] ?? '', where: '年干' },
    { stem: pillars[1]?.[0] ?? '', where: '月干' },
    { stem: pillars[3]?.[0] ?? '', where: '时干' },
  ].map((o) => ({ ...o, tenGod: o.stem ? tenGodOf(dayStem, o.stem) : '' })).filter((o) => o.tenGod && !isBiJie(o.tenGod));
  // ① 月支对日主的十二长生才是「月令」正身：临官＝建禄、帝旺＝阳刃。
  //    不能拿月干的十神当"月令本气"——癸巳月的癸是甲木正印，旧代码据此参与取格，
  //    把甲日主生巳月误判成建禄格(巳中本气丁火实为伤官，应为伤官格)。
  // 建禄/阳刃一律查 STEM_LU / YANG_REN(传统取法)，不用十二长生逆行表推的「临官/帝旺」——
  // 那套排法会把乙生寅月说成帝旺、把丁生午月说成临官，与古籍命例相反。
  const monthStage = longevityOf(dayStem, monthBranch);
  const luRen = luRenOf(dayStem, monthBranch);
  const jianLu = luRen === '建禄';
  const yangRen = luRen === '阳刃';
  // 措辞按实际状态生成：巳对甲是「病」地，绝不能写成「临官之地(建禄)」——
  // 那正是把用户盘说成「建筑禄格」的来源。
  // 阴干无刃：长生表把「乙生寅」这类标成帝旺，但古法不作阳刃论，措辞随 tag 走。
  const luText = yangRen ? '禄前一位为阳刃(惟五阳有之)' : jianLu ? '月建逢禄堂(建禄)' : monthStage + '之地(非禄刃)';
  const luRenHead = '月令' + monthGz + '于日主' + dayStem + '：' + luText;
  const favorOf = (tg: string) => (tg === '正官' ? '印绶护之、忌伤官见官'
    : tg === '七杀' ? '食伤制之、忌财党杀'
    : tg.includes('财') ? '官星护财、忌比劫分夺'
    : '财星流通、忌枭印夺食');
  // ①b 月令本气即比劫(建禄/阳刃)：《子平真诠》「建禄帮身，另求用神」——
  //     先按月令所藏中余气透干者别取，其次取他柱财官，全无才直以建禄/阳刃论。
  //     阴干古法无刃(乙生寅虽处帝旺仍以建禄论)，故 tag 只在阳干帝旺时作阳刃。
  // 注意：判据是「月支本气与日主同类」，不是「月支处于临官/帝旺」。二者通常同义，
  // 但阴干逆行会让它们分叉(乙生寅月：寅本气甲为乙之劫财，而长生表把寅说成乙之帝旺)，
  // 若只看十二长生就会把「寅中透出的丙火伤官」误当作建禄别取。
  if (jianLu || yangRen) {
    const mainGod = tenGodOf(dayStem, stems[0] ?? '');
    if (isBiJie(mainGod)) {
      const tag = yangRen ? '阳刃' : '建禄';
      const lead = luRenHead + '(本气' + (stems[0] ?? '') + '即' + mainGod + ')';
      for (let si = 1; si < stems.length; si++) {
        const t2 = tenGodOf(dayStem, stems[si]);
        if (isBiJie(t2)) continue;
        const hit2 = outer.find((o) => o.stem === stems[si]);
        if (hit2) return { name: tag + '用' + t2, tenGod: t2, basis: lead + '，另见所藏' + stems[si] + '(' + layerName(si) + ')' + t2 + '于' + hit2.where + '透出，别取为格(喜' + favorOf(t2) + ')' };
      }
      const ya = outer.find((o) => o.tenGod === '正官' || o.tenGod === '七杀');
      const cs = ['正财', '偏财', '食神', '伤官'].map((x) => outer.find((o) => o.tenGod === x)).find(Boolean);
      const use = ya ?? cs;
      if (use) return { name: tag + '用' + use.tenGod, tenGod: use.tenGod, basis: lead + '，月令所藏皆不透；' + use.where + use.stem + '透出' + use.tenGod + '，别取为格(喜' + favorOf(use.tenGod) + ')' };
      return { name: tag + '格', tenGod: mainGod, basis: lead + '，四柱更无官杀财食可取，直以' + tag + '论，喜官杀制身、忌再逢比劫' };
    }
  }
  // ② 常规取格：月令所藏之神透出天干者，按 本气→中气→余气 次序取(《子平真诠》)。
  for (let si = 0; si < stems.length; si++) {
    const tg = tenGodOf(dayStem, stems[si]);
    if (isBiJie(tg)) continue;
    const hit = outer.find((o) => o.stem === stems[si]);
    if (!hit) continue;
    if (jianLu || yangRen) {
      const tag = yangRen ? '阳刃' : '建禄';
      return { name: tag + '用' + tg, tenGod: tg, basis: luRenHead + '，比劫当令不以为格；月令所藏' + stems[si] + '(' + layerName(si) + ')' + tg + '于' + hit.where + '透出，别取为格(喜' + favorOf(tg) + ')' };
    }
    return { name: tg + '格', tenGod: tg, basis: '月令' + monthGz + '藏' + stems[si] + '(' + layerName(si) + ')' + tg + '于' + hit.where + '透出，取为格' };
  }
  // ③ 月令所藏皆不透：建禄/阳刃另在他柱找财官可倚，否则直以建禄/阳刃论。
  if (jianLu || yangRen) {
    const tag = yangRen ? '阳刃' : '建禄';
    const ya = outer.find((o) => o.tenGod === '正官' || o.tenGod === '七杀');
    const cs = ['正财', '偏财', '食神', '伤官'].map((t) => outer.find((o) => o.tenGod === t)).find(Boolean);
    const use = ya ?? cs;
    if (use) return { name: tag + '用' + use.tenGod, tenGod: use.tenGod, basis: luRenHead + '，月令所藏皆不透；' + use.where + use.stem + '透出' + use.tenGod + '，权取为格(须另择用神)' };
    return { name: tag + '格', tenGod: '比劫', basis: luRenHead + '，四柱更无官杀财食可取，直以' + tag + '论，喜官杀制身' };
  }
  // ④ 均不透 → 直取月令本气。
  const main = stems[0] ?? '';
  const tg2 = tenGodOf(dayStem, main);
  return { name: tg2 + '格', tenGod: tg2, basis: '月令' + monthGz + '本气' + main + '未透天干，直取本气' + tg2 + '为格' };
}
/** 变格候选提示：只给线索，最终由 AI 复核(但必须写明是否采用)。
 *  专旺古法不许官杀(克我者)混局，旧实现只看总分+得令、不查官杀，14/110 例把带庚辛
 *  透干的盘提示成专旺候选。从格则要求四柱连一点印比之根都没有 —— 用评分明细判，
 *  比旧的「月支藏干无印比」严格(那会把年时两处印比漏掉，实测滥发 1782 例)。 */
export function specialPatternHint(score: StrengthScore, pillars: string[] = [], dayStem = ''): string | undefined {
  const hasSupportRoot = (score.detail ?? []).some((d) => d.side === 'support' && d.weight > 0);
  const officerCount = (pillars.length === 4 && dayStem)
    ? pillars.flatMap((p, i) => (i === 2 ? [p[0]] : [p[0], ...(HIDDEN_STEMS[p[1]] ?? [])]))
      .map((s) => tenGodOf(dayStem, s))
      .filter((t) => t === '正官' || t === '七杀').length
    : 0;
  if (score.index >= 75 && score.inSeason && officerCount === 0) return '专旺候选：日主极旺成势(指数' + score.index + ')，满盘无官杀，若亦无有力财食则按专旺顺势取用';
  if (score.index <= -75 && !hasSupportRoot) return '从格候选：日主极弱无根(指数' + score.index + ')，四柱明细中不见有力印比，若确皆虚浮受制则按从格顺势取用';
  return undefined;
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

/* ------------------------------------------------ 大运方向(阳男阴女顺、阴男阳女逆) */
/** 只判定顺排/逆排：这是大运干支排列唯一需要的信息。年龄/日期起运推算已移除。 */
function fortuneDirection(yearStem: string, gender: Gender): boolean {
  return YANG.includes(yearStem) === (gender === 'male');
}


export const SHEN_SHA_RULE_VERSION = 'classic-v2-local';

/** 神煞结果：全部来自本地规则引擎 computeShenSha(经典干支起法)，不再调用历法库的择日神煞。
 *  旧版还附带 lunar-javascript 的 daySha/dayTianShen/timeTianShen —— 那是「择日」用的每日宜忌，
 *  与命局无关，界面不显示、AI 提示词也不用(compactShenSha 只取 items/吉/凶)，属于纯浪费的计算。 */
function buildShenShaResult(pillars: string[]): NonAiChart['shenSha'] {
  const items = computeShenSha(pillars);
  const unique = (list: ShenShaItem[]) => [...new Set(list.map((item) => item.name))];
  return {
    auspicious: unique(items.filter((item) => item.category === '吉')),
    inauspicious: unique(items.filter((item) => item.category === '凶')),
    items,
    ruleVersion: SHEN_SHA_RULE_VERSION,
    source: 'classic stem-branch shensha (local rule engine)',
  };
}

/* ================================================================ 主入口 */

/* ---------------- 袁天罡称骨(骨重表 · ruleVersion chenggu-v1，以通行古本为准) ---------------- */
// 年柱骨重(按六十甲子序数，单位:两)。称骨按农历年/月/日/时干支。
const CHENGGU_YEAR = [1.2,0.9,0.6,0.7,1.2,0.5,0.9,0.8,0.7,0.8,1.5,0.9,1.6,0.8,0.8,1.9,1.2,0.6,0.8,0.7,0.5,1.5,0.6,1.6,1.5,0.7,0.9,1.2,1,0.7,1.5,0.6,0.5,1.4,1.4,0.9,0.7,0.7,0.9,1.2,0.8,0.7,1.3,0.5,1.4,0.5,0.9,1.7,0.5,0.7,1.2,0.8,0.8,0.6,1.9,0.6,0.8,1.6,1,0.6];
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

/** 由公历出生日期时刻正向排出四柱（首页「按生日自动排盘」）。
 *  年/月/日三柱取该日正午(12:30)的干支，与 calculateNonAi 定位出生日期所用口径一致，
 *  避开子夜换日歧义；时柱不用历法库 getTime()——实测它按「早子时换日」推次日子时，
 *  而 calculateNonAi 的时柱校验按当日日干五鼠遁(晚子时不换日)，两者在 23 点后冲突会
 *  让自动排出的命盘保存即报错。故时柱在此复用五鼠遁，保证产出必过本引擎校验。
 *  入参应为「定好的朴素日期时刻」；若开真太阳时，先过 applyTrueSolar 修正再传进来。 */
export function computePillarsFromDate(
  input: { year: number; month: number; day: number; hour: number; minute?: number },
): Pick<BaziRecord, 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'> {
  const atNoon = Solar.fromYmdHms(input.year, input.month, input.day, 12, 30, 0).getLunar().getEightChar();
  const yearPillar = atNoon.getYear();
  const monthPillar = atNoon.getMonth();
  const dayPillar = atNoon.getDay();
  const hourBranch = BRANCHES[Math.floor(((input.hour + 1) % 24) / 2)];
  const startStem = mod(indexOfStem(dayPillar[0]) % 5 * 2, 10);
  const hourPillar = STEMS[mod(startStem + indexOfBranch(hourBranch), 10)] + hourBranch;
  return { yearPillar, monthPillar, dayPillar, hourPillar };
}

/** 均时差(Equation of Time)：真太阳时 − 平太阳时，单位分钟。Reed/Spencer 一阶近似，
 *  全年误差 < 约 0.5 分钟，只用于定十二时辰(每 2 小时一档)绰绰有余；N 为一年中的第几天。
 *  这是公开天文近似式的确定性计算，不接任何历法库/网络。 */
export function equationOfTimeMinutes(year: number, month: number, day: number): number {
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86400000);
  const b = (2 * Math.PI * (dayOfYear - 81)) / 364;
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

/** 真太阳时修正：把「北京时间」朴素钟点换算为出生地真太阳时。
 *  修正量 = (经度 − 120°东)×4 分钟(每 1°=4 分，东经 >120 为正、地方更快) + 均时差。
 *  结果按朴素日历回读(Date.UTC 进出，不掺系统时区)，可能跨时辰、甚至跨子夜改公历日；
 *  调用方拿修正后的 {year,month,day,hour,minute} 再交给 computePillarsFromDate / 存 birthYear、birthMonth。 */
export function applyTrueSolar(
  naive: { year: number; month: number; day: number; hour: number; minute: number },
  longitude: number,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const offsetMin = (longitude - 120) * 4 + equationOfTimeMinutes(naive.year, naive.month, naive.day);
  const shifted = new Date(Date.UTC(naive.year, naive.month - 1, naive.day, naive.hour, naive.minute) + Math.round(offsetMin * 60000));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

/** 农历(夏历)→公历：month 取 1–12，闰月传负值(如 -2=闰二月)。
 *  非法农历(月/日超出、该年无此闰月、年份越界)由 lunar-javascript 抛错，交由调用方兜中文提示；
 *  这里不吞异常——静默回退会把错误日期排成看似正常的命盘。转换后请再走 applyTrueSolar / computePillarsFromDate。 */
export function lunarToSolar(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const solar = Lunar.fromYmd(year, month, day).getSolar();
  return { year: solar.getYear(), month: solar.getMonth(), day: solar.getDay() };
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
  // 由「公历年月 + 四柱」定位具体出生日期(需要它才能取农历/节气相关事实)。
  // 不能直接用 Solar.fromBaZi(...) 的结果：它只返回 1900 年以来的**第一个**匹配日，
  // 且要求年柱与公历年份同侧立春 —— 立春前(约 1/4~2/3)出生的人年柱属上一干支年，
  // 旧实现在那种情况下永远找不到日期，排盘直接抛错(实测：1~3 月内每天必现)。
  // 改为在用户填写的那个月里逐日扫描、四柱全等才算命中：结果确定、无歧义、不依赖起点年。
  // 定位方法：在该月逐日取正午，比对「年/月/日」三柱 —— 三柱全等即可唯一确定出生日；
  // 时柱不能参与比对(它由日干五鼠遁推出，换一天就不同)，改为事后校验其地支与用户填的时支一致。
  const noonOf = (solar: ReturnType<typeof Solar.fromYmdHms>) => solar.getLunar().getEightChar();
  const sameThreePillars = (eight: ReturnType<typeof noonOf>) =>
    eight.getYear() === input.yearPillar && eight.getMonth() === input.monthPillar && eight.getDay() === input.dayPillar;
  const scanRange = (fromJD: number, toJD: number) => {
    for (let jd = fromJD; jd <= toJD; jd += 1) {
      const solar = Solar.fromJulianDay(jd);
      const atNoon = Solar.fromYmdHms(solar.getYear(), solar.getMonth(), solar.getDay(), 12, 30, 0);
      if (sameThreePillars(noonOf(atNoon))) return atNoon;
    }
    return undefined;
  };
  const firstOf = Solar.fromYmdHms(input.birthYear, input.birthMonth, 1, 12, 30, 0);
  const lastDay = new Date(input.birthYear, input.birthMonth, 0).getDate();
  let candidate = scanRange(firstOf.getJulianDay(), firstOf.getJulianDay() + lastDay - 1);
  if (!candidate) {
    // 立春/交节会让「干支年月」与「公历月」错位：向两侧各扩 20 天再找一次。
    candidate = scanRange(firstOf.getJulianDay() - 20, firstOf.getJulianDay() + lastDay + 19);
  }
  if (!candidate) throw new Error('该月找不到与这三部命盘对应的日期，请核对四柱或出生日期');
  // 时柱校验：日干定后，时干按五鼠遁唯一确定 —— 甲己日起甲子时，逐支 +1。
  {
    const dayStem = candidate.getLunar().getEightChar().getDayGan();
    const startStem = mod(indexOfStem(dayStem) % 5 * 2, 10); // 甲己→甲(0) 乙庚→丙(2) 丙辛→戊(4) 丁壬→庚(6) 戊癸→壬(8)
    const expected = STEMS[mod(startStem + indexOfBranch(input.hourPillar[1]), 10)] + input.hourPillar[1];
    if (expected !== input.hourPillar) {
      throw new Error('时柱与出生日不合：' + dayStem + ' 日的' + input.hourPillar[1] + '时应为「' + expected + '」，请核对四柱');
    }
  }
  const lunar = candidate.getLunar();
  const eight = lunar.getEightChar();
  const day = eight.getDayGan();
  const forward = fortuneDirection(input.yearPillar[0], gender);
  const chenggu = calculateChenggu(lunar.getYearInGanZhiExact(), lunar.getMonth(), lunar.getDay(), input.hourPillar[1]);
  /* 起运：以定位到的出生日(正午近似)推算。产品没有「出生时刻」这一栏，所以这里的
     日期准、时辰不准 —— 距节令不足一天时折成月数会偏，但比起旧实现「压根不做起运」
     已是质的改进；缺字段或库异常时返回 null 走兜底。 */
  const luckStart = computeLuckStart(candidate, gender);

  // 五行计数：口径见 countElements(单一真源，供老库回填与聊天/证据复用)。
  const { elements: counts, elementRatio } = countElements(pillars);

  const natalItems: Node[] = pillars.map((value, index) => ({ value, layer: 'natal' as const, name: String(index) }));
  const relationships = natalFacts(pillars);
  const relationshipDetails = pairHits(natalItems);

  // 藏干/纳音/十二长生：改为本地查表(纯代数，不依赖历法)，逐支扫描与 lunar-javascript 比对一致。
  // 十神一律走 tenGodOf(纯代数)：库里的 shiShenZhi 在与日主同干时标「比肩」，而我们的 tenGodOf 旧版会标「日主」——已修正口径。
  const hiddenStems = pillars.map((pillar) => HIDDEN_STEMS[pillar[1]] ?? []);
  const tenGodDetails = {
    heavenly: pillars.map((pillar, pi) => tenGodOf(day, pillar[0], pi === 2)),
    hidden: hiddenStems.map((stemsInBranch) => stemsInBranch.map((stem, si) => ({
      stem,
      tenGod: tenGodOf(day, stem),
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

  // 大运：月柱序数沿顺逆每次 ±1(十年一柱)，起点＝起运那一年的干支年。
  // 旧实现把第 0 步对齐到「当前所处的公历十年」，于是干支↔年份的对应随时间漂移，
  // 任何人看到的「丁卯运 2020-2029」都不是这个人的丁卯运。现按经典起运排定。
  const monthIndex = gzIndex(input.monthPillar);
  const step = forward ? 1 : -1;
  const luckYear = luckStart ? ganzhiYearOf(luckStart.date) : undefined;
  // 兜底：万一取不到起运(库异常)，退回旧的十年边界锚点，至少不丢时段任务。
  const firstStartYear = luckYear ?? Math.floor(currentYear / 10) * 10;
  const greatFortunes = Array.from({ length: GREAT }, (_, k) => {
    const ganZhi = gzAt(monthIndex + step * (k + 1));
    const startYear = firstStartYear + k * 10;
    const participants = [...natalItems, { value: ganZhi, layer: 'great-fortune' as const, name: String(startYear) }];
    return { ganZhi, startYear, endYear: startYear + 9, tenGod: tenGodOf(day, ganZhi[0]), relationships: fortuneFacts(ganZhi, pillars), relationshipDetails: pairHits(participants) };
  });

  // 旺衰评分只算一次，供 patternFacts 与返回对象共用
  const strengthScore = scoreStrength(pillars, day);
  /* 时柱必须回显用户填的那一柱。eight.getTime() 是按「正午近似」的出生时刻推出来的，
     而定位出生日期时只用年/月/日三柱比对(见上文 scanRange)，所以库给的时间支几乎必然是午，
     不是用户填的未/申/…。旧实现直接输出 eight.getTime()：实测输入癸未、界面显示壬午 ——
     藏干、十神、纳音、长生全都按 pillars(用户输入)算，唯独四柱这一行按库算，两拨数字自相矛盾。 */
  return {
    pillars: { year: pillars[0], month: pillars[1], day: pillars[2], hour: pillars[3] },
    solarDate: candidate.toYmd(),
    lunarDate: lunar.toString(),
    zodiac: lunar.getYearShengXiao(),
    elements: counts,
    elementRatio,
    elementRuleVersion: ELEMENT_RULE_VERSION,
    hiddenStems,
    tenGods: tenGodDetails.heavenly,
    naYin: pillars.map(naYinOf),
    dayMaster: day,

    currentTime: now,
    forecastRange: annualFortunes.map((item) => item.year),
    relationships,
    relationshipDetails,

    tenGodDetails,
    greatFortunes,
    luckStart,
    annualFortunes,
    monthlyFortunes,
    // 十二长生：日主对年/月/日三支。时支不列 —— 传统论「生旺死绝」只看年月日三宫，
    // 时下另论(看通根、看归宿)；旧实现把时支也塞进来，UI 上四条并排看不出哪条是时，
    // 读者会误以为「养」是日主坐支的状态(实测乙日主：沐浴·绝·养 里那个养其实是未时)。
    twelveLongevity: pillars.slice(0, 3).map((pillar) => longevityOf(day, pillar[1])),
    // 旺衰与格局：引擎算定的确定结论，提示词要求 AI 沿用不重判
    strengthScore: strengthScore,
    patternFacts: Object.assign({}, derivePattern(pillars, day), { special: specialPatternHint(strengthScore, pillars, day) }),
    // 调候：按日主与月令季节算定的「辅助判据」(非硬结论)，供模型判喜忌时参考寒暖燥湿。
    tiaohouFacts: deriveTiaohou(day, pillars[1]?.[1] ?? ''),
    shenSha: buildShenShaResult(pillars),
    shenShaRuleVersion: SHEN_SHA_RULE_VERSION,
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
