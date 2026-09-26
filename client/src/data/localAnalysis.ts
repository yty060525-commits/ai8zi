/* =============================================================================
 * 本地离线批断引擎（「第四路」：不依赖任何云端服务、不花额度、确定性、可复算）
 *
 * 定位：把 nonAiCalculator 已算定的「命盘事实」(日主/旺衰评分/格局依据/十神/五行
 * 偏枯/调候/神煞/地支刑冲合害/大运流年) 用断语库 + 规则命中，拼成与云端批断「同构、
 * 同口吻、同事实密度」的结构化中文正文。它替大模型做「机械可枚举」那部分——
 * 大模型在本命批断里其实也不外乎把这些确定性事实排成编号白话，故本地能对齐。
 * 「多信号权衡、因人而异的连贯细断、多轮问答」仍是云端强项，本地正文末尾如实标注。
 *
 * 口径来源：小节标题(【身强身弱与喜忌】【健康】【事业】【财运】【爱情】【刑冲克害批注】
 * 【总评/行为建议】)、每节「1. 2. 3.」编号、以及引用旺衰得分/格局依据/神煞/刑冲的
 * 写法，均取自真实云端样本(导出库)以尽量贴近；喜忌仍按「扶抑」确定性口径给，调候只作
 * 辅助参考句，与 nonAiCalculator「调候=辅助判据非硬喜用」一致。
 *
 * 约束：正文一律中文、零拉丁字母；断不到的字段就跳过对应句，绝不为凑篇幅编造；
 * explanation 复用现有【主题】+编号点的渲染/复制管线(splitSections/PointsView)，零改渲染层。
 * ========================================================================== */
import { STEMS, BRANCHES, ELEMENTS, stemElementIndex, HIDDEN_STEMS } from '../features/chart/elements';
import { ELEMENT_GUIDES, primaryElement, type ElementKey } from './elementKnowledge';
import { canBuildLocalAnalysis } from './localSystem';
import type { BaziAIAnalysis, BaziAnalysisTask, BaziRecord, FortunePeriod, NonAiChart, RelationshipDetail } from '../types/domain';

/* v3：爱情引动判据由「只看本期天干十神」扩成三条途径（天干／地支本气／配偶宫逢冲合），
   「未受特别引动」的覆盖面从约 80% 降到约 39%。只改断语措辞与判据，不改喜忌五行结论。 */
export const LOCAL_ANALYSIS_ENGINE_VERSION = 'local-rules-v5';

/** 引擎可复算、无需外部输入的最小事实来源；缺排盘数据时上层据此禁用按钮。 */
/* 判据已搬到 data/localSystem.ts（见那里的 canBuildLocalAnalysis）：调用方在页面加载阶段
   就该能问到它，不该为此把本模块整个规则引擎拖进首屏包。 */

export interface LocalAnalysis {
  pattern: string;
  strength: string;
  usefulElements: string[];
  avoidElements: string[];
  explanation: string;      // 【主题】+「N.」编号点的中文长文，直接喂 PointsView
  engineVersion: string;
  generatedAt: string;
}

// —— 十神五行关系：以日主在 ELEMENTS(木火土金水) 的下标为基准，模 5 位移 ——
const rel = (dayIdx: number, delta: number) => ELEMENTS[(dayIdx + delta) % 5];
// 比劫=同我(+0) 食伤=我生(+1) 财=我克(+2) 官杀=克我(+3) 印=生我(+4)
const GROUP_OFFSET: Record<string, number> = { 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 };
/** 十神 → 五行关系分组。 */
const TEN_GOD_GROUP: Record<string, string> = {
  比肩: '比劫', 劫财: '比劫', 食神: '食伤', 伤官: '食伤', 偏财: '财', 正财: '财',
  七杀: '官杀', 正官: '官杀', 偏印: '印', 正印: '印',
};
/** 分组 → 该组占的两个五行。⚠ 一个组含**一对**十神（正财/偏财、正官/七杀），
 *  这一对只差阴阳、五行相差一位，故组恒占**两个相邻**五行：财 = +2/+3、官杀 = +3/+4。 */
const GROUP_FIRST_OFFSET: Record<string, number> = { 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 };
/** 某柱天干相对日主的十神(纯代数，与引擎 tenGodOf 同一口径)：用于给**地支本气**定十神。 */
const mod5 = (n: number) => ((n % 5) + 5) % 5;
function stemGodOf(dayStem: string, otherStem: string): string {
  const d = mod5(((STEMS.indexOf(otherStem) / 2) | 0) - ((STEMS.indexOf(dayStem) / 2) | 0));
  const same = (STEMS.indexOf(dayStem) % 2) === (STEMS.indexOf(otherStem) % 2);
  return d === 0 ? (same ? '比肩' : '劫财')
    : d === 1 ? (same ? '食神' : '伤官')
      : d === 2 ? (same ? '偏财' : '正财')
        : d === 3 ? (same ? '七杀' : '正官')
          : (same ? '偏印' : '正印');
}
/** 一组十神（财/官杀…）对应的两个五行：由日主下标 + 该组首偏移推出。 */
export const groupElements = (dayIdx: number, group: string): string[] => {
  const first = GROUP_FIRST_OFFSET[group];
  return first === undefined ? [] : [rel(dayIdx, first), rel(dayIdx, first + 1)];
};

/** 数字 → 中文读法(含负号与一位小数)，用于把旺衰评分写成「二十八点八」这类白话。 */
const CN_DIGITS = '零一二三四五六七八九';
/** 中文读数 → 数字(支持「八」「十」「八十」「九十点五」)。 */
export function cnToNum(s: string): number | null {
  const m = /^([零一二三四五六七八九]?十)?([零一二三四五六七八九])?(?:点([零一二三四五六七八九]))?$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const tens = m[1] === undefined ? 0 : m[1] === '十' ? 10 : CN_DIGITS.indexOf(m[1][0]) * 10;
  return tens + (m[2] === undefined ? 0 : CN_DIGITS.indexOf(m[2])) + (m[3] === undefined ? 0 : CN_DIGITS.indexOf(m[3]) / 10);
}
function cnNum(value: number): string {
  const neg = value < 0;
  const abs = Math.abs(value);
  const intPart = Math.floor(abs);
  const decPart = Math.round((abs - intPart) * 10);
  const intToCn = (n: number): string => {
    if (n < 10) return CN_DIGITS[n];
    if (n < 100) { const t = Math.floor(n / 10), o = n % 10; return (t === 1 ? '十' : CN_DIGITS[t] + '十') + (o ? CN_DIGITS[o] : ''); }
    if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return CN_DIGITS[h] + '百' + (r ? (r < 10 ? '零' : '') + intToCn(r) : ''); }
    return String(n);
  };
  const body = intToCn(intPart) + (decPart ? '点' + CN_DIGITS[decPart] : '');
  return (neg ? '负' : '') + body;
}

// —— 断语库（命理通行义，非某模型口吻） ——
const STEM_IMAGERY: Record<string, string> = {
  甲: '甲为参天乔木，质直向上、有担当、好面子，认定的事不轻易低头。',
  乙: '乙为藤萝花草，柔韧善借势、随和而绵里藏针，遇强能绕、遇缘能附。',
  丙: '丙为太阳之火，光明显露、热情坦荡、喜被看见，藏不住话也藏不住善。',
  丁: '丁为灯烛之火，内秀细腻、耐性照人，于暗处能明，敏感而重情。',
  戊: '戊为城墙厚土，沉稳守信、包容慢热，一旦认了便极可靠，不喜变动。',
  己: '己为田园湿土，细致能藏、务实多思，肯养人却也易把事闷在心里。',
  庚: '庚为刀剑顽金，刚断重义、直言易折人亦自折，宜磨不宜折。',
  辛: '辛为珠玉之金，清贵爱美、外柔内刚，感受敏锐，贵在自珍。',
  壬: '壬为江河大水，聪慧善谋、志在四方、流动不拘，机变多而心也宽。',
  癸: '癸为雨露之水，温润善解、内敛多智，润物无声而心思最密。',
};
const TEN_GOD_SEX: Record<string, string> = {
  比肩: '自主心强、同辈缘厚、凡事要自己拿主意，合伙共事宜先小人后君子。',
  劫财: '行动力强、出手慷慨，然易破财、易因合伙或亲友起纷扰，钱上要有边界。',
  食神: '有口福才艺、性温和、喜创作与享受，是能把自己日子过出滋味的人。',
  伤官: '才气外露、锋芒不服管，宜以技艺、表达、专业立身，忌恃才顶撞规矩。',
  偏财: '善经营、人缘广、财来财去格局大，活络却也需防大而化之。',
  正财: '务实勤俭、重稳定、按部就班聚财，一分耕耘一分收获最宜你。',
  七杀: '有魄力、抗压、进取带压力，宜开拓、竞争、担硬责任的岗位。',
  正官: '端正守纪、重名声与分寸，宜公职、管理、讲规矩的体系。',
  偏印: '多学多能、思辨孤高，宜专技、研究、医药术数一类的深功夫。',
  正印: '仁慈好学、易得长辈与贵人护，宜文教、学术、名誉之路。',
};
const TEN_GOD_CAREER: Record<string, string> = {
  比肩: '自主经营、与同侪合伙或独立专业', 劫财: '销售、竞争性行业、以人脉开拓',
  食神: '文艺、餐饮、教学、内容创作', 伤官: '技术、设计、演艺、自由专业',
  偏财: '经商、金融、贸易、投资', 正财: '财务、行政、稳定的受薪职',
  七杀: '军警、司法、工程、开拓性管理', 正官: '公职、企管、文书、合规',
  偏印: '研究、医药、技术顾问、术数', 正印: '教育、文化、学术、名誉性职务',
};
const TEN_GOD_PATTERN_NOTE: Record<string, string> = {
  比劫: '此属建禄月刃一类，自立之格，喜官杀裁抑、财星流通；最忌再逢比劫夺财。',
  比肩: '此属建禄一类，自立之格，喜官杀裁抑、财星流通；忌比劫再重。',
  劫财: '气盛而争，喜官杀制约、食伤泄秀生财；忌再助身夺财。',
  食神: '才艺之格，喜身旺泄秀、食神生财；忌枭印夺食、忌财重身弱难任。',
  伤官: '秀气流行之格，喜伤官生财、或伤官配印制衡；忌无制而傲上。',
  偏财: '财星之格，身强任财则富、运转流通；身弱财多反成累，喜帮身。',
  正财: '财星之格，喜身旺能任、财得有库；忌比劫分夺、忌身弱不任财。',
  七杀: '官杀之格，喜有食神制杀或印化杀、忌官杀混杂无根而攻身。',
  正官: '官星之格，喜官印相生、身旺任官；忌伤官见官、忌官星混杂。',
  偏印: '印绶之格，主学问技艺，喜官生印；忌财重破印、忌枭神夺食。',
  正印: '印绶之格，主学业名誉庇荫，喜官星生印；忌财星坏印。',
};
const ELEMENT_HEALTH: Record<string, string> = {
  木: '肝胆、筋骨、情志疏泄', 火: '心与血脉、睡眠、眼目', 土: '脾胃、消化吸收',
  金: '肺与呼吸、皮肤、大肠', 水: '肾与泌尿、耳、骨与内分泌',
};
const ELEMENT_DIRECTION: Record<string, string> = { 木: '东', 火: '南', 土: '中央及西南东北', 金: '西', 水: '北' };
const ELEMENT_COLOR: Record<string, string> = { 木: '青绿', 火: '赤红', 土: '黄', 金: '素白', 水: '黑蓝' };
const SHENSHA_NOTE: Record<string, string> = {
  天乙贵人: '逢困有援、遇难呈祥，一生多贵人扶', 天德贵人: '心地慈善、能化凶为吉', 月德贵人: '处众能和、暗中小人少',
  文昌贵人: '利读书、考试、文字与名声', 驿马: '主奔波迁移、出行变动，动中求财求事', 桃花: '主人缘与异性缘，感情丰沛须专一',
  华盖: '孤高喜静、近艺术玄学宗教，精神世界丰', 将星: '有领导气象、能掌事服众', 羊刃: '刚烈果决，须防血光与性急坏事',
  劫煞: '防劫夺破财、意外之扰', 亡神: '防耗散、心事过重', 空亡: '所临之事易落空、宜务实不宜空想',
  金舆: '宜车马出行、生活体面', 天厨: '有口福、与饮食缘分厚', 寡宿: '内心偶有孤独感，沟通宜主动表达需求',
  孤辰: '性偏独立清冷，六亲缘分宜主动经营', 禄神: '主食禄根基、自立之福，宜惜福稳进', 红艳: '风情魅力旺，感情机会多须守正',
};
const RELATION_TYPE_CN: Record<string, string> = {
  sanHe: '三合', liuHe: '六合', chong: '六冲', xing: '相刑', hai: '六害', po: '六破', ke: '相克',
};
/** 「这类关系一般主什么」的通用含义，只在句尾作补语；主语永远是这一对具体的柱。 */
const RELATION_NOTE: Record<string, string> = {
  三合: '会成一方气势，其五行之力被显著放大，须辨其为喜为忌', 六合: '两柱相绊、情深而牵连，主结缘合作亦主牵制',
  六冲: '主动荡、迁移、拆合，被冲之宫所主之事易生变', 相刑: '主是非、刑伤、纠缠，所临六亲或事务易起摩擦',
  六害: '主暗损、猜忌、消耗，关系表面尚可内里生隙', 六破: '主破损、反复、中途生变', 相克: '力量相互压制，须分谁旺谁衰而定吉凶',
};
/** 本命四柱各自管的宫位(引擎的关系串只给「甲子 与 乙丑」这种柱名，不标宫位)。 */
const PALACE_WORD = ['祖上与早年之门', '父母兄弟与事业门户', '配偶宫兼自身安身之处', '子女与晚年归宿'] as const;

/* 十干禄支/阳刃支的**本地副本**：判「本期之支是日主的禄地还是刃乡」要用它。
   ⚠ 不许改成 `import { STEM_LU, YANG_REN } from '../features/chart/nonAiCalculator'` ——
   nonAiCalculator 顶部要 import lunar-javascript(300KB)，而本模块被 localSystem 那条链拉进
   首屏；引擎里的真值表在 features/chart/elements 侧另有一份同源实现，改传统取法时两处同改
   (luRenTable.test 钉的是引擎那份，下面的句子探针钉的是这份)。 */
const LU_BRANCH: Record<string, string> = { 甲: '寅', 乙: '寅', 丙: '巳', 丁: '巳', 戊: '巳', 己: '巳', 庚: '申', 辛: '申', 壬: '亥', 癸: '亥' };
const REN_BRANCH: Record<string, string> = { 甲: '卯', 丙: '午', 戊: '午', 庚: '酉', 壬: '子' };
/** 本期地支相对日主的根气说法：禄、刃、通根、无根四选一。返回值自带「地支X」主语。 */
function rootNote(dayStem: string, dayElement: string, branch: string): string {
  if (!branch) return '';
  if (branch === LU_BRANCH[dayStem]) return `地支${branch}为日主${dayStem}禄地`;
  if (branch === REN_BRANCH[dayStem]) return `地支${branch}为日主${dayStem}阳刃`;
  const rooted = (HIDDEN_STEMS[branch] ?? []).filter((s) => isStem(s) && ELEMENTS[stemElementIndex(s)] === dayElement);
  return rooted.length ? `地支${branch}中藏${rooted.join('、')}，日主${dayElement}于此通根` : `地支${branch}不助日主${dayStem}${dayElement}`;
}

/* —— 刑冲合害的「逐条批注」：本命与时段共用一套措辞 ——
   上一版每条只写「六冲：己酉 与 癸卯，主动荡、迁移、拆合…」——通用含义占满全句，
   换个盘换个年还是这几个字(实测同一句在流年正文里出现 680 次)。现在每句都先报
   「这一对里哪一柱带了什么」：本期那一柱的十神、被牵动的宫位、会成的那股五行是喜是忌，
   再由这些事实决定后半句怎么说。缺哪一项就少说哪一项，绝不拿通用话补位。 */
/** 从引擎的关系明细里认出「哪一柱是时段柱」：三合成局的 targetPillar 是整组支(寅午戌)，
 *  六合/冲/刑等两侧都是两字柱；sourceLayer 除三合成局外都已被引擎摆成时段在前。 */
function periodSide(rd: RelationshipDetail, periodGz: string): { side: 'period' | 'natal'; periodPillar: string; natalPillar: string } | null {
  const isPeriod = (p: string) => p === periodGz;
  if (isPeriod(rd.sourcePillar)) return { side: 'period', periodPillar: rd.sourcePillar, natalPillar: rd.targetPillar };
  if (isPeriod(rd.targetPillar)) return { side: 'period', periodPillar: rd.targetPillar, natalPillar: rd.sourcePillar };
  // 三合成局：一侧是整组支(寅午戌)，另一侧才是真柱。
  const aTwo = rd.sourcePillar.length === 2 && BRANCHES.includes(rd.sourcePillar[1] ?? '');
  const bTwo = rd.targetPillar.length === 2 && BRANCHES.includes(rd.targetPillar[1] ?? '');
  if (aTwo && !bTwo) return { side: 'natal', periodPillar: rd.sourcePillar, natalPillar: rd.targetPillar };
  if (bTwo && !aTwo) return { side: 'natal', periodPillar: rd.targetPillar, natalPillar: rd.sourcePillar };
  return null;
}
/** 该柱地支落在本命第几宫(年0月1日2时3)；时段柱自己或三合组支返回 -1。 */
function palaceIndexOf(pillar: string, n: NonAiChart): number {
  return [n.pillars?.year, n.pillars?.month, n.pillars?.day, n.pillars?.hour].indexOf(pillar);
}
/** 引擎 status 字段 → 中文限定语。 */
const STATUS_CN: Record<string, string> = { 'half-combination': '半合', 'partial-punishment': '刑而不全', binding: '合绊', complete: '' };
/** 本命内部的关系：两侧都是本命柱，说法改成「谁家的门被谁家的气引动」。 */
function natalRelationSentence(core: Core, typeCn: string, statusCn: string, house: string, onto: string): string {
  const godA = house[0] ? stemGodOf(core.dayStem, house[0]) : '';
  const godB = onto[0] ? stemGodOf(core.dayStem, onto[0]) : '';
  const elA = branchMainElement(house[1] ?? '');
  const idxA = palaceIndexOf(house, core.n), idxB = palaceIndexOf(onto, core.n);
  const side = !elA ? '' : core.useful.includes(elA) ? `${elA}为喜` : core.avoid.includes(elA) ? `${elA}为忌` : '';
  return `${typeCn}${statusCn ? `（${statusCn}）` : ''}：${house}（${PALACE_WORD[idxA] ?? '本宫'}，主${godA}）引动${onto}（${PALACE_WORD[idxB] ?? '本宫'}，主${godB}），${RELATION_NOTE[typeCn] ?? ''}${side ? '；所关' + side : ''}。`;
}
/** 一句关系批注：谁引动谁 + 具体作用 + 该作用在这张盘上落到哪个宫/哪股五行是喜是忌。 */
function relationSentence(core: Core, typeCn: string, statusCn: string, periodPillar: string, natalPillar: string, palaceIdx: number): string {
  const head = `${typeCn}${statusCn ? `（${statusCn}）` : ''}`;
  // 「两字柱」才是真柱；三合成局那侧引擎给的是整组支(如亥卯未)，拿它查藏干/十神全是空话
  const isPillar = (p: string) => p.length === 2 && BRANCHES.includes(p[1] ?? '');
  const bEl = branchMainElement(isPillar(periodPillar) ? periodPillar[1] ?? '' : (periodPillar.match(/[子丑寅卯辰巳午未申酉戌亥]/g) ?? []).slice(-1)[0] ?? '');
  const from = isPillar(periodPillar)
    ? `${periodPillar}携${bEl || '杂气'}而来`
    : `${periodPillar}这一组支汇成${bEl || '一方'}之势`;
  // 本命柱那侧的说法：管的是哪一宫、宫中坐着什么
  const natalIsPillar = isPillar(natalPillar);
  const natalGod = natalIsPillar && natalPillar[0] ? stemGodOf(core.dayStem, natalPillar[0]) : '';
  const houseStem = (HIDDEN_STEMS[natalIsPillar ? natalPillar[1] ?? '' : ''] ?? [])[0] ?? '';
  const houseGod = houseStem ? stemGodOf(core.dayStem, houseStem) : '';
  const palaceTxt = palaceIdx >= 0 ? PALACE_WORD[palaceIdx] : '';
  const onto = palaceIdx === 2 ? `正落在配偶宫${natalPillar[1]}（干${natalGod}、支藏${houseGod}）上`
    : palaceIdx >= 0 ? `牵动${palaceTxt}的${natalPillar}（干${natalGod}、支藏${houseGod}）`
      : natalIsPillar ? `牵动${natalPillar}（干${natalGod}、支藏${houseGod}）`
        : `与本命共成${natalPillar}之局，局中${[...natalPillar].map((b) => `${b}${stemGodOf(core.dayStem, (HIDDEN_STEMS[b] ?? [])[0] ?? '') || '—'}`).join('、')}`;
  // 收尾按「这股气是喜是忌」定，而不是照抄通用含义
  const tone = !bEl ? '' : core.useful.includes(bEl)
    ? `${bEl}属喜用，动中有利可乘`
    : core.avoid.includes(bEl) ? `${bEl}属忌神，动处须防消耗` : '';
  const note = RELATION_NOTE[typeCn.split('、')[0]] ?? '';
  return `${head}：${from}${onto}${note ? '，' + note : ''}${tone ? '；' + tone : ''}。`;
}

const isStem = (s?: string) => !!s && STEMS.includes(s);
const isBranch = (b?: string) => !!b && BRANCHES.includes(b);
const stripParens = (s: string) => s.replace(/[（(][^）)]*[）)]/g, '').trim();
/** 调候串形如「夏·炎热燥土·调候以水为急·《穷通宝鉴》…〔…〕」：只取引号前的中性描述，去掉书名/来源/括注，压成一句。 */
function summarizeTiaohou(raw: string): string {
  const cut = raw.split('·').filter((seg) => seg && !/[《〔〔【]/.test(seg) && !seg.includes('参考') && !seg.includes('归并'));
  const body = cut.join('，').replace(/[（(][^）)]*[）)]/g, '').replace(/：.*$/, '').trim();
  return body || raw.split('·')[0] || '';
}

type Block = { head: string; points: string[] };
/** 兜底去拉丁：资料库(如 ELEMENT_GUIDES)偶夹「AI」等英文，正文一律转中文并清残留字母。 */
const deLatin = (s: string): string =>
  s.replace(/AI/g, '人工智能').replace(/[A-Za-z]+/g, '').replace(/ {2,}/g, ' ').replace(/ +([，。、；：）])/g, '$1').trim();
/** 统一渲染：每节「【head】\n1. …\n2. …」，与云端正文同构，喂 splitSections/PointsView。 */
const renderBlocks = (blocks: Block[]): string =>
  blocks.map((b) => `【${b.head}】\n` + b.points.map((p, i) => `${i + 1}. ${deLatin(p).replace(/[。；]$/, '')}。`).join('\n')).join('\n');
const blockAdd = (blocks: Block[]) => (head: string, points: Array<string | false | null | undefined>) => {
  const ps = points.filter((p): p is string => !!p && String(p).trim().length > 0);
  if (ps.length) blocks.push({ head, points: ps });
};

/** 调候方向对应的五行：冬火夏水为古今通义，春秋平和故不判偏枯。 */
const TIAOHOU_SEASON_ELEMENT: Record<string, string> = { 春: '', 夏: '水', 秋: '', 冬: '火' };
/** 季节只从引擎那条调候事实的**首段**取（`deriveTiaohou` 以 season + '·' 起头），此处不再立
 *  第二张月支→季节表 —— 与 [[tiaohouFacts]] 同源于 nonAiCalculator，改表不会两头不一致。 */
function seasonOfTiaohou(tiaohouFacts: string): string {
  const head = tiaohouFacts.split('·')[0] ?? '';
  return head in TIAOHOU_SEASON_ELEMENT ? head : '';
}
/** 《穷通宝鉴》按季归并的主/佐用神天干：从引擎原文「…用神参考：癸(佐丙)〔…〕」里现读，不抄第二份表。
 *  ⚠ 主用神取括号**之前**、辅佐干取括号**之内**。上一版写成 `STEMS.includes(c)` 一把抓 —— 那是十干
 *   数组、对任意天干字符恒真，剥括号的 replace 因此压根没生效，把忌神「佐丙」的丙混进主用神端进正文。 */
const TIAOHOU_REF_RE = /用神参考：([^〔]*)/;
const STEMS_IN = (text: string): string[] => [...new Set([...text].filter((c) => STEMS.includes(c)))];
function tiaohouRefStems(tiaohouFacts: string): { main: string[]; support: string[] } {
  const body = TIAOHOU_REF_RE.exec(tiaohouFacts)?.[1] ?? '';
  return {
    main: STEMS_IN(body.split(/[（(]/)[0] ?? ''),
    support: STEMS_IN((body.match(/[（(][^）)]*[）)]/g) ?? []).join('')),
  };
}
/** 该盘「气候是否真偏枯」：冬而局中无火、夏而局中无水才算。用五行配比(countElements 口径)判，
 *  不只看月令季节 —— 冬天满盘火的盘本不需调候，硬从调候会把喜用说反。 */
function climateDeficient(season: string, ratio: Record<string, number>): string | undefined {
  const need = TIAOHOU_SEASON_ELEMENT[season];
  if (!need) return undefined;                       // 春秋：调候非急
  if ((ratio?.[need] ?? 0) > 0) return undefined;    // 所需之气局中已有
  return need;
}
/** 气候真偏枯（见 climateDeficient）时那句「两源合参」的说明。仍按扶抑定喜忌(与三端提示词通则一致)，
 *  但不再把「调候非急」原样端出来 —— 严冬火弱却说「非急」是自相矛盾的话。
 *  ⚠ 措辞分情形，不许一律称「取向相反」：调候急需之气本身可能正是本命喜用(夏需水而水为喜)，那时只是
 *   《穷通》另取的辅佐干撞在忌神上；所需之气不在喜用里才是真相反。season/need 当前只用于取 need 一词，
 *   故调用处必须传同一 need —— 换它不改文案，用例杀不掉（已实测），别指望这两个参数自洽。 */
function tiaohouConflictNote(season: string, need: string, tiaohouFacts: string, useful: string[], avoid: string[]): string {
  const { main, support } = tiaohouRefStems(tiaohouFacts);
  const el = (stems: string[]) => [...new Set(stems.map((c) => ELEMENTS[stemElementIndex(c)]))];
  const mainEls = el(main);
  const supportEls = el(support);
  const clash = [...mainEls, ...supportEls].filter((e) => avoid.includes(e));
  const same = useful.includes(need);
  const opener = '又《穷通宝鉴》于此季取' + (main.join('、') || need) + '为参考'
    + (support.length ? '、佐以' + support.join('、') : '');
  const relation = same
    ? '与调候急需之' + need + '同属本命喜用'
    : '所取' + (clash.length ? clash.join('、') + '正属本命忌神' : need + '不为喜用') + '，与扶抑取向相反';
  const caveat = clash.length
    ? '，惟其中' + clash.join('、') + (same ? '于扶抑为忌' : '即所忌')
    : '，与扶抑所忌并无冲突';
  return opener + '，' + relation + caveat
    + '。此系两源出入，本机仍以扶抑为准、不作唯一结论，两源合参可也；'
    + '惟行运或岁年逢' + need + '之时，寒暖得济，不必因此改本命喜忌。';
}

function deriveUsefulAvoid(dayIdx: number, label?: string, special?: string): { useful: string[]; avoid: string[] } {
  const g = (group: string) => rel(dayIdx, GROUP_OFFSET[group]);
  const uniq = (arr: string[]) => [...new Set(arr)];
  if (special?.startsWith('从格')) {
    return { useful: uniq([g('财'), g('官杀'), g('食伤')]), avoid: uniq([g('印'), g('比劫')]) };
  }
  if (special?.startsWith('专旺')) {
    return { useful: uniq([g('比劫'), g('印'), g('食伤')]), avoid: uniq([g('官杀')]) };
  }
  if (label === '身强' || label === '中和偏旺') {
    return { useful: uniq([g('食伤'), g('财'), g('官杀')]), avoid: uniq([g('印'), g('比劫')]) };
  }
  return { useful: uniq([g('印'), g('比劫')]), avoid: uniq([g('财'), g('官杀'), g('食伤')]) };
}

/** 命局「病处」：取克泄耗方权重最大的一组十神来定性(身强则取助身方)。
 *  另回传「入句各组」「同侧其余**有名目且有权重**的组」及该侧力量总和，供上层把主次写成读数。
 *  「日主」也进 detail 且算在助身方，但它不是病处，故先滤掉无名目的组再取前二；
 *  sideTotal 仍含它，占比读数才是完整的该侧力量。 */
function ailment(score: NonAiChart['strengthScore'], label: string): { phrase: string; groups: string[]; namedWeight: number; restGroups: string[]; sideTotal: number } {
  const detail = score?.detail ?? [];
  const empty = { groups: [], namedWeight: 0, restGroups: [], sideTotal: 0 };
  if (!detail.length) return { ...empty, phrase: label === '身弱' ? '泄耗过重、日主孤弱' : label === '身强' ? '生扶太过、旺而无制' : '攻耗与生扶大致相衡' };
  const wantSide = label === '身强' || label === '中和偏旺' ? 'support' : 'drain';
  const byGroup: Record<string, number> = {};
  for (const d of detail) {
    if (d.side !== wantSide) continue;
    const grp = TEN_GOD_GROUP[d.tenGod] ?? d.tenGod;
    byGroup[grp] = (byGroup[grp] ?? 0) + (d.weight ?? 0);
  }
  // 权重并列时按固定次序取名目，否则 Object.entries 的插入序会随四柱而变，同一盘换台机器就换措辞。
  const PHRASE_ORDER = ['食伤', '财', '官杀', '比劫', '印'];
  const cmp = (x: [string, number], y: [string, number]) =>
    (y[1] !== x[1] ? y[1] - x[1] : PHRASE_ORDER.indexOf(y[0]) - PHRASE_ORDER.indexOf(x[0]));
  const ranked = Object.entries(byGroup).sort(cmp).map(([g]) => g).filter(Boolean);
  const phraseMap: Record<string, string> = {
    食伤: '食伤太旺泄身过重', 财: '财星耗身、任财不易', 官杀: '官杀攻身、压力沉重',
    比劫: '比劫结党、分夺财星', 印: '印绶太过、反掩秀气',
  };
  const w = (g: string) => byGroup[g] ?? 0;
  const sum = (gs: string[]) => Math.round(gs.reduce((a, g) => a + w(g), 0) * 10) / 10;
  /* 必须先滤掉无名目的组再取前二：「日主」也计在助身方且权重不低，若让它占掉一个名额，
     句里只剩一组病处、下一名却仍被报成「次之」，主次读数和占比全跟着错位。 */
  const namedRanked = ranked.filter((g) => g in phraseMap);
  const top = namedRanked.slice(0, 2);
  const parts = top.map((g) => phraseMap[g]).filter(Boolean);
  if (!parts.length) return { ...empty, phrase: label === '身弱' ? '泄耗过重、日主孤弱' : '生扶太过、旺而无制' };
  // namedRanked 已按权重降序，故掉出前二的即同侧余组。
  return {
    phrase: parts.join('，兼有'), groups: top, namedWeight: sum(top),
    // 余组只留**有名目且有力量**的：印绶权重为 0 时说「独占此侧一成」才不与之自相矛盾。
    restGroups: namedRanked.slice(2).filter((g) => w(g) > 0),
    // 分母取该侧全部力量(含「日主」)，故用 sideTotal 而非具名组之和——namedWeight+restWeight
    // 会漏掉日主的 6 分，把独占读数抬到 1.0、让「低于一成则不报」的闸门永不触发。
    sideTotal: sum(ranked),
  };
}

/** 主入口：由记录算出本地批断；无排盘数据返回 null。 */
export function buildLocalAnalysis(record: BaziRecord, now: Date = new Date()): LocalAnalysis | null {
  const n: NonAiChart | undefined = record.nonAiResult;
  if (!n?.pillars) return null;

  const dayStem = n.pillars.day?.[0];
  const dayBranch = n.pillars.day?.[1];
  const monthBranch = n.pillars.month?.[1];
  const dayIdx = isStem(dayStem) ? stemElementIndex(dayStem!) : -1;
  const dayElement = dayIdx >= 0 ? ELEMENTS[dayIdx] : '';
  const score = n.strengthScore;
  const pattern = n.patternFacts;
  const label = score?.label ?? '中和';
  const nowYear = now.getUTCFullYear();
  const { useful, avoid } = dayIdx >= 0 ? deriveUsefulAvoid(dayIdx, score?.label, pattern?.special) : { useful: [], avoid: [] };

  // 每个小节以 {head, points[]} 组织，统一渲染为「【head】\n1. …\n2. …」，与云端正文同构。
  const blocks: Array<{ head: string; points: string[] }> = [];
  const add = (head: string, points: Array<string | false | null | undefined>) => {
    const ps = points.filter((p): p is string => !!p && String(p).trim().length > 0);
    if (ps.length) blocks.push({ head, points: ps });
  };

  // ① 身强身弱与喜忌（格局依据 → 得令 → 得分 → 净分档位病处 → 扶抑 → 调候参考）
  if (pattern || score) {
    const points: Array<string | false | null | undefined> = [];
    if (pattern) {
      points.push(`格局以${pattern.name}论：${stripParens(pattern.basis) || `月令${pattern.tenGod}当权取以为格`}。`);
      if (pattern.special) points.push(`${pattern.special}，须与正格扶抑合参。`);
    }
    if (score && dayElement) {
      points.push(`日主${dayStem}${dayElement}生于${monthBranch ?? '月令'}月，${score.inSeason ? '得令而当旺' : '不得令'}，${score.monthHasSupport ? '月支藏干见印比通根之助' : '月支藏干中未见印比通根之助'}。`);
      points.push(`助身方（比劫与印）合计${cnNum(score.support)}，克泄耗方（食伤、财与官杀）合计${cnNum(score.drain)}。`);
      const ail = ailment(score, label);
      /* 「某组是否被划为忌」必须比对 deriveUsefulAvoid 写进 avoid 的那个字：它按整组只取
         rel(dayIdx, GROUP_OFFSET[g]) 的**首字**入表，而一组占两个相邻五行、第二字未必在表里。
         拿 groupElements 的两个字求交来判会得出相反结论。 */
      const isAvoidGroup = (g: string) => avoid.includes(rel(dayIdx, GROUP_OFFSET[g]));
      const restNamed = ail.restGroups.length > 0;   // ailment 已滤掉「日主」这类无名目的组
      /* cnNum 只到两位数(≥100 会原样吐出阿拉伯数字)，故先把占比折成「几点几成」再转中文。
         旧版另有一句「两组合计约占该侧力量X成」：病处取该侧权重最大的**两**组，同侧只要还有
         第三组可报，占比就必低于十成、写出来毫无信息量，实测 2484 盘 cheng 最大 1.0 而门槛是
         8，从不触发，已删。 */
      const chengTxt = cnNum(ail.sideTotal > 0 ? Math.round((ail.namedWeight / ail.sideTotal) * 10) / 10 : 0);
      const tailParts: string[] = [];
      /* 余组一侧仍逐组判忌。扶抑口径下病处所取的一侧几乎整侧皆忌(身强取印比、身弱取食伤财官杀)，
         故 filter(isAvoidGroup) 与不过滤在实测里等价——7344 盘枚举下来，唯一一组「avoid 只列一组」的
         专旺候选盘(1966-10-26 戊午忌木)其同侧余组为空、根本不进这条分支，因此这层过滤目前杀不掉
         (变异 P1 两端全绿)。它是防御性代码：若将来改喜忌口径使某侧出现非忌余组，去掉它会误报「次之」。 */
      const restAvoid = ail.restGroups.filter(isAvoidGroup);
      if (!restNamed) {
        /* 同侧只剩这一组：说「此即忌神之所在」等于把下一句的「忌X」重讲一遍，改口报独占比重。
           判据用**渲染出来的读数**而不是另算一个比值：低于一成时中文写成「零点几成」，
           「病处独占此侧零点二成」自己就反驳了「独占」二字，故宁可不报。真实命局最低 0.8 成。 */
        if (!chengTxt.startsWith('零')) tailParts.push(`病处独占此侧${chengTxt}成`);
      } else if (ail.groups.length && ail.groups.every(isAvoidGroup)) {
        tailParts.push('此即忌神之所在');
        if (restAvoid.length) tailParts.push(`${restAvoid.join('、')}次之`);
      } else if (restAvoid.length) {
        tailParts.push(`${restAvoid.join('、')}次之`);
      }
      const tail = tailParts.length ? `（${tailParts.join('，')}）` : '';
      points.push(`净分${cnNum(score.net)}，档位判为${label}；命局病处在于${ail.phrase}${tail}。`);
    }
    if (dayIdx >= 0 && (useful.length || avoid.length)) {
      const principle = pattern?.special?.startsWith('从格') ? '弃命从其旺势，宜顺势不宜扶身'
        : pattern?.special?.startsWith('专旺') ? '从其一气之专旺，宜生扶不宜逆克'
        : label === '身强' || label === '中和偏旺' ? '身强当喜克泄耗以成器、忌再逢生扶'
        : '身弱当喜印比生扶、忌再遭克泄耗';
      points.push(`依扶抑通则，${principle}，故喜用定为${useful.join('、')}，忌${avoid.join('、')}。`);
    }
    if (n.tiaohouFacts) {
      const th = summarizeTiaohou(n.tiaohouFacts);
      /* 严冬而局中无火、盛夏而局中无水时，「调候非急」这句季节通义与本命实际气候相反。那种盘不端
         「非急」，改为如实交代两源分歧 + 仍以扶抑为准；喜忌本身一个字都不改（三端提示词通则一致要求
         扶抑定纲）。冲突面按档位算（.scratch 枚举脚本，读的是 nonAiCalculator 那两张表本体）：
         夏冬两季各日主共 60 组，身强档 30 组取向有出入(夏 18/冬 12)、身弱档 45 组(冬 24/夏 21)；
         其中「所需之气本就是喜用、只有《穷通》辅佐干撞忌神」的占 6/9 组 —— 故措辞不许一律称相反。 */
      const season = seasonOfTiaohou(n.tiaohouFacts);
      const need = climateDeficient(season, n.elementRatio ?? {});
      if (!need || !useful.length) { if (th) points.push(`调候参考：${th}，惟此为辅助判据，须与格局扶抑合参。`); }
      else points.push(tiaohouConflictNote(season, need, n.tiaohouFacts, useful, avoid));
    }
    add('身强身弱与喜忌', points);
  }

  // ② 性格与十神（年/月/时透干十神 + 日主取象）
  {
    const lines: Array<string | false | null | undefined> = [];
    if (dayStem) lines.push(`${STEM_IMAGERY[dayStem] ?? ''}`);
    const tg = (n.tenGods ?? []).map((t, i) => ({ t, i })).filter((x) => x.i !== 2 && x.t && x.t !== '日主');
    for (const x of tg) { const note = TEN_GOD_SEX[x.t]; if (note) lines.push(`${['年', '月', '日', '时'][x.i]}干${x.t}，${note}`); }
    add('性格与十神', lines);
  }

  // ③ 健康（日主五行 + 偏枯 + 受克）
  if (dayElement) {
    const ratio = n.elementRatio ?? {};
    const missing = ELEMENTS.filter((e) => (ratio[e] ?? 0) === 0);
    const points: Array<string | false | null | undefined> = [];
    points.push(`${dayElement}主${ELEMENT_HEALTH[dayElement]}，日主${label}，${label === '身弱' || label === '中和偏弱' ? '先天偏虚，须防该系气血不足与劳损，宜早睡养正' : '偏旺易亢，须防该系亢盛生变，宜疏泄忌郁'}。`);
    if (missing.length) points.push(`命局缺${missing.join('、')}，${missing.map((e) => ELEMENT_HEALTH[e]).join('；')}方面尤为薄弱，宜及早调养、饮食作息须规律。`);
    const gk = dayIdx >= 0 ? rel(dayIdx, GROUP_OFFSET['官杀']) : '';
    if (gk) points.push(`${gk}克${dayElement}，逢其当令之年月，${ELEMENT_HEALTH[gk]}与情志易受牵制，运动与体检不可省。`);
    add('健康', points);
  }

  // ④ 事业（月干主导十神 + 任财官之能 + 用神方位）
  {
    const leadGod = (n.tenGods ?? [])[1] && (n.tenGods ?? [])[1] !== '日主' ? (n.tenGods ?? [])[1] : (n.tenGods ?? [])[0];
    const points: Array<string | false | null | undefined> = [];
    if (leadGod && TEN_GOD_CAREER[leadGod]) points.push(`月令透出${leadGod}，事业取向偏「${TEN_GOD_CAREER[leadGod]}」，${TEN_GOD_SEX[leadGod] ?? ''}`);
    points.push(label === '身弱' || label === '中和偏弱'
      ? '身弱难任财官，职场初期宜依附团队或贵人平台、以积累资历人脉为先，切忌单打独斗或过早创业担重责。'
      : '身旺能任财官，可当开拓与管理之任，宜主动进取、把握实权岗位。');
    if (useful.length) points.push(`行运逢${useful.join('、')}之方（${useful.map((e) => ELEMENT_DIRECTION[e]).join('、')}）较能借力，择业与驻地可就近参考。`);
    add('事业', points);
  }

  // ⑤ 财运（财星五行 + 正偏财倾向 + 任财之能 + 食伤生财）
  if (dayIdx >= 0) {
    const cai = rel(dayIdx, GROUP_OFFSET['财']);
    const shiShang = rel(dayIdx, GROUP_OFFSET['食伤']);
    const hasPian = (n.tenGods ?? []).includes('偏财');
    const points: Array<string | false | null | undefined> = [
      `财为我克，本命财星五行属${cai}，${hasPian ? '偏财透干，格局大开大合、活络善经营，惟财来财去须防大而化之' : '正财为主，宜勤俭累积、按部就班，一分耕耘一分收获'}。`,
      label === '身弱' || label === '中和偏弱'
        ? '身弱不胜财，易陷「看得到拿不稳」之局，理财宜保守稳健，戒高风险投机，可借置业或长期储蓄聚财，合作求财优于独立经营。'
        : '身旺任财有力，求财可进取，忌比劫分夺，合伙须明定权责、钱上有边界。',
      `食伤（${shiShang}）可生财，以才艺、技术、专业变现是把能量转为财星的通途。`,
    ];
    add('财运', points);
  }

  // ⑥ 爱情（配偶星 + 配偶宫 + 感情神煞）
  {
    const points: Array<string | false | null | undefined> = [];
    if (dayIdx >= 0) {
      points.push(record.gender === 'female'
        ? `女命以官杀为夫星，五行属${rel(dayIdx, GROUP_OFFSET['官杀'])}${(n.tenGods ?? []).includes('正官') ? '，正官透干，配偶端正、宜明媒正娶之缘' : '，官杀为夫，择偶易遇有魄力或年龄阅历较长之人'}。`
        : `男命以财为妻星，五行属${rel(dayIdx, GROUP_OFFSET['财'])}${(n.tenGods ?? []).includes('偏财') ? '，偏财透干，异性缘旺、机会多须专一' : '，正财为主，配偶务实顾家'}。`);
    }
    const spHouseGod = n.tenGodDetails?.hidden?.[2]?.[0]?.tenGod;
    const spHouseStem = n.tenGodDetails?.hidden?.[2]?.[0]?.stem;
    if (isBranch(dayBranch) && spHouseGod) {
      const houseHelpful = !!spHouseStem && isStem(spHouseStem) && useful.includes(ELEMENTS[stemElementIndex(spHouseStem)]);
      points.push(`日支${dayBranch}为配偶宫，藏本气${spHouseStem ?? ''}${spHouseGod}，${TEN_GOD_SEX[spHouseGod] ?? ''}`);
      if (houseHelpful) points.push('配偶宫所藏为喜用之神，伴侣多为能予实质支持之人，婚缘有助于自身，宜珍惜。');
    }
    const loveSha = (n.shenSha?.items ?? []).filter((it) => ['桃花', '寡宿', '孤辰', '红艳'].includes(it.name));
    if (loveSha.length) points.push(`${loveSha.map((it) => `${it.name}临${['年', '月', '日', '时'][it.pillarIndex] ?? ''}`).join('、')}，${SHENSHA_NOTE[loveSha[0].name] ?? ''}`);
    add('爱情', points);
  }

  // ⑦ 刑冲克害批注（本命四柱之间的关系，逐条报「哪一宫引动哪一宫、宫中坐什么十神」）
  {
    const natalCore: Core = { n, gender: record.gender === 'female' ? 'female' : 'male', dayStem: dayStem ?? '', dayIdx, dayElement, label, useful, avoid, pattern, score };
    add('刑冲克害批注', natalRelationPoints(natalCore));
  }

  // ⑧ 大运（交运之日 + 当前所运 + 未来两步，各按自己的干支说清顺逆在哪）
  {
    const gfs = n.greatFortunes ?? [];
    if (gfs.length) {
      const core: Core = { n, gender: record.gender === 'female' ? 'female' : 'male', dayStem: dayStem ?? '', dayIdx, dayElement, label, useful, avoid, pattern, score };
      const cur = gfs.find((g) => g.startYear <= nowYear && nowYear <= g.endYear);
      const upcoming = gfs.filter((g) => g.startYear > nowYear).slice(0, 2);
      /** 一步运的说法：干支、十神、喜忌侧别、通根禄刃与流年之冲，全部现读这一柱。 */
      const theme = (g: NonAiChart['greatFortunes'][number], when: string) => {
        const v = periodVerdict(g.ganZhi, core);
        const bEl = branchMainElement(v.branch);
        const root = rootNote(core.dayStem, core.dayElement, v.branch);
        const side = v.verdict === '加力' ? `天干${v.stem}${ELEMENTS[stemElementIndex(v.stem)]}，${root}，${bEl}落喜用一侧，此十年可得${bEl || '当期'}之力`
          : v.verdict === '减力' ? `天干${v.stem}${ELEMENTS[stemElementIndex(v.stem)]}，${root}，${bEl}犯忌一侧，此十年所受牵制在此`
          : `天干${v.stem}，${root || '地支无根'}，喜忌两侧并至，此十年顺逆交参、随事而分`;
        return `${when}${g.ganZhi}运（${g.startYear}至${g.endYear}年）行${g.tenGod || '杂气'}之令：${side}。`;
      };
      const onsetAge = n.luckStart ? `生后约${cnNum(n.luckStart.years)}岁${n.luckStart.months ? cnNum(n.luckStart.months) + '个月' : ''}、${n.luckOnset || n.luckStart.date}交运` : '起运时刻未记录（重新计算排盘数据可补算）';
      const points = [
        `${onsetAge}；首运${gfs[0]?.ganZhi ?? '—'}自${gfs[0]?.startYear ?? '—'}年起。`,
        cur ? theme(cur, '现行') + (cur.tenGod ? TEN_GOD_SEX[cur.tenGod] ?? '' : '') : '当前未落在已排大运区间内，可先重新计算排盘数据再补算',
        upcoming.length ? upcoming.map((g) => theme(g, '此后')).join('') : '',
      ];
      add('大运提点', points);
    }
  }

  // ⑨ 神煞点缀（辅助参考）
  {
    const ausp = (n.shenSha?.auspicious ?? []).filter(Boolean);
    const inau = (n.shenSha?.inauspicious ?? []).filter(Boolean);
    const one = (name: string) => SHENSHA_NOTE[name] ? `${name}（${SHENSHA_NOTE[name]}）` : name;
    const points = [
      ausp.length ? '吉神：' + ausp.map(one).join('、') + '。' : '',
      inau.length ? '凶煞：' + inau.map(one).join('、') + '。' : '',
    ];
    add('神煞点缀', [...points, (ausp.length || inau.length) ? '神煞为辅助参考，非单独决断，须与格局喜忌合看。' : '']);
  }

  // ⑩ 总评与行为建议（修行重点 + 方位颜色 + 贵人 + 骨重 + 免责）
  {
    const auspGuiren = (n.shenSha?.auspicious ?? []).filter((x) => ['天乙贵人', '天德贵人', '月德贵人', '文昌贵人'].includes(x));
    const points: Array<string | false | null | undefined> = [
      label === '身弱' || label === '中和偏弱'
        ? '命局核心在于泄耗偏重，一生修行重在「补根」，即强化自身能力与身心稳定，多亲近印比之助。'
        : label === '身强' || label === '中和偏旺'
          ? '命局核心在于生扶太过，修行重在「泄秀任事」，把旺气导向财官食伤，忌安逸结党、无所事事。'
          : '命局攻耗与生扶大致相衡，修行重在顺势调补，随大运流年之喜忌而进退。',
      useful.length ? `日常方位宜向${useful.map((e) => ELEMENT_DIRECTION[e]).join('、')}，颜色多用${useful.map((e) => ELEMENT_COLOR[e]).join('、')}，居所办公宜近喜用五行以调气场。` : '',
      auspGuiren.length ? `善用${auspGuiren.join('、')}之吉力，持续进修、广结善缘可稳固底气。` : '',
      n.chenggu?.totalText ? `称骨${n.chenggu.totalText}（旧说仅供参考）。` : '',
      '以上为本地规则引擎就命盘事实所作批断，长于格局、旺衰、喜忌、六亲、刑冲等可枚举之处，供参考与兜底；多因素权衡、因人而异的综合细断与追问，仍以云端分析为准。',
    ];
    add('总评与行为建议', points);
  }

  const explanation = renderBlocks(blocks);

  return {
    pattern: pattern?.name ?? '—',
    strength: label,
    usefulElements: useful,
    avoidElements: avoid,
    explanation,
    engineVersion: LOCAL_ANALYSIS_ENGINE_VERSION,
    generatedAt: now.toISOString(),
  };
}

/* =============================================================================
 * 分时段本地批断：让「第四路」不止出本命，流年/流月/大运/后天调整/全盘总结均可离线复算，
 * 小节结构与 REQUIRED_SECTIONS(orchestrator) 及云端各篇正文对齐，从而可作为 orchestrateBaziAnalysis
 * 的可插拔 runner 直接顶替网络通道(不联网、不花额度)。
 * ========================================================================== */

interface Core {
  n: NonAiChart; gender: 'male' | 'female'; dayStem: string; dayIdx: number; dayElement: string; label: string;
  useful: string[]; avoid: string[]; pattern?: NonAiChart['patternFacts']; score?: NonAiChart['strengthScore'];
}
function deriveCore(record: BaziRecord): Core | null {
  const n = record.nonAiResult;
  if (!n?.pillars) return null;
  const dayStem = n.pillars.day?.[0] ?? '';
  const dayIdx = STEMS.includes(dayStem) ? stemElementIndex(dayStem) : -1;
  const dayElement = dayIdx >= 0 ? ELEMENTS[dayIdx] : '';
  const score = n.strengthScore;
  const label = score?.label ?? '中和';
  const { useful, avoid } = dayIdx >= 0 ? deriveUsefulAvoid(dayIdx, score?.label, n.patternFacts?.special) : { useful: [], avoid: [] };
  return { n, gender: record.gender === 'female' ? 'female' : 'male', dayStem, dayIdx, dayElement, label, useful, avoid, pattern: n.patternFacts, score };
}

const branchMainElement = (b: string): string => {
  const s = (HIDDEN_STEMS[b] ?? [])[0] ?? '';
  return STEMS.includes(s) ? ELEMENTS[stemElementIndex(s)] : '';
};
/** 时段干支相对本命喜忌的「加/减力」定性(确定性)：天干五行 + 地支本气五行，落在喜用侧记加力、忌神侧记减力。 */
function periodVerdict(gz: string, core: Core): { stem: string; branch: string; helpEl: string[]; harmEl: string[]; verdict: '加力' | '减力' | '并见' } {
  const stem = gz[0] ?? '';
  const branch = gz[1] ?? '';
  const els: string[] = [];
  if (STEMS.includes(stem)) els.push(ELEMENTS[stemElementIndex(stem)]);
  const bme = branchMainElement(branch);
  if (bme) els.push(bme);
  const helpEl = [...new Set(els.filter((e) => core.useful.includes(e)))];
  const harmEl = [...new Set(els.filter((e) => core.avoid.includes(e)))];
  const verdict = helpEl.length > harmEl.length ? '加力' : harmEl.length > helpEl.length ? '减力' : '并见';
  return { stem, branch, helpEl, harmEl, verdict };
}

/** 本命四柱之间的刑冲合害，逐条批注(宫位与十神都从这张盘现读)。 */
function natalRelationPoints(core: Core): string[] {
  const n = core.n;
  const pts: string[] = [];
  const seen = new Set<string>();
  for (const rd of n.relationshipDetails ?? []) {
    if (rd.sourceLayer !== 'natal' || rd.targetLayer !== 'natal') continue;
    const typeCn = RELATION_TYPE_CN[rd.type]; if (!typeCn) continue;
    const pair = [rd.sourcePillar, rd.targetPillar].sort().join('|');
    const key = typeCn + pair; if (seen.has(key)) continue; seen.add(key);
    const status = STATUS_CN[rd.status] ?? '';
    // 两侧都是本命柱：任取一侧作「被说的那一柱」，另一侧作落点。
    const idxA = palaceIndexOf(rd.sourcePillar, n), idxB = palaceIndexOf(rd.targetPillar, n);
    const [house, onto] = idxA >= idxB ? [rd.sourcePillar, rd.targetPillar] : [rd.targetPillar, rd.sourcePillar];
    pts.push(natalRelationSentence(core, typeCn, status, house, onto));
    if (pts.length >= 5) break;
  }
  return pts;
}

/** 时段与本命之间的刑冲合害，逐条批注(优先取结构化 relationshipDetails，退取 relationships 串)。 */
function periodRelationPoints(core: Core, period: FortunePeriod | NonAiChart['greatFortunes'][number]): string[] {
  const n = core.n;
  const pts: string[] = [];
  // 同一宫会被多种关系同时命中（实测己酉一盘：对年支既六破又相克，对月支既六合又相克）。
  //   这些句子的前半截「本期柱携某气」与后半截「喜忌收尾」逐字相同，只有关系名不同 —— 全端出来
  //   就是拿重复话占行。故按宫去重，一个宫只留一条，并把该宫命中的关系名并写进这一条里。
  const byPalace = new Map<string, { types: string[]; status: string; periodPillar: string; natalPillar: string }>();
  const order: string[] = [];
  const push = (key: string, tc: string, status: string, periodPillar: string, natalPillar: string) => {
    const slot = byPalace.get(key);
    if (slot) { if (!slot.types.includes(tc)) slot.types.push(tc); return; }
    byPalace.set(key, { types: [tc], status, periodPillar, natalPillar });
    order.push(key);
  };
  const details = ((period as FortunePeriod).relationshipDetails ?? []) as NonAiChart['relationshipDetails'];
  for (const rd of details) {
    if (rd.sourceLayer === 'natal' && rd.targetLayer === 'natal') continue;   // 只留「时段↔本命」之交
    const tc = RELATION_TYPE_CN[rd.type]; if (!tc) continue;
    const side = periodSide(rd, period.ganZhi ?? ''); if (!side) continue;
    const idx = palaceIndexOf(side.natalPillar, n);
    push(idx >= 0 ? `p${idx}` : `x${side.natalPillar}`, tc, STATUS_CN[rd.status] ?? '', side.periodPillar, side.natalPillar);
  }
  if (!order.length) {
    for (const [k, arr] of Object.entries(period.relationships ?? {})) {
      const tc = RELATION_TYPE_CN[k]; if (!tc) continue;
      for (const s of (arr ?? [])) {
        const i = Math.max(s.indexOf('与'), s.indexOf('克'));
        const left = i >= 0 ? s.slice(0, i).trim() : s.trim();
        const right = i >= 0 ? s.slice(i + 1).trim() : '';
        const hit = [left, right].find((p) => p === period.ganZhi) ?? left;
        const other = hit === left ? right : left;
        const idx = palaceIndexOf(other, n);
        push(idx >= 0 ? `p${idx}` : `x${other}`, tc, '', hit, other);
      }
    }
  }
  for (const key of order.slice(0, 4)) {
    const g = byPalace.get(key)!;
    pts.push(relationSentence(core, g.types.join('、'), g.status, g.periodPillar, g.natalPillar, palaceIndexOf(g.natalPillar, n)));
  }
  return pts;
}

const VERDICT_WORD: Record<string, string> = { 加力: '加力（顺）', 减力: '减力（逆）', 并见: '喜忌并见（顺逆交参）' };
const TITLE_TAIL: Record<string, string> = { 加力: '进气', 减力: '当戒', 并见: '顺逆参半' };

/** 本命四柱各自的「宫 + 十神」标签，用于把冲合落到具体人事，而不是只报柱名。 */
function pillarLabel(core: Core, pillar: string): string {
  const idx = palaceIndexOf(pillar, core.n);
  if (idx < 0) return `${pillar}`;
  return `${PALACE_WORD[idx]}的${pillar}（干${stemGodOf(core.dayStem, pillar[0] ?? '')}、支藏${stemGodOf(core.dayStem, (HIDDEN_STEMS[pillar[1] ?? ''] ?? [])[0] ?? '')}）`;
}
/** 本期天干对日主的十神(纯代数，与引擎 tenGodOf 同式)。 */
const periodStemGod = (core: Core, stem: string) => (isStem(stem) ? stemGodOf(core.dayStem, stem) : '');

/** 本期干支各自在本命盘中的位置（月柱/时柱同名时要说清是哪一柱，别把「丙寅」当成凭空来的字）。 */
function natalEcho(core: Core, stem: string, branch: string): string {
  const p = [core.n.pillars?.year, core.n.pillars?.month, core.n.pillars?.day, core.n.pillars?.hour];
  const at = (ch: string, col: 0 | 1) => ['年', '月', '日', '时'].filter((_, i) => (p[i] ?? '')[col] === ch);
  const sAt = at(stem, 0), bAt = at(branch, 1);
  return `天干${stem}${sAt.length ? '又见于本命' + sAt.join('、') + '柱' : '为本命四柱所无'}，地支${branch}${bAt.length ? '与本命' + bAt.join('、') + '柱并见' : '不落本命四柱'}`;
}

/* ⚠ 以下两句只报**当期这一柱**的事实，绝不查本命四柱的字面。
   上一版有个 stemPositionNote：拿本期干支去本命里找同名的柱，找到日柱那一格就说
   「日干即本命X、与日主同字，正印之性不假外求」。实测 1972-04-19 乾造(己卯时)的 2029 己酉流年
   被它写成「日干即本命己」—— 那是把**时干的字**当成了日主，整句是假话。
   十神的来源归属只能看它与日主的生克关系(下面 periodStemGod)，不能看字面撞了哪一柱。 */
/** 本期地支藏干各自的十神（含喜忌侧别），用于说清「这个支里到底坐着什么」。 */
function branchContents(core: Core, branch: string): string {
  const hs = HIDDEN_STEMS[branch] ?? [];
  return hs.map((s, i) => {
    const el = isStem(s) ? ELEMENTS[stemElementIndex(s)] : '';
    const side = el && core.useful.includes(el) ? '喜' : el && core.avoid.includes(el) ? '忌' : '闲';
    return `${['本气', '中气', '余气'][i] ?? '余气'}${s}${stemGodOf(core.dayStem, s)}（${el}${side}）`;
  }).join('、');
}

function buildPeriodAnalysis(core: Core, period: FortunePeriod | NonAiChart['greatFortunes'][number] | undefined, scope: 'annual' | 'monthly' | 'decade'): BaziAIAnalysis | null {
  if (!period?.ganZhi) return null;
  const gz = period.ganZhi; const tenGod = period.tenGod ?? '';
  const { verdict, harmEl, helpEl, stem: pStem, branch: pBranch } = periodVerdict(gz, core);
  const scopeWord = scope === 'annual' ? '流年' : scope === 'monthly' ? '流月' : '大运';
  const weak = core.label === '身弱' || core.label === '中和偏弱';
  const dayPillar = core.n.pillars?.day ?? '';
  // 本期地支冲到的**本命柱**（不是「有没有冲」）：只说「本期逢冲」等于没批——同一张盘里
  // 冲年支与冲日支是两回事，前者动祖上/门户，后者动配偶宫与自身。
  const chongPalaces = [...new Set(((period.relationships?.chong ?? []).map((s) => {
    const i = s.indexOf('与');
    const parts = (i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s]).map((t) => t.trim());
    return parts.find((p) => p !== gz && [core.n.pillars?.year, core.n.pillars?.month, dayPillar, core.n.pillars?.hour].includes(p));
  }).filter((x): x is string => !!x)))];
  const spouseClash = chongPalaces.includes(dayPillar);
  const blocks: Block[] = []; const add = blockAdd(blocks);

  const energyNote = verdict === '加力'
    ? `喜用${helpEl.join('、')}得此期之力，${weak ? '元气得以培补' : '气象愈发流通'}`
    : verdict === '减力'
      ? `忌神${harmEl.join('、') || core.avoid.join('、')}当令，日主${core.dayStem}${core.dayElement}受其牵制`
      : `喜（${helpEl.join('、')}）与忌（${harmEl.join('、')}）并至，吉凶随具体事类而分`;
  const tenGodSex = TEN_GOD_SEX[tenGod] ?? '';
  const tenGodCareer = TEN_GOD_CAREER[tenGod] ?? '';

  const periodTag = scope === 'annual' ? `${(period as FortunePeriod).year ?? ''}年${gz}`
    : scope === 'monthly' ? `${(period as FortunePeriod).year ?? ''}年${(period as FortunePeriod).month ?? ''}月${gz}`
      : `${gz}运（${(period as { startYear?: number }).startYear ?? ''}至${(period as { endYear?: number }).endYear ?? ''}年）`;

  /* 健康第 2 句按「日主所主之脏 vs 本期所犯/所得之气」现推，不再固定一句「作息情绪易出问题」。
     上一版这一行整张盘、整十年都逐字相同（实测 ×51 重复），读者看到的是模板不是这张盘：
     同样是喜忌并见，火来克金的盘与土去生金的盘养的、伤的压根不是一个部位。 */
  const organWord = ELEMENT_HEALTH[core.dayElement] ?? '体质';
  const dayIdxE = core.dayIdx;
  /* 忌气对日主的作用方向必须按**十神分组**取，不能拿喜忌数组的下标顺序去猜：
     avoid = [财, 官杀, 食伤]（身弱）或 [印, 比劫]（身强），而 core.avoid[0] 在两种盘里分别是
     「我克者」与「生我者」——上一版写 `harmEl.find(e => e === core.avoid[0])` 当作「克我之神」，
     实测水日主见火(财)被说成「火气克日主水」，方向正好反了（火是耗水的、克水的是土）。
     GROUP_OFFSET 那张表就在本模块开头，直接用它。 */
  const elOffset = (e: string) => (['木', '火', '土', '金', '水'] as string[]).indexOf(e);
  const groupOfEl = (e: string): string => {
    const d = ((elOffset(e) - dayIdxE) % 5 + 5) % 5;
    return Object.keys(GROUP_OFFSET).find((k) => GROUP_OFFSET[k] === d) ?? '';
  };
  const harmGroup = (e: string) => ({ 官杀: '克', 财: '耗', 食伤: '泄', 印: '生', 比劫: '分夺' }[groupOfEl(e)] ?? '犯');
  const threatEl = harmEl.find((e) => groupOfEl(e) === '官杀') ?? harmEl.find((e) => !!e && e !== core.dayElement);
  const nourishEl = helpEl.find((e) => groupOfEl(e) === '印');
  const harmPhrase = harmEl.filter((e) => !!e).map((e) => `${e}气${harmGroup(e)}`).join('、');
  /* 第 2 句的落点必须跟着**本期那位十神**走：身弱见官杀年与见财年是两回事，一律写
     「先见于某脏、睡眠与情志次之」就成了整十年不换字的模板（实测 ×51 逐字相同）。
     十神→病处的对应只取通行口径里最直白的一条，不铺开讲。 */
  const godAilOf = (g: string) => ({ 官杀: '压力与作息先乱，肩颈、血压易紧', 财: '饮食与开支一起上来，脾胃首当其冲',
    食伤: '思虑过度、耗神，睡眠最浅', 印: '人气虽聚而懒于动，湿滞不畅', 比劫: '劳碌争竞，筋骨与情绪两头受磨' }[g] ?? '');
  /* 引擎的 tenGod 字段在大运存量行/补槽里可能为空（见爱情小节对它的同款兜底），此时按本期天干
     代数现推。**没有对应病处就说没有**：上一版兜到一句「睡眠与情志次之」，实测印、比两类的盘
     整十年都吐同一句 —— 那正是本次要消灭的东西，拿它当 fallback 等于原地踏步。 */
  const periodGod = tenGod || periodStemGod(core, pStem);
  const godAil = godAilOf(periodGod);
  add('健康', [
    `${periodTag}${tenGod ? '行' + tenGod + '之令' : ''}，天干${pStem}${isStem(pStem) ? ELEMENTS[stemElementIndex(pStem)] : ''}（于日主${core.dayStem}为${periodStemGod(core, pStem) || '杂气'}）、地支${pBranch}藏${branchContents(core, pBranch)}；${rootNote(core.dayStem, core.dayElement, pBranch)}。相对本命为${VERDICT_WORD[verdict]}——${energyNote}。`,
    verdict === '减力'
      ? `${periodTag}忌在${harmEl.join('、') || core.avoid.join('、')}${threatEl ? `，${harmPhrase}日主${core.dayElement}所主的${organWord}` : `，日主${core.dayElement}之气被这期干支耗散`}；${scopeWord === '流月' ? '这个月' : scopeWord === '流年' ? '本年' : '这十年'}${organWord}最先有感觉${godAil ? `，${godAil}` : ''}，早调胜于硬撑。`
      : verdict === '加力'
        ? `${periodTag}喜在${helpEl.join('、')}${nourishEl ? `，${nourishEl}气生日主${core.dayElement}，${organWord}得养` : `，助身之气到位，${organWord}根基较前稳固`}；${scopeWord === '流月' ? '这个月' : scopeWord === '流年' ? '本年' : '此运'}宜趁势收拾旧患${godAil ? `，连${periodGod}带来的${godAil.split('，')[0]}也可一并松开` : '，积劳随之减轻'}。`
        : `${periodTag}喜${helpEl.join('、')}与忌${harmEl.join('、')}各占一半${threatEl ? `，${harmPhrase}日主${core.dayElement}所主的${organWord}，而${helpEl.join('、')}气护它` : `，两头之气同临${organWord}`}；${scopeWord === '流月' ? '本月' : scopeWord === '流年' ? '本年' : '此运'}强弱全看节奏${godAil ? `，${godAil}` : '，过劳与安逸两头都看得见'}。`,
  ]);
  add('事业', [
    tenGodCareer ? `${tenGod || periodStemGod(core, pStem)}临期，取向偏「${tenGodCareer}」：天干${pStem}于日主为${periodStemGod(core, pStem) || '杂气'}，${rootNote(core.dayStem, core.dayElement, pBranch)}；${tenGodSex}` : (tenGodSex || `${gz}于事业无专主之神，${scopeWord === '大运' ? '此十年' : '本期'}以本职为本。`),
    (() => {
      const echo = natalEcho(core, pStem, pBranch);
      /* 「主事/受阻」那半句必须跟着**本期自己那位十神**说，不能沿用本命某柱的十神：
         上一版这里读 stemGodOf(日主, 本期天干)，与第一行的取向同源，尚可；但收尾三句
         「可承接更重的责任／宜守既有岗位／抓稳关键环节」在整张盘每一年都逐字相同（实测 ×20 以上），
         现在把档位、宫位动静(有无冲)、十神三者一起写进去，让同盘相邻两年也说不出同一句话。 */
      const godWord = stemGodOf(core.dayStem, pStem);
      const moved = chongPalaces.length ? `且${chongPalaces.map((s) => PALACE_WORD[palaceIndexOf(s, core.n)]).join('、')}已被冲动` : '四宫未受特别冲动';
      if (verdict === '加力') return `${echo}。得力处在${helpEl.join('、')}，${godWord ? `${godWord}当权、${moved}` : moved}，${tenGodCareer ? `就着「${tenGodCareer.split('、')[0]}」这条线推进最省力` : '宜主动承接更重的责任'}。`;
      if (verdict === '减力') return `${echo}。掣肘处在${harmEl.join('、') || core.avoid.join('、')}，${godWord ? `${godWord}一类的事务最先受阻，${moved}` : moved}，${tenGodCareer ? `「${tenGodCareer.split('、')[0]}」这条线宜守不宜攻` : '宜守既有岗位、少与人硬碰'}。`;
      return `${echo}。喜忌并至（喜${helpEl.join('、')}、忌${harmEl.join('、')}）：${godWord ? `${godWord}之事可为而余者生枝节，${moved}` : moved}，${scopeWord === '大运' ? '这十年' : '本期'}抓稳关键环节即可。`;
    })(),
    (() => {
      if (!chongPalaces.length) return '';
      /* 冲的是哪一宫决定后半句怎么说：门户之冲主迁移转岗，配偶宫之主动家宅婚缘，
         年支/时支被冲则落在早年根基与晚年归宿上。上一版不分宫位、一律写「转岗搬迁合作聚散」，
         实测同一张盘冲日支与冲时支的两行只差柱名，读者看不出动的压根不是一回事。 */
      const ws = chongPalaces.map((s) => PALACE_WORD[palaceIndexOf(s, core.n)]).filter(Boolean);
      const kind = ws.some((w) => w.includes('配偶宫')) ? '家宅与自身同动，住处、婚缘最易先变'
        : ws.every((w) => w.includes('门户')) ? '门户之冲，主迁移、转岗与合作聚散'
          : '所动在早年根基或晚年归宿，多应在家中长辈、去处与长计划的事上';
      return `${gz}冲${chongPalaces.map((s) => pillarLabel(core, s)).join('、')}，此乃${kind}；${scopeWord === '流月' ? '这一个月' : scopeWord === '流年' ? '本年' : '此十年'}的变动多半应在这一冲上，宜早做预案、以静制动。`;
    })(),
  ]);
  /* 财星在本期是「透干／藏支／未现」三种形态之一，第 1 句已经按它分支；第 2 句必须引用同一个
     事实，否则会出现「财路明动」＋「本期无财可求」这种自相矛盾的相邻两行。 */
  const wealthGods = ['正财', '偏财'].join('、');
  const myWealthEls = groupElements(core.dayIdx, '财').filter((e) => e);
  const hasWealthNow = TEN_GOD_GROUP[tenGod || periodStemGod(core, pStem)] === '财';
  const hiddenNow = (HIDDEN_STEMS[pBranch] ?? []).some((s) => ['正财', '偏财'].includes(stemGodOf(core.dayStem, s)));
  const elSide = (e: string) => core.useful.includes(e) ? '喜用' : core.avoid.includes(e) ? '忌神' : '闲神';
  add('财运', [
    (() => {
      if (hasWealthNow) {
        const g = tenGod || periodStemGod(core, pStem);
        return `${g}透干（${pStem}${isStem(pStem) ? ELEMENTS[stemElementIndex(pStem)] : ''}，于${core.dayStem}${core.dayElement}为${elSide(isStem(pStem) ? ELEMENTS[stemElementIndex(pStem)] : '')}一侧），财路明动：${verdict === '加力' ? `本期求财可进取，惟${weak ? '身弱担大财吃力，见好就收' : '防比劫分夺，账目与合作权责要先讲清'}。` : `看似有机会，实则耗多进少，投机与借贷皆忌。`}`;
      }
      if (hiddenNow) {
        const hs = (HIDDEN_STEMS[pBranch] ?? []).filter((s) => ['正财', '偏财'].includes(stemGodOf(core.dayStem, s)));
        return `财不透干而藏于${pBranch}（${hs.map((s) => `${s}主${stemGodOf(core.dayStem, s)}`).join('、')}），本期财在暗处、靠既有积累与合约兑现，${myWealthEls.map((e) => `${e}气${elSide(e)}`).join('、')}决定其成色。`;
      }
      if (TEN_GOD_GROUP[tenGod || periodStemGod(core, pStem)] === '食伤') {
        return `${tenGod || periodStemGod(core, pStem)}当令，我生之气流通能生${wealthGods}，本期以技艺、内容、口碑换钱较顺；${verdict === '加力' ? `所生${myWealthEls.join('、')}又属${elSide(myWealthEls[0] ?? '')}，财源可期。` : '惟气势未济，收成慢半拍，忌贪大。'}`;
      }
      if (verdict === '减力') return `本期无财星亦无食伤引路（${gz}主${tenGod || periodStemGod(core, pStem) || '杂气'}），进项只依正职稳收，开支须先于收入定下额度。`;
      return `${gz}不涉财与食伤（主${tenGod || periodStemGod(core, pStem) || '杂气'}），财按既有计划走即可，本期不是开源之年月、也不是破败之年月。`;
    })(),
    weak
      ? `本命判${core.label}、助身方${cnNum(core.score?.support ?? 0)}对克泄耗方${cnNum(core.score?.drain ?? 0)}，任财之力本不足；${gz}这期财星${hasWealthNow ? '透见' : hiddenNow ? '藏支' : '未现'}，${scope === 'decade' ? '此十年' : '本期'}${hasWealthNow || hiddenNow ? '进财有门路，但门路要靠合约与团队撑，单打独斗博快钱最易失手' : '进项只依正职稳收，把钱攒在长期置业或储蓄里比追机会稳妥'}。`
      : `本命判${core.label}、助身方${cnNum(core.score?.support ?? 0)}对克泄耗方${cnNum(core.score?.drain ?? 0)}，身旺能任财；${gz}这期财星${hasWealthNow ? '透见、可主动进取，惟比劫分夺之扰常在，账目与权责要先讲清' : hiddenNow ? '藏支、利在既有合约与积累上加码，不宜另开新摊子' : '未现，宜把精力放在开拓与管理岗位上，财随事业来'}。`,
  ]);
  // 爱情：三条引动途径都要查，缺一条就会把「本期明明动了夫妻宫」写成「未受特别引动」（实测判据偏窄）。
  {
    const spouseGroup = core.gender === 'female' ? '官杀' : '财';
    const spouseLabel = spouseGroup === '财' ? '妻星' : '夫星';
    const dayBranch = core.n.pillars?.day?.[1] ?? '';
    // ① 本期**天干**是配偶星。优先用引擎给的十神字段；该字段在大运存量行与瘦身补槽里可能缺失，
    //   此时退回按日主代数推出的配偶组五行。两种读法**并不恒等**：十神字段只看本期天干，
    //   而兜底还认财组的另一个五行（实测：男命乙木见辛金，字段读作七杀、兜底认作财）。
    //   故字段在时以字段为准，缺字段才用兜底——别把这里改成「两者取或」。
    const spouseEls = groupElements(core.dayIdx, spouseGroup);
    const stemEl = isStem(pStem) ? ELEMENTS[stemElementIndex(pStem)] : '';
    const movedByStem = TEN_GOD_GROUP[tenGod] === spouseGroup || (!!stemEl && spouseEls.includes(stemEl));
    // ② 本期**地支本气**是配偶星（旧写法只看天干，而地支之力在通行口径里不比天干轻）。
    //   ⚠ 这里必须独立判、不许写成「同 ①」：两条途径各自覆盖的年份并不重合，合并即漏判。
    const bMainStem = (HIDDEN_STEMS[pBranch] ?? [])[0] ?? '';
    const branchEl = isStem(bMainStem) ? ELEMENTS[stemElementIndex(bMainStem)] : '';
    const movedByBranch = !!branchEl && spouseEls.includes(branchEl);
    // ③ 本期地支与本命日支（配偶宫）逢冲、或成三合/六合之局——宫位被引动，与「星被引动」是两回事。
    //   ⚠ 必须逐对看「这一对里两个柱各自的地支」，不能拿整串 includes(日支)：引擎的关系串形如
    //     「甲子与乙丑」，本命别柱（如月柱辛卯）自己就含日支那个字，会把别柱与本期之间的命中
    //     误记到配偶宫头上（实测过这种假引动）。
    const pairBranches = (s: string): [string, string] => {
      const t = String(s);
      const i = Math.max(t.indexOf('与'), t.indexOf('克'));
      const left = i >= 0 ? t.slice(0, i) : t;
      const right = i >= 0 ? t.slice(i + 1) : '';
      return [left[1] ?? '', right[1] ?? ''];
    };
    const palaceTouched = [...(period.relationships?.chong ?? []), ...(period.relationships?.sanHe ?? []), ...(period.relationships?.liuHe ?? [])]
      .some((s) => { const [a, b] = pairBranches(s); return (a === dayBranch || b === dayBranch) && (a === pBranch || b === pBranch); });
    /* 「相引」不能笼统：六合是合（结缘、贴近），六冲/三合是动（拆合、变局）——同一宫被两种力量
       引动，读者该看到的话不一样。上一版两种都写「相引」，于是 2034 甲寅与 2035 乙卯两行爱情批断
       整句逐字相同（同盘相邻时段的实测雷同就出在这一行）。这里取本期地支实际参与的那一对。 */
    const touchKind = (): '合' | '动' | '' => {
      const liu = period.relationships?.liuHe ?? [];
      const isPalacePair = (s: string) => { const [a, b] = pairBranches(s); return (a === dayBranch || b === dayBranch) && (a === pBranch || b === pBranch); };
      if (liu.some(isPalacePair)) return '合';
      if ([...(period.relationships?.chong ?? []), ...(period.relationships?.sanHe ?? [])].some(isPalacePair)) return '动';
      return '';
    };
    const touchWord = touchKind() === '合' ? '相合' : '冲动';
    const why = [movedByStem ? `${scopeWord}天干${pStem}为${tenGod || stemGodOf(core.dayStem, pStem)}` : '',
      movedByBranch ? `${scopeWord}地支${pBranch}所藏本气${bMainStem}亦${spouseGroup}之星` : '',
      palaceTouched ? `更与本命日支${dayBranch}（配偶宫）${touchWord}` : ''].filter(Boolean).join('、');
    // ── 取向判据（v3 第二轮，被实测读数纠正后写下）──────────────────────────────────
    //   第一版直接拿本期整体档位 verdict 定调，两类读数自相矛盾：
    //     · 男命乙木见辛亥年写「妻星…且向喜用」——喜侧那个字是辛(金)，属①路五行兜底认来的财组，
    //       而该句的十神依据是「七杀」；档位本身还是喜忌并见，等于拿整期气势替配偶星下吉凶。
    //     · 减力年同一行既说气势逆、又说妻星向喜用。
    //   所以侧别只统计**认出它的那条途径**所对应的字：偏喜才写向喜用，偏忌才写临忌，
    //   两侧同现走「喜忌同临」，只有宫位被引动而星未现则明说「星本身未现」。
    //   ①②两路各有专属变量（stemEl / branchEl），不许合并成一个数组喂给两条判据；
    //     否则 movedByStem 的五行兜底会经 branchEl 漏进侧别统计（M8/M9 变异体即为此准备）。
    const spouseHelp = [movedByStem ? stemEl : '', movedByBranch ? branchEl : '']
      .filter((e) => !!e && core.useful.includes(e));
    const spouseHarm = [movedByStem ? stemEl : '', movedByBranch ? branchEl : '']
      .filter((e) => !!e && core.avoid.includes(e));
    // 配偶宫那一柱坐的是什么（本命日支藏干十神）：引动同一宫，坐食神与坐七刃的说法不该一样。
    const houseStem = (HIDDEN_STEMS[dayBranch] ?? [])[0] ?? '';
    const houseGod = houseStem ? stemGodOf(core.dayStem, houseStem) : '';
    const houseSide = houseStem && isStem(houseStem)
      ? (core.useful.includes(ELEMENTS[stemElementIndex(houseStem)]) ? '属喜用' : core.avoid.includes(ELEMENTS[stemElementIndex(houseStem)]) ? '属忌神' : '为闲神')
      : '';
    const palaceNote = `本命${dayPillar}一柱为配偶宫，宫中${houseStem}${houseGod}${houseSide}`;
    /* 「（配偶宫）」这五个字是判据的一部分，不许当成冗余括号删掉：
       local-love-period.test 拿「更与本命日支X（配偶宫）…」整串当**逐对判据**的锚点 ——
       它要区分「本期地支 ↔ 本命日支」这一对(真动了配偶宫)与「别柱自己含日支那个字」(假引动)。
       去掉标注后两种写法在正文里一模一样，那条杀手用例立刻转红(实测踩过)。
       ⚠ 括号后面的动词按引动方式分「相合／冲动」（六合是合、冲与三合是动），不再统一写「相引」——
       测试只钉到「（配偶宫）」为止，动词可换；换它是为了打掉相邻两年整行逐字相同。 */
    const whyTxt = why;
    // ⚠ 「向喜用 / 临忌 / 喜忌同临 / 星本身未现 / 感情宫位未受特别引动」这几个短语是测试与检索
    //   认句式的锚点(local-love-period.test 按它们统计四类取向是否可达)，改写措辞时必须原样保留。
    //   ⚠ 未引动那句**不许带全角括号**：测 216 行拿「含（）」当「已写出依据」的判据，
    //   一旦这句里出现括号，互斥断言就把它当成引动句而恒红(实测踩过)。配偶宫的信息放破折号之后。
    const loveLine = (movedByStem || movedByBranch || palaceTouched)
      ? (spouseHelp.length > 0 && spouseHarm.length === 0
        ? `${periodTag}${spouseLabel}被引动（${whyTxt}）且向喜用（所临${spouseHelp.join('、')}），${palaceNote}——感情机会在此${scopeWord === '流月' ? '月' : scopeWord === '流年' ? '年' : '运'}增多、利婚恋推进，单身者宜主动把握。`
        : spouseHarm.length > 0 && spouseHelp.length === 0
          ? `${spouseLabel}临忌被引动（${whyTxt}，忌在${spouseHarm.join('、')}），${palaceNote}——感情易生波折，沟通须柔、忌逞强硬碰。`
          : spouseHelp.length > 0
            ? `${spouseLabel}逢引动（${whyTxt}），喜忌同临于妻夫之宫（喜${spouseHelp.join('、')}、忌${spouseHarm.join('、')}），${palaceNote}——进退随具体事而分，主动沟通则顺，逞强争执则滞。`
            : palaceTouched
              ? `${spouseLabel}逢引动（${whyTxt}），本期夫妻宫被牵动而星本身未现，${palaceNote}——${scopeWord === '流月' ? '本月' : scopeWord === '流年' ? '本年' : '此运'}感情易起变化，${touchKind() === '合' ? '既已贴身相合，多见面、把话说开便有进展' : '既是冲动而非合，聚散随外境而动，先稳住各自节奏再谈取舍'}。`
              : `${spouseLabel}逢引动（${whyTxt}），本期气势${VERDICT_WORD[verdict]}，${palaceNote}——星与宫之吉凶须就事论之，主动沟通则顺。`)
      : spouseClash
        ? `本期不动财官而直冲${dayPillar}，${palaceNote}——配偶宫逢冲，感情聚少离多或起变化，多包容体谅则无大碍。`
        : `感情宫位未受特别引动——${spouseLabel}即${groupElements(core.dayIdx, spouseGroup).join('、')}之气，未现于${gz}干支，本命${dayPillar}亦未被其冲合；${palaceNote}，${scopeWord === '流月' ? '本月' : scopeWord === '流年' ? '本年' : '此运'}以平常心维持既有关系即可。`;
    add('爱情', [loveLine]);
  }
  add('刑冲克害批注', periodRelationPoints(core, period));

  return {
    pattern: core.pattern?.name ?? '—',
    strength: `${core.label}·本期${VERDICT_WORD[verdict]}`,
    usefulElements: core.useful,
    avoidElements: core.avoid,
    explanation: renderBlocks(blocks),
    title: `${gz}${scopeWord}·${tenGod || '行令'}${TITLE_TAIL[verdict]}`,
  };
}

/** 后天调整与职业适配：直接取本命主喜用五行的调养/行业/健康底稿(与云端同源资料库)。 */
function buildAdjustment(core: Core): BaziAIAnalysis | null {
  const favorite = primaryElement(core.useful) as ElementKey | undefined;
  if (!favorite) return null;
  const g = ELEMENT_GUIDES[favorite];
  const blocks: Block[] = []; const add = blockAdd(blocks);
  add('后天调整', g.lifestyle.split('\n').filter(Boolean));
  add('事业适配', [...g.career.split('\n').filter(Boolean), `惟${core.label === '身弱' ? '身弱宜依托团队与平台、不宜孤军创业' : '身旺可主动开拓、担当实权'}，方不負喜用${favorite}之力。`]);
  add('健康注意', [g.health, `日常多以${favorite}行之性调摄，起居有常、动静相宜。`]);
  return {
    pattern: core.pattern?.name ?? '—', strength: core.label,
    usefulElements: core.useful, avoidElements: core.avoid,
    explanation: renderBlocks(blocks), title: `补益喜用·${favorite}`,
  };
}

/** 全盘总结：本命结论 + 未来十年大运走向 + 逐年加减力挑出的关键节点 + 行动建议。 */
function buildOverview(core: Core, now: Date): BaziAIAnalysis | null {
  const fromYear = now.getUTCFullYear();
  const annuals = (core.n.annualFortunes ?? []).filter((a) => a.year >= fromYear && a.year <= fromYear + 9);
  const weak = core.label === '身弱' || core.label === '中和偏弱';
  const strategy = weak ? '补印比、固根本' : '泄秀任事、把旺气导向财官';
  const blocks: Block[] = []; const add = blockAdd(blocks);

  // 未来十年所经大运(取起点落在窗口内的运，最多两步)
  const gfs = core.n.greatFortunes ?? [];
  const upcoming = gfs.filter((g) => g.endYear >= fromYear).slice(0, 2);
  const decadeNote = upcoming.length
    ? `未来十年先走${upcoming.map((g) => `${g.ganZhi}（${g.tenGod ?? '行令'}）`).join('、')}运，整体以「${strategy}」为核心策略。`
    : '';

  const rated = annuals.map((a) => ({ a, v: periodVerdict(a.ganZhi ?? '', core).verdict }));
  const risk = rated.filter((x) => x.v === '减力');
  const opp = rated.filter((x) => x.v === '加力');
  const trendWord = risk.length > opp.length ? '先抑后扬、起伏偏压' : opp.length > risk.length ? '总体向喜、机会有多' : '顺逆交替、平中见波';

  add('核心结论', [
    `命局${core.pattern ? `属${core.pattern.name}、` : ''}日主${core.dayStem}${core.dayElement}判为${core.label}，喜用${core.useful.join('、')}、忌${core.avoid.join('、')}。`,
    decadeNote || '（未取到未来大运段，可先补算排盘数据再评十年大势。）',
    `流年走势呈「${trendWord}」之象：其中${risk.length ? risk.map((x) => x.a.year).join('、') + '年为压力窗口' : '无明显忌年'}，${opp.length ? opp.map((x) => x.a.year).join('、') + '年为回升窗口' : '暂无显著进气之年'}。`,
  ]);

  const nodePoints: string[] = [];
  for (const { a, v } of rated) {
    if (v === '并见') continue;
    const clash = (a.relationships?.chong ?? []).length > 0 || (a.relationships?.xing ?? []).length > 0;
    if (v === '减力' || (v === '加力' && clash)) {
      const why = a.tenGod ? `${a.ganZhi}行${a.tenGod}之令` : `${a.ganZhi}临期`;
      const tag = v === '减力' ? (clash ? '重大风险窗口' : '需谨慎之年') : '机会与压力并见之年';
      const advice = v === '减力'
        ? `宜低调守成、避高风险投资与跳槽远行，多亲近${core.useful.join('、')}以化${core.avoid.join('、')}之扰。`
        : `进气虽可进取，惟逢冲刑主变动，成事同时防人际与健康之消耗，宜有预案。`;
      nodePoints.push(`${a.year}年（${a.ganZhi}）：${clash ? '，并与本命构成冲刑、根基受动' : ''}，属${tag}。建议：${advice}`);
    } else if (v === '加力') {
      nodePoints.push(`${a.year}年（${a.ganZhi}）：喜用进气、${a.tenGod ? a.tenGod + '得力，' : ''}宜把握机会窗口，进取求成、拓展人脉与平台。建议：借${core.useful.join('、')}之方乘势推进。`);
    }
    if (nodePoints.length >= 6) break;
  }
  add('值得关注的时间节点', nodePoints.length ? nodePoints : ['未来十年各年均无显著犯忌或进气之年，宜按部就班、以本命喜忌常调之。']);

  const g = primaryElement(core.useful) ? ELEMENT_GUIDES[primaryElement(core.useful) as ElementKey] : undefined;
  add('行动建议', [
    g ? `五行调理：${g.lifestyle.split('\n')[0]}` : `日常多亲近喜用${core.useful.join('、')}之方位与颜色（${core.useful.map((e) => ELEMENT_COLOR[e]).join('、')}）。`,
    `事业策略：${weak ? '身弱不胜财官，宜依托团队、长辈与平台，以印比帮身的方式稳根基，忌孤军创业。' : '身旺能任事，可主动担当开拓，惟防过刚与比劫分夺。'}`,
    g ? `健康管理：${g.health}` : `重点养护${ELEMENT_HEALTH[core.dayElement] ?? '整体体质'}，逢忌神之年月尤须规律作息、及时体检。`,
  ]);

  return {
    pattern: core.pattern?.name ?? '—', strength: core.label,
    usefulElements: core.useful, avoidElements: core.avoid,
    explanation: renderBlocks(blocks), title: `未来十年大势·${trendWord}`,
  };
}

const findAnnual = (n: NonAiChart, year?: number) => (year === undefined ? undefined : n.annualFortunes?.find((a) => a.year === year));
const findMonthly = (n: NonAiChart, year?: number, month?: number) => (year === undefined || month === undefined ? undefined : n.monthlyFortunes?.find((m) => m.year === year && m.month === month));
const findDecade = (n: NonAiChart, year?: number) => (year === undefined ? undefined : n.greatFortunes?.find((g) => year >= g.startYear && year <= g.endYear));

/** 主分发入口：给定任务，产出与云端各篇正文同构的本地批断；缺该时段排盘数据返回 null。 */
export function buildLocalTaskAnalysis(record: BaziRecord, task: BaziAnalysisTask, now: Date = new Date()): BaziAIAnalysis | null {
  const core = deriveCore(record);
  if (!core) return null;
  switch (task.type) {
    case 'baseline': {
      const a = buildLocalAnalysis(record, now);
      return a ? { pattern: a.pattern, strength: a.strength, usefulElements: a.usefulElements, avoidElements: a.avoidElements, explanation: a.explanation } : null;
    }
    case 'annual': return buildPeriodAnalysis(core, task.annual ?? findAnnual(core.n, task.year), 'annual');
    case 'monthly': return buildPeriodAnalysis(core, task.monthly ?? findMonthly(core.n, task.year, task.month), 'monthly');
    case 'decade': return buildPeriodAnalysis(core, task.decade ?? findDecade(core.n, task.year), 'decade');
    case 'adjustment': return buildAdjustment(core);
    case 'overview': return buildOverview(core, now);
    default: return null;
  }
}
