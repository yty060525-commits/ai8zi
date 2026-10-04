import { useEffect, useRef, useState } from 'react';
import { deleteBaziRecord, getBaziRecord, refreshRecord, saveBaziRecord } from '../../data/clientRepository';
import { ABORTED_MESSAGE, analysisHorizon, buildBaziTasks, expectedTaskIds, isRetryableFailure, orchestrateBaziAnalysis, DEFAULT_TONE } from '../../data/baziOrchestrator';
import { readableChannelError, readableName } from '../../data/chatEngine';
import { beginAiSession, cancelAiSession } from '../../data/deepseekAdapter';
import { clearChartCache } from '../../data/storageInfo';
import { sanitizeAnalysisText } from '../chart/elements';
import { isServerMode } from '../../data/serverClient';
import type { BaziRecord, BaziTaskResult, NonAiChart } from '../../types/domain';
import { interpersonalZodiac, zodiacOfBranch } from '../../utils/interpersonal';
import { chinaDateParts, chinaYmd, chinaYear } from '../../utils/date';

export interface PersonDetailProps { personId: string; onBack: () => void; refreshKey?: number }
const copy = (text: string) => navigator.clipboard?.writeText(text);

const statusText: Record<BaziRecord['aiStatus'], string> = {
  not_started: '未开始', pending: '分析中', completed: '已完成', failed: '分析失败', not_configured: '未配置',
};

/** 界面上的计数一律读成中文：「共二十六项」「未来第三年」里的阿拉伯数字与括号，
 *  在正式版口径下和英文字段名一样属于算法痕迹。超过二十就退回逐位读。
 *  词表与读法在 shared/chineseReadAloud —— 原先这里、RecordsPage、SettingsPage 各抄一份，
 *  三份互不相干就会分叉(同一屏里「已配置 零 条」与「已配置零条」混着出现就是这么来的)。 */
import { cnCount, cnYear } from '../../shared/chineseReadAloud';

/** 范围标题的两种写法：屏幕上的 <summary> 用带年份的这一套(④栏的大运区间是既有判据，
   不能凭空改口径)，「复制/导出」拼进文档的那一行则一律走 sanitizeCopyLine。
   两边都不写括号、斜杠、间隔号 —— 正式版口径下这些半角符号与英文字段名一样属于算法痕迹。 */
const scopeLabel = (result: BaziTaskResult): string => {
  const task = result.task;
  switch (task.type) {
    case 'baseline': return '本命命局、身强身弱、格局、喜忌';
    case 'overview': return '全盘总结、值得关注的时间节点';
    case 'adjustment': return '后天调整与职业适配、按喜用五行';
    case 'annual': return task.year === undefined ? '流年' : `${cnYear(task.year)}年流年`;
    case 'monthly': return task.year === undefined ? '流月' : (task.month === undefined ? `${cnYear(task.year)}年` : `${cnYear(task.year)}年${cnCount(task.month)}月`);
    case 'synthesis': return '最终总结';
    default: return task.type;
  }
};
/** 附加元信息：目标时段的干支与年龄 —— 正对应“每个任务只换日子干支和年龄”。
 *  窗口起点与 AI 分析用同一口径(从今天算，未来建的盘才按建盘时间)，否则标题写「未来十年」、内容却是旧年份。 */
const horizonOf = (record: BaziRecord) => {
  const h = analysisHorizon(record);
  return { from: h.year, to: h.year + 9 };
};

/** 找到任务对应的大运段：优先用任务自带的内联行(最新且权威)，再按 startYear 精确匹配，最后按年份落区间兜底。
 *  兜底是为了存量记录：它们的大运任务存的是旧口径(大运对齐公历十年边界)得到的年份，
 *  与现在按起运排定的区间常不重合。取最近一段只保证标题有干支可显示，不代表区间正确 ——
 *  要拿到本人真实的大运，需在详情页重算非 AI。 */
export const findDecade = (record: BaziRecord, task: { year?: number; decade?: { ganZhi: string; startYear: number; endYear: number } }) => {
  if (task.decade?.ganZhi) return task.decade;
  const list = record.nonAiResult?.greatFortunes ?? [];
  const y = task.year;
  if (y === undefined) return undefined;
  const exact = list.find((item) => item.startYear === y) ?? list.find((item) => item.startYear <= y && y <= item.endYear);
  if (exact) return exact;
  // 旧记录的年份可能因原「起运年龄推算」而偏移一两年；取起点最接近的一段，保证标题仍有干支
  if (!list.length) return undefined;
  return list.reduce((best, item) => Math.abs(item.startYear - y) < Math.abs(best.startYear - y) ? item : best, list[0]);
};

/** 大运展示段：标题叫「大运段」，起止只显这一运与「未来十年」窗口的交集。
 *  窗口 2026-2035 会被连续的两运盖住：当前运(如本运走到 2033)显 2026-2033，
 *  下一运戊申 2033-2042 显 2033-2035 —— 后七年还没轮到，不占这段。
 *  终点一律取这一运的真实 endYear，不往「起点+9」抬：抬上去会把标题盖到正文没谈过的年份上。
 *  整段在窗口之外(存量记录里还留着已走完的运)退回它的真实整段 —— 两端都往窗口内抬会渲染出
 *  「丙戌 大运段(2035-2035)」这种把一运截成单一年份的假十年。 */
export const decadeSegment = (task: { year?: number; decade?: { ganZhi: string; startYear: number; endYear: number } }, record: BaziRecord): { start: number; end: number } => {
  const horizon = horizonOf(record);
  const decade = findDecade(record, task);
  const rawStart = decade?.startYear ?? task.year ?? horizon.from;
  const rawEnd = decade?.endYear ?? rawStart;
  const intersects = rawStart <= horizon.to && rawEnd >= horizon.from;
  if (!intersects) return { start: rawStart, end: rawEnd };
  return { start: Math.max(rawStart, horizon.from), end: Math.min(rawEnd, horizon.to) };
};

/** 大运标题：干支 + 时段，如「庚子、大运段、二零二零至二零二九」。不显示年龄推算。
 *  区间翻成中文读法(逐位)，复制路径再按同一份 sanitizeCopyLine 走一遍，结果一致。
 *  分隔一律用顿号，不留半角空格 —— 闸门会把「汉字+空格+汉字」收成顿号，这里就按同一形态写。 */
const decadeHeading = (result: BaziTaskResult, record: BaziRecord): string => {
  const seg = decadeSegment(result.task, record);
  const name = findDecade(record, result.task)?.ganZhi ?? '';
  const span = `${cnYear(seg.start)}至${cnYear(seg.end)}`;
  return name ? `${name}、大运段、${span}` : `大运段、${span}`;
};

const fortuneMeta = (result: BaziTaskResult, record: BaziRecord): string => {
  const task = result.task;
  const nonAi = record.nonAiResult;
  const age = task.year !== undefined && record.birthYear ? `年龄约${cnCount(task.year - record.birthYear)}岁` : '';
  let ganZhi = '';
  if (task.type === 'annual' && nonAi) {
    ganZhi = task.annual?.ganZhi ?? nonAi.annualFortunes.find((item) => item.year === task.year)?.ganZhi ?? '';
  } else if (task.type === 'monthly') {
    ganZhi = task.monthly?.ganZhi ?? (nonAi ? nonAi.monthlyFortunes.find((item) => item.year === task.year && item.month === task.month)?.ganZhi ?? '' : '');
  }
  return [ganZhi, age].filter(Boolean).join('，');
};
const describeScope = (result: BaziTaskResult, record: BaziRecord): string => {
  const task = result.task;
  if (task.type === 'decade') return decadeHeading(result, record);
  const meta = fortuneMeta(result, record);
  return scopeLabel(result) + (meta ? '，' + meta : '');
};

/* 分组标题就是分组名，别再复述「这一组里有哪些维度」：勾选维度时复制结果会按筛选走，
   标题却把五个维度全列一遍(「本命：格局喜忌与健康、事业、财运、爱情」)，于是只勾健康也会
   在文档里看到「爱情」二字，读起来像筛选没生效。小节名下面各条已经逐行写了，这里不重复。 */
const scopeGroups: Array<{ key: BaziTaskResult['task']['type']; title: string }> = [
  { key: 'baseline', title: '本命' },
  { key: 'overview', title: '全盘总结与值得关注的时间节点' },
  { key: 'adjustment', title: '后天调整与职业适配' },
  { key: 'decade', title: '未来大运' },
  { key: 'annual', title: '未来十年每年流年' },
  { key: 'monthly', title: '从今天起未来十二个月' },
];

/* ---------------- 语气滑杆(犀利 ↔ 中立 ↔ 温柔夸夸，默认 80) ---------------- */
const TONE_KEY = 'mingli.analysis.tone';
const clampTone = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const readLocalTone = (key: string): number | undefined => { try { const raw = localStorage.getItem(key); if (raw === null || raw.trim() === '') return undefined; const v = Number(raw); return Number.isFinite(v) ? clampTone(v) : undefined; } catch { return undefined; } };
const writeLocalTone = (key: string, v: number) => { try { localStorage.setItem(key, String(clampTone(v))); } catch { /* 忽略 */ } };
/* 语气是「本机 · 按盘」的偏好，绝不写进 record：record 会随同步上行服务器、再下发到别的设备，
   一旦把语气塞进 record，这边给人甲调低语气，别人（或另一台设备）打开同一条盘也跟着变低。
   两个本地键：pref.<id> = 用户为这条盘在滑杆上选定的值；ran.<id> = 这条盘上次真正生成时用的值(重跑判定用)。 */
const prefKey = (rec: string) => TONE_KEY + '.' + rec;
const ranKey = (rec: string) => TONE_KEY + '.' + rec + '.ran';
export const readTone = (): number => readLocalTone(TONE_KEY) ?? DEFAULT_TONE;          // 全局默认：新盘 / 无作用域时的回退
export const saveTone = (v: number) => writeLocalTone(TONE_KEY, v);
export const recordTone = (rec: string | null | undefined): number => (rec ? readLocalTone(prefKey(rec)) ?? readLocalTone(ranKey(rec)) : undefined) ?? readTone();   // 这条盘的滑杆读数：本机选过 → 本机上次跑 → 全局默认，始终与 record.toneUsed 无关
export const saveRecordTone = (rec: string | null | undefined, v: number) => { if (rec) writeLocalTone(prefKey(rec), v); };
export const usedTone = (rec: string | null | undefined): number | undefined => (rec ? readLocalTone(ranKey(rec)) : undefined);
export const markUsedTone = (rec: string | null | undefined, v: number) => { if (rec) writeLocalTone(ranKey(rec), v); };
export const toneLabel = (v: number): string => {
  if (v <= 5) return '犀利直白：明显说出不好之处';
  if (v < 45) return '偏犀利：直接点出问题与风险';
  if (v <= 55) return '中立：好坏如实平衡说明';
  if (v <= 90) return '温和：八成好话，两成委婉点不足';
  return '温柔夸夸：多说好话，不足委婉带过';
};

const getBasicFields = (record: BaziRecord): [string, string][] => [
  ['姓名', readableName(record.name)], ['性别', record.gender === 'male' ? '男' : '女'],
  // 出生年/月读成中文：这条数组既铺在「基础信息」表上，也是「复制基础信息」的正文来源。
  ['出生年', cnYear(record.birthYear)], ['出生月', cnCount(record.birthMonth)],
  ['年柱', record.yearPillar], ['月柱', record.monthPillar], ['日柱', record.dayPillar], ['时柱', record.hourPillar],
];
export function generatePersonDetailText(record: BaziRecord) {
  return getBasicFields(record).map(([label, value]) => `${label}：${value}`).join('\n');
}
function BasicInfo({ record }: { record: BaziRecord }) {
  return <section className="detail-section" aria-labelledby="basic-title" aria-label="基础信息">
    <div className="section-heading"><div><p className="eyebrow">壹、基础信息</p><h2 id="basic-title">基础信息</h2></div><button className="text-button" type="button" onClick={() => void copy(generatePersonDetailText(record))}>复制基础信息</button></div>
    <dl className="info-grid">{getBasicFields(record).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}
/** 列表读法：内层用「、」并列，外层用中文分号分隔。界面与导出都不许出现半角符号，
 *  所以这里不用中点当分隔符；空值统一读成「暂无」，不留破折号占位。 */
const listText = (value: string[] | string[][]) => value.map((item) => Array.isArray(item) ? item.join('、') : item).join('；') || '暂无';
/** 今天(或指定时刻)落在哪一步大运：优先按精确交运周年区间 onsetDate~endDate 裁决，
 *  老记录无该字段才退回整数年 startYear≤今≤endYear。抽成一处，起运文案与大运表共用，
 *  避免两处各写一份判据而漂移。 */
export const findCurrentFortune = (result: NonAiChart, nowYear: number, todayYmd: string): NonAiChart['greatFortunes'][number] | undefined => {
  const list = result.greatFortunes ?? [];
  if (list.some((g) => g.onsetDate && g.endDate)) return list.find((g) => g.onsetDate && g.endDate && g.onsetDate <= todayYmd && todayYmd <= g.endDate);
  return list.find((g) => g.startYear <= nowYear && nowYear <= g.endYear);
};

/** 起运文案：几岁起运 + 当前正走哪一运。老记录没算过起运时如实说「未记录」，
 *  引导去点「重新排盘」，而不是悄悄沿用旧的十年边界对齐结果。
 *  nowYear 只在大运段没有 onsetDate/endDate 的存量记录里才用到；调用方一律传北京口径的年，
 *  否则跨年那一刻(UTC 16:00 之后)整数年回退会用设备本地年，与同页大运表差一柱。 */
export const luckStartText = (result: NonAiChart, nowYear: number): string => {
  const start = result.luckStart;
  if (!start?.date) return '未记录，点下方重新排盘可补算';
  /* 「今年在哪步运」按真实交运日(onsetDate，首步交运日 + 10k 周年)裁决，而不是整数年区间。
     大运段的十年展示(startYear/endYear)仍与库 getDaYun 同源不动；但交运日几乎不在 1/1，
     用「startYear ≤ 今 ≤ endYear」判当前运会让整条段相对真太阳历前漂近一年(实测约 4% 的人
     报错一柱)。老记录无 onsetDate 时退回整数年区间，至少不丢这一句。 */
  const todayYmd = chinaYmd(new Date());
  const current = findCurrentFortune(result, nowYear, todayYmd);
  const age = `${cnCount(start.years)}岁${start.months ? cnCount(start.months) + '个月' : ''}`;
  /* 交运日优先用引擎自算的 luckOnset(与库逐日一致且口径可控)，老记录没这个字段才退回库值。 */
  const onset = result.luckOnset || start.date;
  return `约${age}、${cnDate(onset)}交运${current ? `；今年在${current.ganZhi}运，${cnYear(current.startYear)}至${cnYear(current.endYear)}` : '；当前已出排定的大运区间'}`;
};
/** 界面上的日期读法：「1984-02-06」→「一九八四年二月六日」。年份逐位、月日按中文数读，
 *  与闸门里数字的读法同规则；解析不出 ISO 形态就原样返回(存量数据里有只到月份的)。 */
export const cnDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(String(iso ?? '').trim());
  if (!m) return String(iso ?? '');
  return `${cnYear(+m[1])}年${cnCount(+m[2])}月${m[3] ? cnCount(+m[3]) + '日' : ''}`;
};
const mapText = (value: Record<string, number>) => Object.entries(value).map(([key, count]) => `${key}${cnCount(count)}`).join('、') || '暂无';
/** 五行比例按百分比展示(原始值是 0~1 的小数，直接打出来是 0.375 这种看不懂的数)。
 *  分母是实际观测数(四干 + 四支本气 = 8)，为 0 时不硬凑百分比。
 *  空格点名的五行补一句「缺X」，这是读盘最关心的一句话，不该让用户自己去数。
 *  百分比读成中文(三成七半)，界面与导出都不留 % 与阿拉伯数字。
 *  导出以便测试直接锁住文案(组件本身依赖太多上下文，不适合为这一行单独渲染)。 */
export const formatElementRatio = (value: Record<string, number>) => {
  if (!value || !Object.values(value).reduce((a, b) => a + b, 0)) return '暂无';
  const shown = Object.entries(value).map(([key, ratio]) => `${key}${cnPercent(ratio)}`);
  const missing = Object.entries(value).filter(([, ratio]) => ratio === 0).map(([key]) => key);
  return shown.join('、') + (missing.length ? `，缺${missing.join('、')}` : '');
};
/** 小数比例 → 中文成数：一成 = 10%，一厘 = 1%。0.375 → 三成七厘五(四舍五入到厘)。 */
const cnPercent = (ratio: number): string => {
  const liTotal = Math.round(ratio * 100);
  if (liTotal === 0) return '〇';
  const cheng = Math.floor(liTotal / 10);
  const li = liTotal % 10;
  return (cheng > 0 ? cnCount(cheng) + '成' : '') + (li > 0 ? cnCount(li) + '厘' : '');
};
/** 公历日期读法。排盘定位到的 solarDate 可能比命主实际生日早一天（晚子时换日：23 点后日柱进一，
 *  人仍生在前一天），所以有真实 birthDay 时以它为准；手录四柱的老记录没有这一栏才退回 solarDate。 */
const solarDateText = (result: NonAiChart, record: BaziRecord): string => {
  const ymd = /^(\d{4})-(\d{1,2})-\d{1,2}$/.exec(String(result.solarDate ?? '').trim());
  if (ymd && typeof result.birthDay === 'number') return cnDate(`${ymd[1]}-${ymd[2]}-${result.birthDay}`);
  return cnDate(result.solarDate);
};
function NonAiAnalysis({ result, record }: { result?: NonAiChart; record: BaziRecord }) {
  if (!result) return <section className="detail-section" aria-label="基础排盘数据"><div className="section-heading"><div><p className="eyebrow">贰、排盘数据</p><h2>基础排盘数据</h2></div></div><p role="status">暂无基础排盘数据</p></section>;
  const fields: [string, string][] = [
    ['四柱', [result.pillars.year, result.pillars.month, result.pillars.day, result.pillars.hour].join('、')],
    ['公历日期', solarDateText(result, record)],
    ['五行', mapText(result.elements)], ['五行比例', formatElementRatio(result.elementRatio)],
    ['日主', result.dayMaster], ['十二长生', listText(result.twelveLongevity)],
    ['起运', luckStartText(result, chinaYear(new Date()))],
    ['袁天罡称骨', result.chenggu ? `${result.chenggu.totalText}，年${result.chenggu.parts.year}、月${result.chenggu.parts.month}、日${result.chenggu.parts.day}、时${result.chenggu.parts.hour}` : '暂无'],
  ];
  const columns: [string, string][] = [['四柱', fields[0][1]], ['藏干', listText(result.hiddenStems)], ['藏干十神', result.tenGodDetails.hidden.map((items) => items.map((item) => `${item.stem}${item.tenGod}`).join('、')).join('；') || '暂无'], ['十神', listText(result.tenGods)], ['纳音', listText(result.naYin)]];
  const relationLabels: Array<[keyof NonAiChart['relationships'], string]> = [['sanHe', '三合'], ['liuHe', '六合'], ['xing', '刑'], ['chong', '冲'], ['po', '破'], ['hai', '害'], ['ke', '克']];
  /* 完整大运表：把九步运的干支、十年区间、精确交运日全部列出，并高亮「今年所在」那一柱。
     AI 分析区的「④未来大运」只排起运晚于今年的运(避免整轮重算)，于是眼前正在走的那步运在
     那里看不到——这张表补的就是这一格，且它读的是本地排盘数据、不触发任何 AI 请求。 */
  const today0 = chinaDateParts(new Date()); const todayYmd0 = `${today0.year}-${String(today0.month).padStart(2, '0')}-${String(today0.day).padStart(2, '0')}`;
  const currentGz = findCurrentFortune(result, today0.year, todayYmd0)?.ganZhi;
  const luckRows = result.greatFortunes ?? [];
  const yb = record.yearPillar?.[1] ?? '';
  const zs = yb && '子丑寅卯辰巳午未申酉戌亥'.includes(yb) ? interpersonalZodiac(yb) : null;
  const selfZodiac = yb ? zodiacOfBranch(yb) : '';
  return <section className="detail-section" aria-label="基础排盘数据"><div className="section-heading"><div><p className="eyebrow">贰、排盘数据</p><h2>基础排盘数据</h2></div></div><dl className="info-grid chart-data-grid">{fields.slice(1).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="chart-columns">{columns.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</div><section className="subsection" aria-label="大运"><h3>大运</h3><table className="luck-table"><thead><tr><th>大运</th><th>起运年</th><th>区间</th><th>交运日</th></tr></thead><tbody>{luckRows.map((g) => <tr key={g.ganZhi + g.startYear} className={g.ganZhi === currentGz ? 'luck-current' : undefined}><td>{g.ganZhi}{g.ganZhi === currentGz ? '行' : ''}</td><td>{cnYear(g.startYear)}</td><td>{cnYear(g.startYear)}至{cnYear(g.endYear)}</td><td>{g.onsetDate && g.endDate ? `${cnDate(g.onsetDate)}至${cnDate(g.endDate)}` : '暂无'}</td></tr>)}</tbody></table></section><section className="subsection" aria-label="生肖关系"><h3>生肖关系</h3><p>本命生肖：{zodiacOfBranch(record.yearPillar?.[1] ?? '')}，年支{record.yearPillar[1]}</p>
      {zs && <p>人际适配：我属{selfZodiac}，三合{zs.sanHe.join('、')}，六合{zs.liuHe.join('、')}，六冲{zs.chong.join('、')}，六害{zs.hai.join('、')}。生肖人际参考，非决断</p>}<ul>{relationLabels.map(([key, label]) => <li key={key}><strong>{label}</strong>：{result.relationships[key].join('、') || '暂无'}</li>)}</ul></section></section>;
}
/** 失败原因先抹掉凭据痕迹，再整句过中文闸门：模型报错常带英文句子、半角括号与斜杠，
 *  直接铺到界面上就违反「输出只能中文、不留算法痕迹」的正式版口径。闸门判空时退回一句
 *  固定中文，宁可少说细节也不把脏串留在页面上。
 *  HTTP 状态码是这一条链路上唯一值得留下的技术读数，逐位读成「五零三」而不是「五百零三」，
 *  也不是留着「HTTP 503」这种写法 —— 读法与聊天那条链路共用 chatEngine 那一份实现。 */
const safeAiError = (error: string): string => readableChannelError(error) || '模型或网络返回了无法显示的异常，请稍后再试或改用其他通道。';

/* ---------------- 复制筛选（范围 x 维度） ---------------- */
const DIM_KEYS = ['chong', 'health', 'love', 'career', 'wealth'] as const;
export type DimKey = (typeof DIM_KEYS)[number];
const DIMS: Array<{ key: DimKey; label: string; markers: string[] }> = [
  { key: 'chong', label: '刑冲破害', markers: ['刑冲克害批注'] },
  { key: 'health', label: '健康', markers: ['健康'] },
  { key: 'love', label: '爱情', markers: ['爱情'] },
  { key: 'career', label: '事业', markers: ['事业'] },
  { key: 'wealth', label: '财运', markers: ['财运'] },
];

interface Section { head: string; body: string }
/** 按【...】标记把正文切成带标题的段落（标记本身从正文里剥掉，输出时原样还原）。
 *  闸门清洗后的正文仍带着这对括号：纯中文闸门只放行汉字与中文句读，因此小节名是
 *  「翻回括号写法」而不是删掉括号(见 shared/chineseGate.ts normalizeStructure)。 */
export function splitSections(text: string): Section[] {
  const re = /【([^】]{1,16})】/g;
  const sections: Section[] = [];
  let cursor = 0;
  let last: Section | null = null;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (last) { last.body += text.slice(cursor, m.index); }
    else { const lead = text.slice(cursor, m.index).trim(); if (lead) sections.push({ head: '', body: lead }); }
    const section: Section = { head: m[1], body: '' };
    sections.push(section);
    last = section;
    cursor = re.lastIndex;
  }
  const tail = text.slice(cursor);
  if (last) { last.body += tail; }
  else { const lead = tail.trim(); if (lead) sections.push({ head: '', body: lead }); }
  return sections.map((s) => ({ ...s, body: s.body.trim() })).filter((s) => s.body.length > 0 || !!s.head);
}
const markerOf = (dim: DimKey, head: string): boolean => (DIMS.find((d) => d.key === dim)?.markers ?? []).some((marker) => head.includes(marker));
const hasAnyMarker = (text: string) => /【[^】]{1,16}】/.test(text);

/** 挑选某篇正文中属于勾选维度的段落；全选(null)时返回全部段落。 */
export function pickDimensionSections(text: string, selected: DimKey[] | null): Section[] {
  const sections = splitSections(text);
  if (!selected) return sections;
  const matched = sections.filter((s) => selected.some((dim) => markerOf(dim, s.head)));
  // 老数据可能没有【】标记：仅当全选时才整体带出，避免用户误以为内容丢失
  if (matched.length === 0 && !hasAnyMarker(text)) return sections.length === 0 ? [] : selected.length === DIMS.length ? sections : [];
  return matched;
}

export interface PointBlock { head: string; points: string[] }
/** 已自带编号/圆点的一行保持原样；普通长句按 。；！？ 断成若干条。
 *  编号形态必须同时认「1.」和闸门翻出来的中文序号「一、」：正文进到这里前一律过了中文闸门
 *  (见 shared/chineseGate.ts 的 normalizeStructure)，阿拉伯编号在闸门里就成了中文序号。
 *  原先这条正则只写了 d+(没有 \\d)、又要求符号后跟空格，两种形态一个都认不出，于是整行被当
 *  普通长句按句号拆开，再由 pointBodyText 冠上「一、二、」——导出文档里就是「一、一、」。 */
const ALREADY_INDEXED = /^(?:[0-9０-９]+[.、．]|[•·-—]|[一-鿿]{1,3}[、])/;
function bulletize(line: string): string[] {
  if (ALREADY_INDEXED.test(line)) return [line];
  const sentences = line.split(/(?<=[。；!?！？])\s*/).map((s) => s.trim()).filter((s) => s.length > 1);
  return sentences.length > 0 ? sentences : (line ? [line] : []);
}
/** 全文“分点化”：每个小节一行标题，其下每句一条，能分点的全部拆开。
 *  屏幕上不再显示符号式项目符与括号标记(正式版口径：可见文案只留汉字与中文句读)，
 *  所以这里把行首残留的「•」「·」当成分点起点剥掉、小节名只留文字，交给排版层重新编号。 */
export function toPointBlocks(text: string): PointBlock[] {
  const blocks: PointBlock[] = [];
  let current: PointBlock | null = null;
  const pushCurrent = () => { if (current && (current.head || current.points.length > 0)) blocks.push(current); };
  for (const rawLine of (text || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim().replace(/^[•·]+\s*/, '');
    if (!line) continue;
    const marker = line.match(/^【([^】]{1,16})】/);
    if (marker) {
      pushCurrent();
      current = { head: marker[1], points: [] };
      const rest = line.slice(marker[0].length).trim();
      if (rest) current.points.push(...bulletize(rest));
    } else {
      if (!current) { current = { head: '', points: [] }; }
      current.points.push(...bulletize(line));
    }
  }
  pushCurrent();
  return blocks;
}
/** 屏幕/复制共用的“分点正文”排版：标题行 + 每条一行，条目一律冠中文序号「一、二、」。
 *  屏幕上不再放「•」这类符号项目符号 —— 正式版口径下可见文案只留汉字与中文句读，
 *  符号式项目符与英文字段名同级；复制到文档里走同一份排版，两条路不会再分叉。 */
const CN_BULLETS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
/** 条目行自己已经带编号(「一、」「1.」)时不再冠名，否则 pointBodyText 会拼成「一、一、」。 */
const hasOwnIndex = (point: string) => ALREADY_INDEXED.test(point);
export function pointBodyText(blocks: PointBlock[], marker?: 'bullet' | 'ordinal'): string {
  return blocks.map((block) => {
    const head = block.head ? block.head + '\n' : '';
    let n = 0;
    return head + block.points.map((point) => {
      if (hasOwnIndex(point)) return point;
      const label = (CN_BULLETS[n] ?? String(n + 1)) + '、';
      n += 1;
      // 复制出去的是纯文本，条目要自己带序号；屏幕上的列表由 CSS 负责编号，不能再拼一层。
      return marker === 'ordinal' ? label + point : point;
    }).join('\n');
  }).join('\n\n');
}

/** 复制正文排版：标题行 + 分点条目(中文序号) + 段落间空行，方便检索/定位。
 *  与展示同理，「先读后洗」：旧记录里存的照抄字段也在这里被清掉，复制出去的不带英文。 */
export function formatCopyBody(analysis: NonNullable<BaziTaskResult['analysis']>, selected: DimKey[] | null, keepWholeText = false): string {
  const blocks: string[] = [];
  if (selected === null && analysis.title) blocks.push('标题：' + sanitizeAnalysisText(analysis.title));
  if (analysis.pattern && selected === null && !analysis.explanation) {
    const elements = (list?: string[]) => (list ?? []).map((item) => sanitizeAnalysisText(item)).filter(Boolean).join('、') || '暂无';
    blocks.push('格局：' + (sanitizeAnalysisText(analysis.pattern) || '暂无') + '，强弱：' + (sanitizeAnalysisText(analysis.strength || '') || '暂无') + '，喜：' + elements(analysis.usefulElements) + '，忌：' + elements(analysis.avoidElements));
  }
  const text = sanitizeAnalysisText(analysis.explanation || '');
  const allBlocks = toPointBlocks(text);
  let used: PointBlock[];
  if (!selected) {
    used = allBlocks;
  } else {
    const headName = (head: string) => head.replace(/^【|】$/g, '');
    used = allBlocks.filter((block) => block.head && selected.some((dim) => markerOf(dim, headName(block.head))));
    // 老数据没有【】标记：仅“不筛选(全选)”才整体带出，避免维度勾选下误传无关正文
    if (used.length === 0 && !hasAnyMarker(text)) used = [];
    // 全盘总结的小节(核心结论/时间节点/行动建议)不属于五维度：勾选维度时仍要整篇带出，否则复制结果会丢掉总结
    if (keepWholeText && used.length === 0) used = allBlocks;
  }
  const body = pointBodyText(used, 'ordinal').trim();
  if (body) blocks.push(body);
  return blocks.join('\n\n');
}

/** 展示用：分点渲染批断正文。读取时也过一遍清洗 —— 早于提示词修复的旧记录里
 *  存着照抄的算法字段，写入路径管不到它们，只能在展示层兜住。 */
function PointsView({ text }: { text?: string }) {
  const blocks = toPointBlocks(sanitizeAnalysisText(text || ''));
  if (blocks.length === 0) return <p>暂无正文</p>;
  return <div className="points-view">{blocks.map((block, index) => (
    <div className="point-block" key={index}>{block.head ? <p className="point-head">{block.head}</p> : null}{block.points.length > 0 && <ul className="point-list">{block.points.map((point, i) => <li key={i}>{point}</li>)}</ul>}</div>
  ))}</div>;
}

/* 「没密钥」这句话该指向哪儿：连着服务器时分析默认由服务器完成，但本客户端的设置页只能填
   本机三条通道的凭据(服务器那侧的密钥要在服务器上配)。旧文案让人去填一个用不上的地方，
   所以两条路都说清楚：要么在服务器上给 AI 配密钥，要么在本机填凭据改用本机通道。
   两处口径要对齐界面实物：「设置」按钮靠行尾对齐(.settings-entry margin-left:auto)、窄屏同样靠右，
   所以方位写「右上角」。通道名一律用中文读法(深思、克米、千问)：正式版口径下界面正文不许出现
   拉丁字母，包括服务商自己的英文名。 */
const keyMissingHint = isServerMode()
  ? '批断尚未可用：现在连着服务器，分析默认由服务器完成，而服务器那边还没配访问凭据，需要在服务器上配置，本客户端的设置页管不到它。想马上能用：点页面右上角设置，在任一服务里填写访问凭据并保存，分析就会改走本机通道。'
  : '批断尚未可用：请先点页面右上角设置，在任一服务里填写访问凭据并保存，再回来点批断分析。';

function AIAnalysis({ record, onUpdated }: { record: BaziRecord; onUpdated: (next: BaziRecord) => void }) {
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string>();
  const [copyNote, setCopyNote] = useState<string>();
  const [disabledTasks, setDisabledTasks] = useState<Set<string>>(new Set());
  const [disabledDims, setDisabledDims] = useState<Set<DimKey>>(new Set());
  const controllerRef = useRef<AbortController | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 语气条显示「本机 · 这条盘」的偏好(选过的 → 上次跑的 → 全局默认)，与 record.toneUsed 无关：
  // record 会随同步上行服务器、下发别的设备，把语气写进去就会导致「这边调低、别人那也低」。
  const [tone, setTone] = useState<number>(() => recordTone(record.id));
  const toneRef = useRef(tone); toneRef.current = tone;
  const [autoWaiting, setAutoWaiting] = useState(false);
  // 本次会话的窗口起点固定一次：跨月长跑时「预期任务清单」与进度条不会中途换算法。
  const horizonRef = useRef<Date>(new Date());
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoRetryCountRef = useRef(0);
  const busyRef = useRef(false);
  const markBusy = (v: boolean) => { busyRef.current = v; setBusy(v); };
  const cancelAutoRetry = () => { if (autoTimerRef.current) { clearTimeout(autoTimerRef.current); autoTimerRef.current = undefined; } setAutoWaiting(false); };
  // 与聊天面板同一个入口：不钻 prop，App 里监听窗口事件打开设置页。
  const openSettings = () => window.dispatchEvent(new Event('mingli:open-settings'));

  const aiResults = Object.values(record.aiTasks ?? {});
  // 列表里有一条「未配置」，整条记录却常是 completed(其余任务成功)：此时上面的 not_configured
  // 引导不出现，用户只看到一句「状态：已完成」加一堆「未配置」的条目，不知道该去哪儿补。
  const hasUnconfiguredTask = aiResults.some((item) => item.status === 'not_configured');
  const byGroup = (key: string) => aiResults.filter((item) => item.task.type === key).sort((a, b) => (a.task.year ?? 0) - (b.task.year ?? 0) || (a.task.month ?? 0) - (b.task.month ?? 0));
  /** 有正文/格局可用的已完成结果(按界面展示顺序)，可作复制范围。 */
  const completedResults = (key: string): BaziTaskResult[] => byGroup(key).filter((item) => item.status === 'completed' && !!item.analysis && (!!item.analysis.explanation || !!item.analysis.pattern));
  const allCompleted = scopeGroups.flatMap((group) => completedResults(group.key));
  const totalCompleted = allCompleted.length;
  const selectedCount = allCompleted.filter((item) => !disabledTasks.has(item.task.taskId)).length;

  /** 第一次进度回调之前没有分母可显示，只拿它撑住进度条的形状(不写进「任务 x / y」，
   *  因为 +2 那两条占位此刻还未必会发，写出来就是虚报总数)。 */
  const queuedTotal = () => buildBaziTasks(record, horizonRef.current).length + 2;

  const showCopyNote = (text: string) => {
    setCopyNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setCopyNote(undefined), 3000);
  };

  /** 复制/导出行的统一清洗：应用自己拼的表头也走正文那道中文闸门。
 *  清洗万一判空(闸门宁缺毋滥)就退回原文，绝不把整行范围标题弄丢；
 *  闸门会把「2029」翻成「二零二九」、删掉括号与间隔号，【】作为结构标记保留。
 *  年份缺失的任务(存量旧记录里 task.year 为空)会洗成「年流年」这种断句，这里补一次语义兜底。 */
const sanitizeCopyLine = (line: string): string => {
  const cleaned = sanitizeAnalysisText(line)
    .replace(/[ \t]+(?=[一-鿿])/g, '')   // 「二零二六 年流年」→「二零二六年流年」：数字翻中文后留下的空格并入词组
    .replace(/(?<=[一-鿿])[ \t]+(?=[一-鿿])/g, '、') // 「大运段2026-2033」→「大运段、二零二六、二零三三」这类并列读法
    .replace(/[【】]/g, '');             // 【】是算法侧的切段标记(检索/维度筛选靠它)，用户文档里不该出现
  if (!cleaned) return line;
  return /^年(流年|流月)$/.test(cleaned) ? cleaned.slice(1) : cleaned;
};

  /** 组装复制文本：范围按界面分组顺序；维度为空数组=不筛选(全部)。 */
  const buildCopyText = (dimFilter: DimKey[] | null): string => {
    const selected = dimFilter === null ? null : dimFilter.length === DIMS.length ? null : dimFilter;
    const groups: string[] = [];
    for (const group of scopeGroups) {
      const items = completedResults(group.key).filter((item) => !disabledTasks.has(item.task.taskId));
      if (items.length === 0) continue;
      const blocks: string[] = [];
      for (const item of items) {
        const analysis = item.analysis!;
        const body = formatCopyBody(analysis, selected, item.task.type === 'overview');
        if (!body.trim()) continue;
        blocks.push(sanitizeCopyLine(describeScope(item, record)) + '\n' + body);
      }
      if (blocks.length === 0) continue;
      groups.push(sanitizeCopyLine(group.title) + '\n' + blocks.join('\n\n'));
    }
    const text = groups.join('\n\n\n');
    if (text.trim()) return text;
    // 兼容旧记录：没有按任务拆分的结果时，直接导出整段本命正文
    if (record.aiAnalysis?.explanation) {
      return sanitizeCopyLine('本命命局') + '\n' + formatCopyBody(record.aiAnalysis, selected);
    }
    return '';
  };

  const toggleTask = (taskId: string) => setDisabledTasks((current) => { const next = new Set(current); if (next.has(taskId)) next.delete(taskId); else next.add(taskId); return next; });
  const toggleDim = (dim: DimKey) => setDisabledDims((current) => { const next = new Set(current); if (next.has(dim)) next.delete(dim); else next.add(dim); return next; });
  const enabledDims = DIMS.filter((dim) => !disabledDims.has(dim.key));
  const dimFilter: DimKey[] | null = disabledDims.size === 0 ? null : enabledDims.map((dim) => dim.key);

  const copyAll = async () => {
    const text = buildCopyText(null);
    if (!text.trim()) { showCopyNote('暂无可复制的结果'); return; }
    await copy(text);
    showCopyNote('已复制全部，共' + cnCount(allCompleted.length) + '项');
  };
  const copySelected = async () => {
    const text = buildCopyText(dimFilter);
    if (!text.trim()) { showCopyNote('勾选的内容没有可复制的正文，请调整勾选'); return; }
    await copy(text);
    showCopyNote('已复制' + cnCount(selectedCount) + '项结果，维度为' + (disabledDims.size === 0 ? '全部' : '其中' + cnCount(enabledDims.length) + '类'));
  };

  /* 范围勾选小标签(与展示顺序一致、简短可检索)。界面文案同样不许出现半角符号与算式：
     序号用中文数字，括号一律不写。 */
  const chipLabel = (item: BaziTaskResult): string => {
    const t = item.task;
    if (t.type === 'baseline') return '本命命局';
    if (t.type === 'overview') return '全盘总结';
    if (t.type === 'adjustment') return '后天调整';
    if (t.type === 'decade') {
      const gf = findDecade(record, t);
      return gf?.ganZhi ? '未来大运、' + gf.ganZhi : '未来大运';
    }
    if (t.type === 'annual') {
      const ord = completedResults('annual').findIndex((x) => x.task.taskId === t.taskId) + 1;
      return `未来第${cnCount(ord)}年`;
    }
    if (t.type === 'monthly') {
      const ord = completedResults('monthly').findIndex((x) => x.task.taskId === t.taskId) + 1;
      return `未来第${cnCount(ord)}月`;
    }
    return t.type;
  };
  const chipTitle = (item: BaziTaskResult): string => describeScope(item, record);

  /** 分析失败后的“全自动重试”：不点按钮，稍候自动再跑(最多自动 2 次)。 */
  function scheduleAutoRetry(rec: BaziRecord) {
    if (autoRetryCountRef.current >= 2 || controllerRef.current?.signal.aborted) return;
    if (rec.aiError && !isRetryableFailure(rec.aiError)) return; // 密钥/配置类问题不盲试
    autoRetryCountRef.current += 1;
    const n = autoRetryCountRef.current;
    setAutoWaiting(true);
    setHint('分析失败：将在十二秒后自动重新分析，这是第' + cnCount(n) + '次，共两次。也可以现在手动点批断分析，或取消自动重试。');
    autoTimerRef.current = setTimeout(() => {
      autoTimerRef.current = undefined;
      setAutoWaiting(false);
      if (!busyRef.current && !controllerRef.current?.signal.aborted) void requestAnalysis(rec, true);
    }, 12000);
  }
  async function requestAnalysis(base: BaziRecord = record, _auto = false) {
    if (busyRef.current) return;
    cancelAutoRetry();
    if (!_auto) autoRetryCountRef.current = 0;
    let enteredBusy = false;
    try {
      const currentTone = toneRef.current;
      const expectedIds = expectedTaskIds(base, horizonRef.current);
      const completeTasks = expectedIds.filter((id) => {
        const item = base.aiTasks?.[id];
        return item?.status === 'completed' && !!item.analysis && (!!item.analysis.explanation || !!item.analysis.pattern);
      });
      if (expectedIds.length > 0 && completeTasks.length === expectedIds.length) {
        const ran = usedTone(base.id);   // 本机这条盘上次生成用的语气；undefined = 本机还没跑过(可能是同步/换设备来的)
        // 本机没跑过、或语气与上次一致 → 视为命中缓存，绝不当成「改语气」把整盘成果清掉重算。
        if (ran === undefined || ran === currentTone) {
          markUsedTone(base.id, currentTone);
          setProgress(null);
          setHint('已存在该语气下的完整分析结果，命中了缓存或已保存的记录。要改语气后重出，请拖动下方语气条再点批断分析。');
          return;
        }
        setHint('语气已从' + cnCount(ran) + '调到' + cnCount(currentTone) + '：先清旧结果，按新语气重新生成，请稍候');
        const cleared = await saveBaziRecord({ ...base, aiTasks: undefined, aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiStatus: 'not_started' });
        onUpdated(cleared);
        base = cleared;
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      beginAiSession();
      markBusy(true); enteredBusy = true;
      setHint(undefined); setCopyNote(undefined);
      setProgress({ done: 0, total: expectedIds.length + 2, label: '正在准备任务' });
      const pending = await saveBaziRecord({ ...base, aiStatus: 'pending', aiError: undefined });   // 不再写 toneUsed：语气是本机的事，不进会同步的 record
      onUpdated(pending);
      let lastSnapshot: BaziRecord = pending;
      try {
        const finished = await orchestrateBaziAnalysis(pending, undefined, async (step) => {
          setProgress({ done: step.done, total: step.total, label: step.label });
          try {
            const persisted = await saveBaziRecord(step.record);
            lastSnapshot = persisted;
            onUpdated(persisted);
          } catch { /* 单次进度落库失败不中断整体，最终结果会整体保存 */ }
        }, { signal: controller.signal, tone: currentTone, now: horizonRef.current });
        const saved = await saveBaziRecord({ ...finished });   // 同上：不把语气写进同步记录
        markUsedTone(record.id, currentTone);   // 本机记住：这条盘这次是用 currentTone 生成的
        lastSnapshot = saved;
        setProgress(null);
        markBusy(false); enteredBusy = false;
        // 同 recalculateNonAi：交回视图前走一遍读取路径，视图里的排盘数组与过期任务清洗
        // 必须和下次点「AI 分析」时算出的预期清单同源，否则「结果完整」永远判不出来。
        onUpdated(await refreshRecord(saved));
        if (saved.aiStatus === 'failed') scheduleAutoRetry(saved);
      } catch (error) {
        setProgress(null);
        markBusy(false); enteredBusy = false;
        const aborted = controller.signal.aborted;
        const reason = error instanceof Error ? error.message : '请求未完成';
        try {
          const partial = await saveBaziRecord({ ...lastSnapshot, aiStatus: 'failed', aiError: aborted ? ABORTED_MESSAGE : reason });
          onUpdated(partial);
        } catch { /* 保存部分进度失败也不卡住界面 */ }
        setHint(aborted ? '已停止：已完成的任务已保存，可随时再点批断分析继续。' : '分析失败：' + safeAiError(reason));
      }
    } catch (error) {
      if (enteredBusy) markBusy(false);
      setProgress(null);
      setHint('操作失败：' + safeAiError(error instanceof Error ? error.message : String(error)));
    }
  }
  function stopAnalysis() {
    cancelAutoRetry();
    autoRetryCountRef.current = 0;
    controllerRef.current?.abort();
    cancelAiSession();
    setProgress(null);
    setHint('正在停止：已阻止后续任务，正在中断当前请求。');
  }
  function cancelAutoRetryFromHint() {
    autoRetryCountRef.current = 0;
    cancelAutoRetry();
    setHint('已取消自动重试。需要时可手动点批断分析。');
  }
  async function clearResultsOnly() {
    if (record.aiStatus === 'pending' || busy) return;
    cancelAutoRetry();
    autoRetryCountRef.current = 0;
    const cleared = await saveBaziRecord({ ...record, aiTasks: undefined, aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiStatus: 'not_started' });
    // 缓存清没清掉要如实说：网页版的缓存在服务器库里，离线/未登录时根本清不动，
    // 谎报「已清除」会让人以为下次分析必然重算(其实仍会命中旧缓存)。
    let cacheNote = '';
    try {
      const removed = await clearChartCache({ gender: record.gender, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar }, record.id);
      cacheNote = removed > 0 ? '，并清掉服务器上' + cnCount(removed) + '条命中缓存' : '，该盘在服务器上本无缓存';
    } catch { cacheNote = '，但服务器缓存没清掉：下次分析可能仍复用旧结果'; }
    onUpdated(cleared);
    setDisabledTasks(new Set()); setDisabledDims(new Set());
    setHint('已清除该命盘的批断结果' + cacheNote + '，未重新调用模型。需要时请再点批断分析。');
  }
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); if (autoTimerRef.current) clearTimeout(autoTimerRef.current); }, []);

  return <section className="detail-section" aria-labelledby="ai-title" aria-label="批断分析">
    <div className="section-heading"><div><p className="eyebrow">叁、批断结果</p><h2 id="ai-title">批断分析</h2></div><div className="button-group"><button className="primary-button" type="button" onClick={() => void requestAnalysis()} disabled={record.aiStatus === 'pending' || busy}>{busy ? '分析中，请稍候' : '批断分析'}</button>{(record.aiStatus === 'pending' || busy) && <button className="danger-button stop-button" type="button" onClick={stopAnalysis}>立即停止</button>}<button className="text-button" type="button" onClick={() => void clearResultsOnly()} disabled={record.aiStatus === 'pending' || busy}>清除批断结果与缓存，只清除不重算</button></div></div>
    <div className="tone-block" aria-label="分析语气">
      <span className="tone-label">措辞语气</span>
      <input id="tone-slider" type="range" min={0} max={100} step={5} value={tone} aria-valuetext={toneLabel(tone)} onChange={(event) => { const v = Number(event.target.value); setTone(v); saveRecordTone(record.id, v); }} />
      <span className="tone-value">{toneLabel(tone)}{tone === 80 ? '，这是默认档' : ''}</span>
      <span className="tone-scale"><em>犀利</em><em>中立</em><em>温柔夸夸</em></span>
    </div>
    <p className="ai-status" role="status">状态：{statusText[record.aiStatus]}</p>
    {hint && <p role="status">{hint}</p>}
    {autoWaiting && <div className="button-group"><button className="text-button" type="button" onClick={cancelAutoRetryFromHint}>取消自动重试</button></div>}
    {(progress || busy || (record.aiStatus === 'pending' && !progress)) && <div className="progress-block" aria-label="批断分析进度">
      <p className="progress-text">任务 {progress ? cnCount(progress.done) + '，共' + cnCount(progress.total) : '零'}：{progress?.label ?? '准备中'}</p>
      <div className="progress-track" role="progressbar" aria-valuenow={progress?.done ?? 0} aria-valuemin={0} aria-valuemax={progress?.total || queuedTotal() || 1}><div className="progress-fill" style={{ width: `${Math.round(((progress?.done ?? 0) / (progress?.total || queuedTotal() || 1)) * 100)}%` }} /></div>
    </div>}
    {record.aiStatus === 'pending' && <p role="status">按任务逐个调用批断：本命、每年流年、每月流月、大运、后天调整、全盘总结。每个任务数秒到数十秒；失败会自动重试一次，进度即时保存，中断后可随时继续。</p>}
    {(record.aiStatus === 'not_configured' || hasUnconfiguredTask) && <p role="status">{keyMissingHint}<button type="button" className="text-button chat-settings-link" onClick={openSettings}>去设置</button></p>}
    {record.aiStatus === 'failed' && <p role="status">{/未配置|没有可用的通道凭据/.test(record.aiError ?? '')
      // 一个凭据都没填时曾按 failed 上报(现已归为 not_configured)，此处兜住历史数据，
      // 别把「余额不足/限流」那串无关原因摆在一个根本没配密钥的用户面前。
      ? keyMissingHint
      : '个别任务自动重试多轮后仍未成功。常见原因是余额不足或额度已用完、密钥无效、请求过于频繁被限流、网络超时或不可达、所选服务不可用。请按下方原因处理后，再点批断分析，只补失败项，不重复花钱。'}</p>}
    {record.aiError && !/未配置|没有可用的通道凭据/.test(record.aiError) && <p role="alert">原因：{safeAiError(record.aiError)}</p>}
    {record.aiAnalysis && <div className="long-text"><strong>格局与强弱</strong><p>{sanitizeAnalysisText(record.aiAnalysis.pattern || '') || '暂无'}；{sanitizeAnalysisText(record.aiAnalysis.strength || '') || '暂无'}</p><p>喜：{(record.aiAnalysis.usefulElements ?? []).map((item) => sanitizeAnalysisText(item)).join('、') || '暂无'}，忌：{(record.aiAnalysis.avoidElements ?? []).map((item) => sanitizeAnalysisText(item)).join('、') || '暂无'}</p><PointsView text={record.aiAnalysis.explanation} /></div>}
    {/* 全盘总结正文(含古风标题)在下方「全盘总结」分组里完整展示；这里只留一处入口提示，避免同一段内容渲染两遍 */}
    {record.aiOverview && <p className="long-text" aria-label="全盘总结提要"><strong>全盘总结已完成：</strong>值得关注的年份与机会、风险窗口见下方全盘总结段落。</p>}
    {aiResults.length > 0 && <div className="ai-scopes">
      <div className="section-heading"><div><h3>各范围分析结果</h3></div><button className="text-button" type="button" onClick={() => void copyAll()}>复制全部</button></div>

      {/* 复制筛选：范围(按展示顺序) x 维度(主题) */}
      <div className="copy-panel" aria-label="复制筛选">
        <div className="copy-panel-row"><span className="copy-row-label">范围</span>
          <div className="chip-list">
            {allCompleted.map((item) => {
              const enabled = !disabledTasks.has(item.task.taskId);
              return <button key={item.task.taskId} type="button" className={enabled ? 'filter-chip selected' : 'filter-chip'} aria-pressed={enabled} title={chipTitle(item)} onClick={() => toggleTask(item.task.taskId)}>{chipLabel(item)}</button>;
            })}
            {totalCompleted === 0 && <span className="copy-empty-hint">暂无已完成的分析段落</span>}
          </div>
          <span className="chip-actions"><button type="button" className="text-button tiny" onClick={() => setDisabledTasks(new Set())}>全选</button><button type="button" className="text-button tiny" onClick={() => setDisabledTasks(new Set(allCompleted.map((item) => item.task.taskId)))}>清空</button></span>
        </div>
        <div className="copy-panel-row"><span className="copy-row-label">维度</span>
          <div className="chip-list">{DIMS.map((dim) => { const enabled = !disabledDims.has(dim.key); return <button key={dim.key} type="button" className={enabled ? 'filter-chip selected' : 'filter-chip'} aria-pressed={enabled} title={dim.markers.join('、')} onClick={() => toggleDim(dim.key)}>{dim.label}</button>; })}</div>
          <span className="chip-actions"><button type="button" className="text-button tiny" onClick={() => setDisabledDims(new Set())}>全选</button><button type="button" className="text-button tiny" onClick={() => setDisabledDims(new Set(DIM_KEYS as unknown as DimKey[]))}>清空</button></span>
        </div>
        <div className="copy-actions"><button className="primary-button copy-selected" type="button" onClick={() => void copySelected()}>复制勾选内容，已选{cnCount(selectedCount)}项，共{cnCount(totalCompleted)}项，维度为{disabledDims.size === 0 ? '全部' : cnCount(enabledDims.length) + '类'}</button>{copyNote && <span className="copy-note" role="status">{copyNote}</span>}</div>
        <p className="copy-help">范围与维度都默认全勾。比如只勾爱情维度再复制，就只会得到各范围里的爱情小节正文；勾选内容排版带范围标题与小节名，方便粘贴后检索。</p>
      </div>

      {scopeGroups.map((group) => {
        const items = byGroup(group.key);
        if (items.length === 0) return null;
        return <section key={group.key} className="subsection scope-group" aria-label={group.title}><h4>{group.title}</h4>
          {items.map((item, idx) => {
            const analysis = item.analysis;
            const lead = analysis && (analysis.pattern || analysis.strength) ? <p className="scope-lead">格局：{sanitizeAnalysisText(analysis.pattern || '') || '暂无'}，强弱：{sanitizeAnalysisText(analysis.strength || '') || '暂无'}，喜：{(analysis.usefulElements ?? []).map((item) => sanitizeAnalysisText(item)).join('、') || '暂无'}，忌：{(analysis.avoidElements ?? []).map((item) => sanitizeAnalysisText(item)).join('、') || '暂无'}</p> : null;
            return <details key={group.key + '-' + idx} className="scope-item" open={group.key === 'baseline' && item.status === 'completed'}>
              <summary>{describeScope(item, record)}<span className="scope-status">，{statusText[item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'not_configured']}</span></summary>
              {item.status === 'completed' && analysis ? <div className="scope-body">{analysis.title ? <p className="scope-title"><strong>{sanitizeAnalysisText(analysis.title)}</strong></p> : null}{lead}<PointsView text={analysis.explanation} /></div> : item.status === 'failed' ? (busy ? <p className="retry-hint">该任务失败，正在自动重新批断，请稍候</p> : <p className="form-error">自动重试多轮后仍失败：{safeAiError(item.error ?? '未知错误')}</p>) : item.status === 'not_configured' ? <p>未配置密钥，本项未生成。<button type="button" className="text-button chat-settings-link" onClick={openSettings}>去设置</button></p> : null}
            </details>;
          })}
        </section>;
      })}
    </div>}
  </section>;
}
export function PersonDetail({ personId, onBack, refreshKey = 0 }: PersonDetailProps) {
  const [record, setRecord] = useState<BaziRecord>();
  const [notice, setNotice] = useState<string>();
  // 删除要二次确认：手机误触一下就把整条命盘连同已生成的 AI 结果全清掉，且无法撤销。
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    let active = true;
    setRecord(undefined);
    void getBaziRecord(personId).then((next) => { if (active) setRecord(next); });
    return () => { active = false; };
  }, [personId, refreshKey]);
  // 排盘数据是读取时重算的(存储里已瘦身)，所以首帧先给加载态：直接拿旧数据显示会闪出
  // 「④ 未来大运」下早已走完的大运段，正是这次要修的那个假标题。
  if (!record) return <main className="person-detail placeholder-page"><header className="page-heading"><h1>人物详情</h1></header><p role="status">正在读取命盘，请稍候</p><button className="text-button" type="button" onClick={onBack}>返回记录</button></main>;
  const loadedRecord = record;
  const recordId = loadedRecord.id;
  async function remove() { await deleteBaziRecord(recordId); setConfirmDelete(false); onBack(); }
  async function recalculateNonAi() {
    setNotice(undefined);
    try {
      const { calculateNonAi } = await import('../chart/nonAiCalculator');
      // 带上真实出生日(nonAiResult.birthDay)：换日盘的日柱是次日干支，若不锚回真实日，重算会把公历/农历/起运带偏到次日。
      const nonAiResult = calculateNonAi({ birthYear: loadedRecord.birthYear, birthMonth: loadedRecord.birthMonth, birthDay: loadedRecord.nonAiResult?.birthDay, yearPillar: loadedRecord.yearPillar, monthPillar: loadedRecord.monthPillar, dayPillar: loadedRecord.dayPillar, hourPillar: loadedRecord.hourPillar }, loadedRecord.gender, loadedRecord.createdAt);
      const updated = await saveBaziRecord({ ...loadedRecord, nonAiResult });
      // 存回去的是瘦身版(pruneRecord)，返回那份的数组是这次现算的、按点击时刻排的。
      // 直接用它会绕过读取侧的过期任务清洗，「AI 分析」的预期清单就会和界面上的
      // 「④未来大运」不同源 —— 已走完的那一运被当成必填槽位，每次点都整轮重算。
      setRecord(await refreshRecord(updated));
      // 这句承诺的是「重算了排盘数据」，顺手把 AI 结果一起清了反而与提示不符(而且用户没要求)。
      setNotice('排盘数据已重新计算');
    } catch (error) {
      setNotice(`排盘重算失败：${error instanceof Error ? error.message : '计算失败'}`);
    }
  }
  return <main className="person-detail">
    <header className="page-heading detail-top"><div><p className="eyebrow">本机命盘档案</p><h1>人物详情</h1><p className="page-description">{readableName(record.name)} 的八字记录与批断分析</p></div><div>{confirmDelete
      ? <div className="button-group" role="group" aria-label="确认删除"><span className="danger-hint">确定删除{readableName(record.name)}这个人吗？四柱、排盘数据与全部批断结果一并清除，无法撤销。</span><button className="danger-button" type="button" onClick={() => void remove()}>确认删除</button><button className="text-button" type="button" onClick={() => setConfirmDelete(false)}>取消</button></div>
      : <button className="text-button" type="button" onClick={onBack}>返回记录</button>}<button className="danger-button" type="button" onClick={() => setConfirmDelete(true)} hidden={confirmDelete}>删除数据</button></div></header>
    {notice && <p role="status">{notice}</p>}
    <BasicInfo record={record} /><NonAiAnalysis result={record.nonAiResult} record={record} /><div className="section-actions"><button className="text-button" type="button" onClick={() => void recalculateNonAi()}>重新排盘</button></div><AIAnalysis record={record} onUpdated={setRecord} />
  </main>;
}
