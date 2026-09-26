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
import type { BaziAIAnalysis, BaziAnalysisTask, BaziRecord, FortunePeriod, NonAiChart } from '../types/domain';

export const LOCAL_ANALYSIS_ENGINE_VERSION = 'local-rules-v2';

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

/** 数字 → 中文读法(含负号与一位小数)，用于把旺衰评分写成「二十八点八」这类白话。 */
const CN_DIGITS = '零一二三四五六七八九';
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
const RELATION_NOTE: Record<string, string> = {
  三合: '会成一方气势，其五行之力被显著放大，须辨其为喜为忌', 六合: '两柱相绊、情深而牵连，主结缘合作亦主牵制',
  六冲: '主动荡、迁移、拆合，被冲之宫所主之事易生变', 相刑: '主是非、刑伤、纠缠，所临六亲或事务易起摩擦',
  六害: '主暗损、猜忌、消耗，关系表面尚可内里生隙', 六破: '主破损、反复、中途生变', 相克: '力量相互压制，须分谁旺谁衰而定吉凶',
};

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

/** 命局「病处」：取克泄耗方权重最大的一组十神来定性(身强则取助身方)。 */
function ailment(score: NonAiChart['strengthScore'], label: string): string {
  const detail = score?.detail ?? [];
  if (!detail.length) return label === '身弱' ? '泄耗过重、日主孤弱' : label === '身强' ? '生扶太过、旺而无制' : '攻耗与生扶大致相衡';
  const wantSide = label === '身强' || label === '中和偏旺' ? 'support' : 'drain';
  const byGroup: Record<string, number> = {};
  for (const d of detail) {
    if (d.side !== wantSide) continue;
    const grp = TEN_GOD_GROUP[d.tenGod] ?? d.tenGod;
    byGroup[grp] = (byGroup[grp] ?? 0) + (d.weight ?? 0);
  }
  const ranked = Object.entries(byGroup).sort((a, b) => b[1] - a[1]).map(([g]) => g).filter(Boolean);
  const phrase: Record<string, string> = {
    食伤: '食伤太旺泄身过重', 财: '财星耗身、任财不易', 官杀: '官杀攻身、压力沉重',
    比劫: '比劫结党、分夺财星', 印: '印绶太过、反掩秀气',
  };
  const parts = ranked.slice(0, 2).map((g) => phrase[g]).filter(Boolean);
  return parts.length ? parts.join('，兼有') : (label === '身弱' ? '泄耗过重、日主孤弱' : '生扶太过、旺而无制');
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
      points.push(`净分${cnNum(score.net)}，档位判为${label}；命局病处在于${ailment(score, label)}。`);
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

  // ⑦ 刑冲克害批注（本命四柱之间的关系事实，逐条列出并点出宫位含义）
  {
    const seen = new Set<string>();
    const points: Array<string | false | null | undefined> = [];
    for (const rd of n.relationshipDetails ?? []) {
      if (rd.sourceLayer !== 'natal' || rd.targetLayer !== 'natal') continue;
      const typeCn = RELATION_TYPE_CN[rd.type]; if (!typeCn) continue;
      const pair = [rd.sourcePillar, rd.targetPillar].sort().join('|');
      const key = typeCn + pair; if (seen.has(key)) continue; seen.add(key);
      const status = rd.status === 'half-combination' ? '半合' : rd.status === 'partial-punishment' ? '刑而不全' : rd.status === 'binding' ? '合绊' : '';
      points.push(`${typeCn}${status ? '（' + status + '）' : ''}：${rd.sourcePillar} 与 ${rd.targetPillar}，${RELATION_NOTE[typeCn] ?? ''}。`);
      if (points.length >= 5) break;
    }
    add('刑冲克害批注', points);
  }

  // ⑧ 大运（当前所运 + 未来两步主题）
  {
    const gfs = n.greatFortunes ?? [];
    if (gfs.length) {
      const cur = gfs.find((g) => g.startYear <= nowYear && nowYear <= g.endYear);
      const upcoming = gfs.filter((g) => g.startYear > nowYear).slice(0, 2);
      const theme = (g: NonAiChart['greatFortunes'][number]) => `${g.ganZhi}运${g.tenGod ? '行' + g.tenGod + '之令' : ''}（${g.startYear}至${g.endYear}年）`;
      const points = [
        cur ? `现行${theme(cur)}，${cur.tenGod ? TEN_GOD_SEX[cur.tenGod] ?? '' : ''}` : '当前未落在已排大运区间内，可先重新计算排盘数据再补算',
        upcoming.length ? '此后运程：' + upcoming.map(theme).join('；') + '，行喜用之运则顺、行忌神之运则宜守。' : '',
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

/** 时段与本命之间的刑冲合害，逐条列出(优先取结构化 relationshipDetails，退取 relationships 串)。 */
function periodRelationPoints(period: FortunePeriod | NonAiChart['greatFortunes'][number]): string[] {
  const pts: string[] = [];
  const seen = new Set<string>();
  const details = ((period as FortunePeriod).relationshipDetails ?? []) as NonAiChart['relationshipDetails'];
  for (const rd of details) {
    if (rd.sourceLayer === 'natal' && rd.targetLayer === 'natal') continue;   // 只留「时段↔本命」之交
    const tc = RELATION_TYPE_CN[rd.type]; if (!tc) continue;
    const pair = [rd.sourcePillar, rd.targetPillar].sort().join('|'); const key = tc + pair; if (seen.has(key)) continue; seen.add(key);
    const st = rd.status === 'half-combination' ? '半合' : rd.status === 'partial-punishment' ? '刑而不全' : rd.status === 'binding' ? '合绊' : '';
    pts.push(`${tc}${st ? `（${st}）` : ''}：${rd.sourcePillar} 与 ${rd.targetPillar}，${RELATION_NOTE[tc] ?? ''}。`);
    if (pts.length >= 5) return pts;
  }
  if (!pts.length) {
    for (const [k, arr] of Object.entries(period.relationships ?? {})) {
      const tc = RELATION_TYPE_CN[k]; if (!tc) continue;
      for (const s of (arr ?? [])) { pts.push(`${tc}：${s.replace('与', ' 与 ')}，${RELATION_NOTE[tc] ?? ''}。`); if (pts.length >= 5) return pts; }
    }
  }
  return pts;
}

const VERDICT_WORD: Record<string, string> = { 加力: '加力（顺）', 减力: '减力（逆）', 并见: '喜忌并见（顺逆交参）' };
const TITLE_TAIL: Record<string, string> = { 加力: '进气', 减力: '当戒', 并见: '顺逆参半' };

function buildPeriodAnalysis(core: Core, period: FortunePeriod | NonAiChart['greatFortunes'][number] | undefined, scope: 'annual' | 'monthly' | 'decade'): BaziAIAnalysis | null {
  if (!period?.ganZhi) return null;
  const gz = period.ganZhi; const tenGod = period.tenGod ?? '';
  const { verdict, harmEl } = periodVerdict(gz, core);
  const scopeWord = scope === 'annual' ? '流年' : scope === 'monthly' ? '流月' : '大运';
  const weak = core.label === '身弱' || core.label === '中和偏弱';
  const dayPillar = core.n.pillars?.day ?? '';
  const spouseClash = (period.relationships?.chong ?? []).some((s) => s.includes(dayPillar));
  const blocks: Block[] = []; const add = blockAdd(blocks);

  const energyNote = verdict === '加力'
    ? `喜用${core.useful.join('、')}得助，${weak ? '元气得以培补' : '气象愈发流通'}，本期宜顺势而为`
    : verdict === '减力'
      ? `忌神${harmEl.join('、') || core.avoid.join('、')}当令，${ELEMENT_HEALTH[core.dayElement] ?? '身心'}易受牵制，本期宜守不宜攻`
      : `喜忌之神并至，吉凶随具体事类而分，须逐事权衡`;
  const tenGodSex = TEN_GOD_SEX[tenGod] ?? '';
  const tenGodCareer = TEN_GOD_CAREER[tenGod] ?? '';

  add('健康', [
    `本期${scopeWord}${gz}${tenGod ? '行' + tenGod + '之令' : ''}，相对本命为${VERDICT_WORD[verdict]}——${energyNote}。`,
    verdict === '减力' ? `${ELEMENT_HEALTH[core.dayElement] ?? '体质'}本季易显不足，作息宜规律、避免透支，情绪与睡眠尤须照看。` : `${ELEMENT_HEALTH[core.dayElement] ?? '体质'}得养，可借本期主动调理旧患、巩固根本。`,
  ]);
  add('事业', [
    tenGodCareer ? `${tenGod ? tenGod + '临期，' : ''}事业取向偏「${tenGodCareer}」，${tenGodSex}` : `${tenGodSex || '本期事业以守成为主。'}`,
    verdict === '加力' ? '气势顺遂，宜进取、可承接更重的责任或推进停滞之事。' : verdict === '减力' ? '宜低调守成、防小人口舌，忌冒进扩张或与人硬碰。' : '有可为亦有掣肘，抓稳关键环节、勿全面铺开。',
    spouseClash || (period.relationships?.chong ?? []).length ? '本期逢冲，主迁移、变动与拆合，凡涉及转岗、搬迁、合作聚散，宜早做预案、以静制动。' : '',
  ]);
  add('财运', [
    TEN_GOD_GROUP[tenGod] === '财' || TEN_GOD_GROUP[tenGod] === '食伤'
      ? (verdict === '加力' ? '财星得食伤相生、或财临喜用，本期财源活络，求财可进取，仍忌贪大。' : '财星虽动却犯忌，看似有机会，实则耗多进少，忌投机借贷。')
      : (verdict === '减力' ? '本期财星不显且忌神当令，以正职稳收为主，严控不必要开支。' : '财运平稳，量入为出、按计划推进即可。'),
    weak ? '身弱任财本不易，聚财宜借团队与长期置业，不宜单打独斗博快钱。' : '身旺能任财，进可图大利，惟防比劫分夺、账目须清。',
  ]);
  // 爱情：按「配偶星是否被本期引动」与「配偶宫(日支)是否逢冲」定性。
  {
    const spouseGroup = core.gender === 'female' ? '官杀' : '财';
    const spouseLabel = spouseGroup === '财' ? '妻星' : '夫星';
    const movedByPeriod = TEN_GOD_GROUP[tenGod] === spouseGroup;
    const loveLine = movedByPeriod
      ? (verdict === '加力' ? `本期${spouseLabel}被引动且向喜用，感情机会增多、利婚恋推进，单身者宜主动把握。` : `${spouseLabel}临忌被引动，感情易生波折，沟通须柔、忌逞强硬碰。`)
      : spouseClash ? '配偶宫逢冲，感情聚少离多或起变化，多包容体谅则无大碍。' : '感情宫位未受特别引动，以平常心维持既有关系即可。';
    add('爱情', [loveLine]);
  }
  add('刑冲克害批注', periodRelationPoints(period));

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
      nodePoints.push(`${a.year}年（${a.ganZhi}）：${why}${clash ? '，并与本命构成冲刑、根基受动' : ''}，属${tag}。建议：${advice}`);
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
