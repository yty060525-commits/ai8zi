/* =============================================================================
 * 本地离线批断引擎（「第四路」：不依赖任何云端大模型、不花额度、确定性、可复算）
 *
 * 定位：把已经由 nonAiCalculator 算定的「命盘事实」(日主/旺衰/格局/十神/五行/
 * 调候/神煞/大运/流年刑冲) 用一套命理断语库 + 规则命中，拼成结构化中文批断。
 * 它替大模型做「机械可枚举」的那部分(每柱十神义、格局总论、旺衰喜忌、调候、
 * 大运流年主题、神煞点缀)，让没配密钥/额度用尽时也有像样的批断；而把「多信号
 * 综合权衡、把事实织成因人而异的连贯白话」留给云端 AI。
 *
 * 设计约束(与仓库既有约定一致)：
 *  - 正文一律中文，不掺拉丁字母/字段名(见 elements.ts 的 sanitize 之争)；
 *  - 旺衰/喜忌按「扶抑」这一确定性口径给，调候只作辅助参考句，不并入主喜忌，
 *    与 nonAiCalculator 里「调候=辅助判据非硬喜用」的立场对齐；
 *  - 断不到的字段(老盘/瘦身盘缺 strengthScore、patternFacts 等)就跳过对应句，
 *    绝不为凑篇幅编造；
 *  - explanation 复用现有【主题】标记与 PointsView/复制管线，零改渲染层。
 * ========================================================================== */
import { STEMS, BRANCHES, ELEMENTS, stemElementIndex } from '../features/chart/elements';
import type { BaziRecord, NonAiChart } from '../types/domain';

export const LOCAL_ANALYSIS_ENGINE_VERSION = 'local-rules-v1';

/** 引擎可复算、无需外部输入的最小事实来源；缺排盘数据时上层据此禁用按钮。 */
export const canBuildLocalAnalysis = (record: BaziRecord): boolean => !!record.nonAiResult;

export interface LocalAnalysis {
  pattern: string;
  strength: string;
  usefulElements: string[];
  avoidElements: string[];
  explanation: string;      // 用【主题】标记的中文长文，直接喂 PointsView
  engineVersion: string;
  generatedAt: string;
}

// —— 十神五行关系：以日主在 ELEMENTS(木火土金水) 的下标为基准，模 5 位移 ——
const rel = (dayIdx: number, delta: number) => ELEMENTS[(dayIdx + delta) % 5];
// 比劫=同我(+0) 食伤=我生(+1) 财=我克(+2) 官杀=克我(+3) 印=生我(+4)
const GROUP_OFFSET: Record<string, number> = { 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 };

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
// 十神在格局上的「喜/忌」通义(《子平真诠》一路的常断，非硬结论)
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
  木: '肝胆、筋骨、情志疏泄', 火: '心与血脉、睡眠', 土: '脾胃、消化吸收',
  金: '肺与呼吸、皮肤、大肠', 水: '肾与泌尿、耳、骨与内分泌',
};
// 常见神煞点缀(只断有把握的几个；表外的名字只列不瞎解)
const SHENSHA_NOTE: Record<string, string> = {
  天乙贵人: '逢困有援、遇难呈祥，一生多贵人扶', 天德贵人: '心地慈善、能化凶为吉', 月德贵人: '处众能和、暗中小人少',
  文昌贵人: '利读书、考试、文字与名声', 驿马: '主奔波迁移、出行变动，动中求财求事', 桃花: '主人缘与异性缘，感情丰沛须专一',
  华盖: '孤高喜静、近艺术玄学宗教，精神世界丰', 将星: '有领导气象、能掌事服众', 羊刃: '刚烈果决，须防血光与性急坏事',
  劫煞: '防劫夺破财、意外之扰', 亡神: '防耗散、心事过重', 空亡: '所临之事易落空、宜务实不宜空想',
  金舆: '宜车马出行、生活体面', 天厨: '有口福、与饮食缘分厚',
};

const isStem = (s?: string) => !!s && STEMS.includes(s);
const isBranch = (b?: string) => !!b && BRANCHES.includes(b);

/** 由旺衰档位与「从格/专旺」特殊格局，按扶抑口径推喜/忌五行(确定性)。 */
function deriveUsefulAvoid(dayIdx: number, label?: string, special?: string): { useful: string[]; avoid: string[] } {
  const g = (group: string) => rel(dayIdx, GROUP_OFFSET[group]);
  const uniq = (arr: string[]) => [...new Set(arr)];
  if (special?.startsWith('从格')) {           // 从弱：弃命从财官食伤，顺势
    return { useful: uniq([g('财'), g('官杀'), g('食伤')]), avoid: uniq([g('印'), g('比劫')]) };
  }
  if (special?.startsWith('专旺')) {           // 从强/专旺：顺势帮身，忌克逆
    return { useful: uniq([g('比劫'), g('印'), g('食伤')]), avoid: uniq([g('官杀')]) };
  }
  if (label === '身强' || label === '中和偏旺') {  // 抑：克我、我克、我生皆为泄耗
    return { useful: uniq([g('食伤'), g('财'), g('官杀')]), avoid: uniq([g('印'), g('比劫')]) };
  }
  // 身弱 / 中和偏弱：生我、同我扶身
  return { useful: uniq([g('印'), g('比劫')]), avoid: uniq([g('财'), g('官杀'), g('食伤')]) };
}

const withPeriod = (s: string) => (s.endsWith('。') || s.endsWith('！') || s.endsWith('？') ? s : s + '。');

/** 主入口：由记录算出本地批断；无排盘数据返回 null。 */
export function buildLocalAnalysis(record: BaziRecord, now: Date = new Date()): LocalAnalysis | null {
  const n: NonAiChart | undefined = record.nonAiResult;
  if (!n?.pillars) return null;

  const dayStem = n.pillars.day?.[0];
  const dayBranch = n.pillars.day?.[1];
  const dayIdx = isStem(dayStem) ? stemElementIndex(dayStem!) : -1;
  const score = n.strengthScore;
  const pattern = n.patternFacts;
  const nowYear = now.getUTCFullYear();
  const { useful, avoid } = dayIdx >= 0 ? deriveUsefulAvoid(dayIdx, score?.label, pattern?.special) : { useful: [], avoid: [] };
  const sections: string[] = [];

  // ① 日主本命
  if (dayIdx >= 0) {
    const parts = [STEM_IMAGERY[dayStem!] ?? '日主' + dayStem + '，其性可依天干取象。'];
    if (score) parts.push(withPeriod(`以旺衰论，日主${score.label}（生扶 ${score.support}、克泄耗 ${score.drain}，指数 ${score.index}${score.inSeason ? '，得月令之气' : '，未得月令'}）`));
    if (isBranch(dayBranch)) parts.push(`日主坐${dayBranch}，十二长生属「${n.twelveLongevity?.[2] ?? '—'}」，为自身根气与配偶宫所在。`);
    sections.push('【本命·日主】' + parts.join(' '));
  }

  // ② 性格与十神（年/月/时透干十神）
  {
    const tg = (n.tenGods ?? []).map((t, i) => ({ t, i })).filter((x) => x.i !== 2 && x.t && x.t !== '日主');
    const lines = tg.map((x) => `${['年', '月', '日', '时'][x.i]}干${x.t}：${TEN_GOD_SEX[x.t] ?? ''}`.replace(/：$/, '')).filter((s) => !s.endsWith('：'));
    if (lines.length) sections.push('【性格与十神】' + lines.join(' '));
  }

  // ③ 格局与喜忌
  if (pattern) {
    const line = [`格局以${pattern.name}论，${TEN_GOD_PATTERN_NOTE[pattern.tenGod] ?? '取用须与旺衰扶抑合参。'}`];
    if (pattern.special) line.push(withPeriod('另注：' + pattern.special));
    sections.push('【格局】' + line.join(' '));
  }
  if (dayIdx >= 0 && (useful.length || avoid.length)) {
    sections.push('【喜忌·扶抑】' + `以${score?.label ?? '中和'}扶抑取用：喜${useful.join('、')}，忌${avoid.join('、')}。（此为本地按旺衰所推之参考，须与格局、调候合参。）`);
  }
  if (n.tiaohouFacts) sections.push('【调候参考】' + withPeriod(n.tiaohouFacts));

  // ④ 五行与偏枯
  {
    const ratio = n.elementRatio ?? {};
    const missing = ELEMENTS.filter((e) => (ratio[e] ?? 0) === 0);
    const strong = ELEMENTS.filter((e) => (ratio[e] ?? 0) >= 0.375);
    const seg: string[] = [];
    if (missing.length) seg.push(`命局缺${missing.join('、')}，${missing.map((e) => ELEMENT_HEALTH[e]).join('；')}方面尤宜留意`);
    if (strong.length) seg.push(`${strong.join('、')}偏旺，其性易过而失中`);
    if (seg.length) sections.push('【五行与调养】' + seg.join('。') + '。');
  }

  // ⑤ 事业 / 财运 / 情感 / 健康（按主导十神 + 财官印的五行落点）
  {
    const leadGod = (n.tenGods ?? [])[1] ?? (n.tenGods ?? [])[0];   // 月干为主，退取年干
    if (leadGod && TEN_GOD_CAREER[leadGod]) sections.push('【事业】' + `月令透出${leadGod}，事业取向偏「${TEN_GOD_CAREER[leadGod]}」；` + (useful.length ? `行运逢${useful.join('、')}之方较能借力。` : ''));
    const wealth = dayIdx >= 0 ? [rel(dayIdx, GROUP_OFFSET['财']), rel(dayIdx, GROUP_OFFSET['食伤'])] : [];
    if (wealth.length) sections.push('【财运】' + `财为我克，本命财星五行属${rel(dayIdx, GROUP_OFFSET['财'])}${(n.tenGods ?? []).includes('偏财') ? '，偏财透干，格局大开大合、活络善经营' : '，正财为多，宜勤俭累积'}；食伤（${rel(dayIdx, GROUP_OFFSET['食伤'])}）可生财，以才艺专业变现是通途。`);
  }
  {
    // 配偶宫：日支本气十神
    const spHouseGod = n.tenGodDetails?.hidden?.[2]?.[0]?.tenGod;
    const spouseNote = record.gender === 'female'
      ? (dayIdx >= 0 && isBranch(dayBranch) ? `女命以官杀为夫星，五行属${rel(dayIdx, GROUP_OFFSET['官杀'])}${(n.tenGods ?? []).includes('正官') ? '，正官透干，配偶端正、宜明媒正娶之缘' : ''}。` : '')
      : (dayIdx >= 0 ? `男命以财为妻星，五行属${rel(dayIdx, GROUP_OFFSET['财'])}${(n.tenGods ?? []).includes('偏财') ? '，偏财透干，异性缘旺、感情选择多须专一' : '，正财为主，配偶务实顾家'}。` : '');
    const houseNote = spHouseGod ? `日支（配偶宫）藏本气为${spHouseGod}，${TEN_GOD_SEX[spHouseGod] ?? ''}` : '';
    const love = [spouseNote, houseNote].filter(Boolean).join(' ');
    if (love) sections.push('【情感·六亲】' + love);
  }
  {
    const healthBase = dayIdx >= 0 ? ELEMENT_HEALTH[ELEMENTS[dayIdx]] : '';
    const ratio = n.elementRatio ?? {};
    const missing = ELEMENTS.filter((e) => (ratio[e] ?? 0) === 0).map((e) => ELEMENT_HEALTH[e]);
    const health = ['以日主五行，' + healthBase + '为先天较弱处，宜养' + '。', missing.length ? '所缺五行关联：' + missing.join('；') + '。' : ''].join('');
    if (healthBase) sections.push('【健康】' + health);
  }

  // ⑥ 大运（当前所运 + 未来两步主题）
  {
    const gfs = n.greatFortunes ?? [];
    if (gfs.length) {
      const cur = gfs.find((g) => g.startYear <= nowYear && nowYear <= g.endYear);
      const upcoming = gfs.filter((g) => g.startYear > nowYear).slice(0, 2);
      const theme = (g: NonAiChart['greatFortunes'][number]) => `${g.ganZhi}运${g.tenGod ? '行' + g.tenGod + '之令，' + (TEN_GOD_SEX[g.tenGod] ?? '') : ''}（${g.startYear}-${g.endYear}）`;
      const seg = [cur ? `现行${theme(cur)}` : '当前未在已排大运区间内（老盘可先点上方重新计算排盘数据再补算）', upcoming.length ? '此后：' + upcoming.map(theme).join('；') : ''].filter(Boolean).join('。') + '。';
      sections.push('【大运】' + seg);
    }
  }

  // ⑦ 未来流年提点（取从现在起的五年）
  {
    const yrs = (n.annualFortunes ?? []).filter((a) => a.year >= nowYear).slice(0, 5);
    if (yrs.length) {
      const lines = yrs.map((a) => {
        const clash = a.relationships?.chong?.length ? '逢冲，主动荡、迁移、变局' : '';
        const combine = a.relationships?.sanHe?.length || a.relationships?.liuHe?.length ? '遇合，主结缘、协作、可成事' : '';
        const note = [clash, combine].filter(Boolean).join('、') || '气运平稳，按部就班';
        return `${a.year}年${a.ganZhi}${a.tenGod ? '行' + a.tenGod : ''}：${note}`;
      });
      sections.push('【未来流年提点】' + lines.join('。') + '。');
    }
  }

  // ⑧ 神煞点缀
  {
    const ausp = (n.shenSha?.auspicious ?? []).filter(Boolean);
    const inau = (n.shenSha?.inauspicious ?? []).filter(Boolean);
    const one = (name: string) => SHENSHA_NOTE[name] ? `${name}（${SHENSHA_NOTE[name]}）` : name;
    const seg: string[] = [];
    if (ausp.length) seg.push('吉神：' + ausp.map(one).join('、'));
    if (inau.length) seg.push('凶煞：' + inau.map(one).join('、'));
    if (seg.length) sections.push('【神煞点缀】' + seg.join('；') + '。（神煞为辅助参考，非决断。）');
  }

  // ⑨ 结语 + 免责
  {
    const tail = [`骨重${n.chenggu?.totalText ?? '—'}（袁天罡称骨，旧说仅供参考）。`,
      '以上为本地规则引擎就命盘事实所作之批断，重在机械可枚举的部分，供参考与兜底；涉及多因素权衡与因人而异的综合细断，建议再以云端分析复核。'];
    sections.push('【结语】' + tail.join(''));
  }

  return {
    pattern: pattern?.name ?? '—',
    strength: score?.label ?? '—',
    usefulElements: useful,
    avoidElements: avoid,
    explanation: sections.join('\n'),
    engineVersion: LOCAL_ANALYSIS_ENGINE_VERSION,
    generatedAt: now.toISOString(),
  };
}
