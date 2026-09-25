import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { deleteBaziRecord, getBaziRecord, refreshRecord, saveBaziRecord } from '../../data/clientRepository';
import { ABORTED_MESSAGE, aiStatusText, analysisHorizon, expectedTaskIds, isRetryableFailure, orchestrateBaziAnalysis, plannedTaskIds, DEFAULT_TONE } from '../../data/baziOrchestrator';
import { beginAiSession, cancelAiSession } from '../../data/deepseekAdapter';
import { clearChartCache } from '../../data/storageInfo';
import { sanitizeAnalysisText } from '../chart/elements';
import { isServerMode } from '../../data/serverClient';
import { canBuildLocalAnalysis, isLocalSystemEnabled, isLocalSystemHidden, localSystemUnlocked, subscribeLocalSystem } from '../../data/localSystem';
import type { BaziRecord, BaziTaskResult, NonAiChart } from '../../types/domain';
import { interpersonalZodiac, zodiacOfBranch } from '../../utils/interpersonal';

export interface PersonDetailProps { personId: string; onBack: () => void; refreshKey?: number }
const copy = (text: string) => navigator.clipboard?.writeText(text);

const statusText: Record<BaziRecord['aiStatus'], string> = {
  not_started: '未开始', pending: '分析中', completed: '已完成', failed: '分析失败', not_configured: '未配置',
};

const scopeLabel = (result: BaziTaskResult): string => {
  const task = result.task;
  switch (task.type) {
    case 'baseline': return '本命命局（身强身弱/格局/喜忌）';
    case 'overview': return '全盘总结（值得关注的时间节点）';
    case 'adjustment': return '后天调整与职业适配（按喜用五行）';
    case 'annual': return `${task.year ?? ''} 年流年`;
    case 'monthly': return `${task.year ?? ''} 年 ${task.month ?? ''} 月`;
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

/** 大运展示段：标题叫「大运段」，就该是这一运本来的十年。旧记录里同一运的 endYear 可能少一两年，
 *  按起点补满十年；与「未来十年」窗口取交集会把还没轮到的运截成单一年份，渲染出
 *  「丙戌 大运段(2035-2035)」这种假十年，所以不截。 */
export const decadeSegment = (task: { year?: number; decade?: { ganZhi: string; startYear: number; endYear: number } }, record: BaziRecord): { start: number; end: number } => {
  const horizon = horizonOf(record);
  const decade = findDecade(record, task);
  const rawStart = decade?.startYear ?? task.year ?? horizon.from;
  const rawEnd = decade?.endYear ?? horizon.to;
  return { start: rawStart, end: Math.max(rawEnd, rawStart + 9) };
};

/** 大运标题：只保留干支+时段（如“庚子 大运段(2020-2029)”）。不显示年龄推算。 */
const decadeHeading = (result: BaziTaskResult, record: BaziRecord): string => {
  const seg = decadeSegment(result.task, record);
  const name = findDecade(record, result.task)?.ganZhi ?? '';
  return name ? `${name} 大运段(${seg.start}-${seg.end})` : `大运段(${seg.start}-${seg.end})`;
};

const fortuneMeta = (result: BaziTaskResult, record: BaziRecord): string => {
  const task = result.task;
  const nonAi = record.nonAiResult;
  const age = task.year !== undefined && record.birthYear ? `年龄约 ${task.year - record.birthYear} 岁` : '';
  let ganZhi = '';
  if (task.type === 'annual' && nonAi) {
    ganZhi = task.annual?.ganZhi ?? nonAi.annualFortunes.find((item) => item.year === task.year)?.ganZhi ?? '';
  } else if (task.type === 'monthly') {
    ganZhi = task.monthly?.ganZhi ?? (nonAi ? nonAi.monthlyFortunes.find((item) => item.year === task.year && item.month === task.month)?.ganZhi ?? '' : '');
  }
  return [ganZhi, age].filter(Boolean).join(' · ');
};
const describeScope = (result: BaziTaskResult, record: BaziRecord): string => {
  const task = result.task;
  if (task.type === 'decade') return decadeHeading(result, record);
  const meta = fortuneMeta(result, record);
  return scopeLabel(result) + (meta ? ' · ' + meta : '');
};

const scopeGroups: Array<{ key: BaziTaskResult['task']['type']; title: string }> = [
  { key: 'baseline', title: '① 本命（身强身弱/格局/喜忌 + 健康·事业·财运·爱情）' },
  { key: 'overview', title: '② 全盘总结（值得关注的时间节点）' },
  { key: 'adjustment', title: '③ 后天调整与职业适配（按喜用五行）' },
  { key: 'decade', title: '④ 未来大运' },
  { key: 'annual', title: '⑤ 未来十年 · 每年流年' },
  { key: 'monthly', title: '⑥ 从今天起 · 未来十二个月' },
];
const groupTitle = (title: string) => '【' + title.replace(/^\d+\s*[①-⑨]?\s*/, '') + '】';

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
  ['姓名', record.name], ['性别', record.gender === 'male' ? '男' : '女'],
  ['出生年', String(record.birthYear)], ['出生月', String(record.birthMonth)],
  ['年柱', record.yearPillar], ['月柱', record.monthPillar], ['日柱', record.dayPillar], ['时柱', record.hourPillar],
];
export function generatePersonDetailText(record: BaziRecord) {
  return getBasicFields(record).map(([label, value]) => `${label}：${value}`).join('\n');
}
function BasicInfo({ record }: { record: BaziRecord }) {
  return <section className="detail-section" aria-labelledby="basic-title" aria-label="基础信息">
    <div className="section-heading"><div><p className="eyebrow">01 / PROFILE</p><h2 id="basic-title">基础信息</h2></div><button className="text-button" type="button" onClick={() => void copy(generatePersonDetailText(record))}>复制基础信息</button></div>
    <dl className="info-grid">{getBasicFields(record).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}
const listText = (value: string[] | string[][]) => value.map((item) => Array.isArray(item) ? item.join('、') : item).join(' · ') || '—';
/** 起运文案：几岁起运 + 当前正走哪一运。老记录没算过起运时如实说「未记录」，
 *  引导去点「重新计算非 AI」，而不是悄悄沿用旧的十年边界对齐结果。 */
export const luckStartText = (result: NonAiChart, nowYear: number): string => {
  const start = result.luckStart;
  if (!start?.date) return '未记录（点下方「重新计算非 AI」可补算）';
  const current = (result.greatFortunes ?? []).find((g) => g.startYear <= nowYear && nowYear <= g.endYear);
  const age = `${start.years}岁${start.months ? start.months + '个月' : ''}`;
  return `出生后约 ${age}（${start.date} 前后）起运${current ? `；今年正走 ${current.ganZhi} 运（${current.startYear}-${current.endYear}）` : '；当前已出排定的大运区间'}`;
};
const mapText = (value: Record<string, number>) => Object.entries(value).map(([key, count]) => `${key} ${count}`).join(' · ') || '—';
/** 五行比例按百分比展示(原始值是 0~1 的小数，直接打出来是 0.375 这种看不懂的数)。
 *  分母是实际观测数(四干 + 四支本气 = 8)，为 0 时不硬凑百分比。
 *  空格点名的五行补一句「缺X」，这是读盘最关心的一句话，不该让用户自己去数。
 *  导出以便测试直接锁住文案(组件本身依赖太多上下文，不适合为这一行单独渲染)。 */
export const formatElementRatio = (value: Record<string, number>) => {
  if (!value || !Object.values(value).reduce((a, b) => a + b, 0)) return '—';
  const shown = Object.entries(value).map(([key, ratio]) => `${key} ${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`);
  const missing = Object.entries(value).filter(([, ratio]) => ratio === 0).map(([key]) => key);
  return shown.join(' · ') + (missing.length ? `（缺${missing.join('、')}）` : '');
};
function NonAiAnalysis({ result, record }: { result?: NonAiChart; record: BaziRecord }) {
  if (!result) return <section className="detail-section" aria-label="基础排盘数据"><div className="section-heading"><div><p className="eyebrow">02 / CHART DATA</p><h2>基础排盘数据</h2></div></div><p role="status">暂无基础排盘数据</p></section>;
  const fields: [string, string][] = [
    ['四柱', `${result.pillars.year} · ${result.pillars.month} · ${result.pillars.day} · ${result.pillars.hour}`],
    ['公历日期', result.solarDate],
    ['五行', mapText(result.elements)], ['五行比例', formatElementRatio(result.elementRatio)],
    ['日主', result.dayMaster], ['十二长生', listText(result.twelveLongevity)],
    ['起运', luckStartText(result, new Date().getFullYear())],
    ['袁天罡称骨', result.chenggu ? `${result.chenggu.totalText}（年 ${result.chenggu.parts.year}·月 ${result.chenggu.parts.month}·日 ${result.chenggu.parts.day}·时 ${result.chenggu.parts.hour}，${result.chenggu.ruleVersion}）` : '—'],
  ];
  const columns: [string, string][] = [['四柱', fields[0][1]], ['藏干', listText(result.hiddenStems)], ['藏干十神', result.tenGodDetails.hidden.map((items) => items.map((item) => `${item.stem}:${item.tenGod}`).join('、')).join(' · ') || '—'], ['十神', listText(result.tenGods)], ['纳音', listText(result.naYin)]];
  const relationLabels: Array<[keyof NonAiChart['relationships'], string]> = [['sanHe', '三合'], ['liuHe', '六合'], ['xing', '刑'], ['chong', '冲'], ['po', '破'], ['hai', '害'], ['ke', '克']];
  const yb = record.yearPillar?.[1] ?? '';
  const zs = yb && '子丑寅卯辰巳午未申酉戌亥'.includes(yb) ? interpersonalZodiac(yb) : null;
  const selfZodiac = yb ? zodiacOfBranch(yb) : '';
  return <section className="detail-section" aria-label="基础排盘数据"><div className="section-heading"><div><p className="eyebrow">02 / CHART DATA</p><h2>基础排盘数据</h2></div></div><dl className="info-grid chart-data-grid">{fields.slice(1).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="chart-columns">{columns.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</div><section className="subsection" aria-label="生肖关系"><h3>生肖关系</h3><p>本命生肖：{zodiacOfBranch(record.yearPillar?.[1] ?? '')}（年支 {record.yearPillar[1]}）</p>
      {zs && <p>人际适配：我属{selfZodiac} → 三合 {zs.sanHe.join('、')} · 六合 {zs.liuHe.join('、')} · 六冲 {zs.chong.join('、')} · 六害 {zs.hai.join('、')}（生肖人际参考，非决断）</p>}<ul>{relationLabels.map(([key, label]) => <li key={key}><strong>{label}</strong>：{result.relationships[key].join('、') || '—'}</li>)}</ul></section></section>;
}
const safeAiError = (error: string) => error
  .replace(/sk-[a-z0-9_-]+/gi, '[已隐藏]')
  .replace(/github_pat_[a-z0-9_]+/gi, '[已隐藏]')
  .replace(/bearer\s+[^\s，。）]+/gi, '[已隐藏]')
  .replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, '$1[已隐藏]');

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
/** 按【...】标记把正文切成带标题的段落（标记本身从正文里剥掉，输出时原样还原）。 */
export function splitSections(text: string): Section[] {
  const re = /【([^】]{1,16})】/g;
  const sections: Section[] = [];
  let cursor = 0;
  let last: Section | null = null;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const between = text.slice(cursor, m.index);
    if (last) { last.body += between; }
    else { const lead = between.trim(); if (lead) sections.push({ head: '', body: lead }); }
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
/** 已自带编号/圆点的一行保持原样；普通长句按 。；！？ 断成若干条。 */
function bulletize(line: string): string[] {
  if (/^(d+[.、．]|[•·-—])\s+/.test(line)) return [line];
  const sentences = line.split(/(?<=[。；!?！？])\s*/).map((s) => s.trim()).filter((s) => s.length > 1);
  return sentences.length > 0 ? sentences : (line ? [line] : []);
}
/** 全文“分点化”：每个【主题】一行标题，其下每句一条，能分点的全部拆开。 */
export function toPointBlocks(text: string): PointBlock[] {
  const blocks: PointBlock[] = [];
  let current: PointBlock | null = null;
  const pushCurrent = () => { if (current && (current.head || current.points.length > 0)) blocks.push(current); };
  for (const rawLine of (text || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const marker = line.match(/^【([^】]{1,16})】/);
    if (marker) {
      pushCurrent();
      current = { head: '【' + marker[1] + '】', points: [] };
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
/** 屏幕/复制共用的“分点正文”排版：标题行 + • 每条一行。 */
export function pointBodyText(blocks: PointBlock[]): string {
  return blocks.map((block) => {
    const head = block.head ? block.head + '\n' : '';
    return head + block.points.map((point) => '• ' + point).join('\n');
  }).join('\n\n');
}

/** 复制正文排版：标题行 + 分点条目(•) + 段落间空行，方便检索/定位。
 *  与展示同理，「先读后洗」：旧记录里存的照抄字段也在这里被清掉，复制出去的不带英文。 */
export function formatCopyBody(analysis: NonNullable<BaziTaskResult['analysis']>, selected: DimKey[] | null, keepWholeText = false): string {
  const blocks: string[] = [];
  if (selected === null && analysis.title) blocks.push('标题：' + sanitizeAnalysisText(analysis.title));
  if (analysis.pattern && selected === null && !analysis.explanation) {
    const elements = (list?: string[]) => (list ?? []).map((item) => sanitizeAnalysisText(item)).filter(Boolean).join('、') || '—';
    blocks.push('格局：' + (sanitizeAnalysisText(analysis.pattern) || '—') + ' · 强弱：' + (sanitizeAnalysisText(analysis.strength || '') || '—') + '　喜：' + elements(analysis.usefulElements) + '　忌：' + elements(analysis.avoidElements));
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
  const body = pointBodyText(used).trim();
  if (body) blocks.push(body);
  return blocks.join('\n\n');
}

/** 展示用：分点渲染 AI 正文。读取时也过一遍清洗 —— 早于提示词修复的旧记录里
 *  存着 `(inSeason: false)` 这类照抄字段，写入路径管不到它们，只能在展示层兜住。 */
function PointsView({ text }: { text?: string }) {
  const blocks = toPointBlocks(sanitizeAnalysisText(text || ''));
  if (blocks.length === 0) return <p>（无正文）</p>;
  return <div className="points-view">{blocks.map((block, index) => (
    <div className="point-block" key={index}>{block.head ? <p className="point-head">{block.head}</p> : null}{block.points.length > 0 && <ul className="point-list">{block.points.map((point, i) => <li key={i}>{point}</li>)}</ul>}</div>
  ))}</div>;
}

/* 「没密钥」这句话该指向哪儿：三条分支各说清一条出路。**必须在渲染时现读**，不能写成模块级常量 ——
   真机和测试都是先加载本模块、之后才往 localStorage 里写开通标记，常量会在「还没开通」那一刻把话
   定死，之后用户开开关关这句都不改口（第一版就是这么写的，用例直接打回）。 */
export function keyMissingHintOf(): string {
  /* 本机已开通第四路时不能再教人去填云端凭据：只要勾上那一项，点「AI 分析」压根不碰任何通道密钥，
     由本机规则引擎直接批断。旧文案在这种状态下仍写「填凭据…分析就会改走本机通道」，等于让用户为
     一个本机早就备好的出路再花一次钱。判的是「已开通」而非「已勾选」：没勾选时确实还得配凭据。 */
  if (localSystemUnlocked())
    return 'AI 尚未可用：当前已勾选「使用本地系统」，点「AI 分析」由本机规则引擎直接批断，不需要任何通道凭据；若想改用云端大模型，请到页面右上角「设置」取消勾选，并在任一服务(DeepSeek / Kimi / Qwen3.8-Flash)里填写访问凭据并保存。';
  /* 连着服务器时分析默认由服务器完成，但本客户端的设置页只能填本机三条通道的凭据(服务器那侧的密钥要
     在服务器上配)，所以两条路都说清楚。口径要对齐界面实物：「设置」按钮靠行尾对齐(.settings-entry
     margin-left:auto)、窄屏同样靠右，方位才写「右上角」；三条通道在设置页上就叫 DeepSeek / Kimi /
     Qwen3.8-Flash，别写成用户找不到的「通义」。 */
  if (isServerMode())
    return 'AI 尚未可用：现在连着服务器，分析默认由服务器完成，而服务器那边还没配 AI 密钥(需要在服务器上配置，本客户端的设置页管不到它)。想马上能用：点页面右上角「设置」，在任一服务(DeepSeek / Kimi / Qwen3.8-Flash)里填写访问凭据并保存，分析就会改走本机通道。';
  return 'AI 尚未可用：请先点页面右上角「设置」，在任一服务(DeepSeek / Kimi / Qwen3.8-Flash)里填写访问凭据并保存，再回来点 AI 分析。';
}

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
  // 本机当前是否真的让「本地系统」（原本地离线·第四路）接管生成方式：既要已用解锁码开通、
  // 又要勾选了「使用本地系统」。不进 record（它是本机的事，不该同步）。
  /* 一次读取 + 一份快照，两个理由各对应一种曾经过的状态：
     · **一轮分析进行中**不许改读数 —— 长跑期间用户去设置页改了勾选，横幅与本轮余下的任务都必须
       仍按开跑时的引擎走完（否则同一轮会被劈成半本机半云端，绿点/来源标注自相矛盾）。冻结闸门就是
       下面那句 `!busyRef.current`：requestAnalysis 在第一个 await **之前**就 markBusy(true)，
       而它取的正是这份 ref 读数 ⇒ busy 为真期间快照不再跟随 live。
     · 但「一直冻着」也不能过头：以前只在挂载时读一次，于是留下一条真路径 —— 详情页 → 设置页
       取消勾选 → 返回（App 不换组件、record 也没变，压根不重渲染），横幅仍写着「当前为本地系统」，
       而点「AI 分析」已经悄悄走回云端。所以订阅本机标记：标记一变就重算快照，只要本轮还没开跑
       就跟界面同步；两种坏状态都不留。
     不变量：**横幅那句话与本轮发射点的 options.local 必须是同一个值**（同生同灭）。只动其中一侧
     的写法都有对应变异体盯着：H 删闸门 / I 让横幅脱离快照 / F1 退化成挂载快照 / G 去掉订阅。 */
  const readLocalSystem = useCallback(() => isLocalSystemEnabled(), []);
  const localSystemLive = useSyncExternalStore(subscribeLocalSystem, readLocalSystem, readLocalSystem);
  const localSystemRef = useRef<{ id: string; on: boolean }>({ id: '', on: false });
  const snapshot = localSystemRef.current;
  // 「换一条盘」必须重取读数（同组件复用实例）；同一条盘则只在**本轮没在跑**时跟随界面。
  if (snapshot.id !== record.id || (snapshot.on !== localSystemLive && !busyRef.current)) {
    localSystemRef.current = { id: record.id, on: localSystemLive };
  }
  /* 横幅用的就是这个快照：**跑着的时候**勾掉了也继续写「当前为本地系统」，因为引擎确实还在按本机
     规则批断（正文也是这么产出的）；这一轮收尾后快照才跟随新读数，那句话随之消失。
     反过来（一掉勾就改口）才是 bug —— 用户会以为已经停了，而任务还在按旧引擎写进同一条命盘。 */
  const localSystemOn = localSystemRef.current.on;
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
  const queuedTotal = () => plannedTaskIds(record, horizonRef.current).length;

  const showCopyNote = (text: string) => {
    setCopyNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setCopyNote(undefined), 3000);
  };

  /* 组装复制文本：范围按界面分组顺序；维度为空数组=不筛选(全部)。 */
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
        blocks.push(describeScope(item, record) + '\n' + body);
      }
      if (blocks.length === 0) continue;
      groups.push(groupTitle(group.title) + '\n' + blocks.join('\n\n'));
    }
    const text = groups.join('\n\n\n');
    if (text.trim()) return text;
    // 兼容旧记录：没有按任务拆分的结果时，直接导出整段本命正文
    if (record.aiAnalysis?.explanation) {
      return groupTitle('本命命局') + '\n' + formatCopyBody(record.aiAnalysis, selected);
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
    showCopyNote('已复制全部(' + allCompleted.length + ' 项)');
  };
  const copySelected = async () => {
    const text = buildCopyText(dimFilter);
    if (!text.trim()) { showCopyNote('勾选的内容没有可复制的正文，请调整勾选'); return; }
    await copy(text);
    showCopyNote('已复制 ' + selectedCount + ' 项结果（' + (disabledDims.size === 0 ? '全部维度' : enabledDims.length + ' 个维度') + '）');
  };

  /* 范围勾选小标签(与展示顺序一致、简短可检索) */
  const chipLabel = (item: BaziTaskResult): string => {
    const t = item.task;
    if (t.type === 'baseline') return '本命命局';
    if (t.type === 'overview') return '全盘总结';
    if (t.type === 'adjustment') return '后天调整';
    if (t.type === 'decade') {
      const gf = findDecade(record, t);
      return gf?.ganZhi ? '未来大运 · ' + gf.ganZhi : '未来大运';
    }
    if (t.type === 'annual') {
      const ord = completedResults('annual').findIndex((x) => x.task.taskId === t.taskId) + 1;
      return `未来第${ord}年(${t.year}年)`;
    }
    if (t.type === 'monthly') {
      const ord = completedResults('monthly').findIndex((x) => x.task.taskId === t.taskId) + 1;
      return `未来第${ord}月(${t.year}-${t.month})`;
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
    setHint('分析失败：将在 12 秒后自动重新分析（第 ' + n + '/2 次）…也可以现在手动点“AI 分析”或“取消自动重试”。');
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
      /* 整轮分析用**同一个**生成方式读数：中途用户在设置页改了勾选，也不该让这一轮一半走本机、
         一半走云端。所以这里读 `localSystemLive`（当前值），紧接着 markBusy(true) 把闸门落下 ——
         上面那份快照在 busy 为真期间不再跟随界面，横幅与发射点用的都是这一个值。 */
      const offline = localSystemLive;
      // 本地系统要有完整排盘数据才能产出各篇正文：没有数据时如实挡下，绝不拿空盘硬凑批断。
      if (offline && !canBuildLocalAnalysis(base)) {
        setHint('本地系统需要先有排盘数据：请点上方「重新计算非 AI」，再点 AI 分析。');
        return;
      }
      // 引擎切换 = 整轮重算并覆盖：先清掉「另一种引擎」留下的旧结果。
      // 不逐条覆盖是因为新引擎未必产出同一批任务(如云端本命无喜用则不出「后天调整」)，
      // 残留一条另一引擎的正文既会让绿点标注自相矛盾，也会让聊天/复制里混进两种来源的文本。
      const hasWrongEngine = Object.values(base.aiTasks ?? {}).some((r) => (((r.source) ?? 'cloud') === 'local') !== offline);
      if (hasWrongEngine) {
        const cleared = await saveBaziRecord({ ...base, aiTasks: undefined, aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiStatus: 'not_started' });
        onUpdated(cleared);
        base = cleared;
        setHint(offline ? '已切换到本地离线（第四路）：正在用本机规则引擎重算并覆盖云端结果…' : '已切回云端通道：正在用云端重算并覆盖本地批断结果…');
      }
      const expectedIds = expectedTaskIds(base, horizonRef.current);
      /* 「哪些任务算跑完了」的谓词与状态行那句进度同源（见 baziOrchestrator 的 completedTaskCount），
         这里只需要 id 清单来逐条查引擎来源，所以用 expectedIds 自己滤一遍同一谓词。 */
      const isDone = (id: string) => {
        const item = base.aiTasks?.[id];
        return item?.status === 'completed' && !!item.analysis && (!!item.analysis.explanation || !!item.analysis.pattern);
      };
      const completeIds = expectedIds.filter(isDone);
      // 引擎是否一致：本轮要用的生成方式(离线/云端)与已有结果的来源相同。缺省 source 视为云端。
      // 不一致时不走「命中缓存」早退，直接进入重算 —— 让切换第四路/切回云端能覆盖彼此。
      const engineMatch = completeIds.every((id) => (((base.aiTasks?.[id]?.source) ?? 'cloud') === 'local') === offline);
      if (expectedIds.length > 0 && completeIds.length === expectedIds.length && engineMatch) {
        const ran = usedTone(base.id);   // 本机这条盘上次生成用的语气；undefined = 本机还没跑过(可能是同步/换设备来的)
        // 本机没跑过、或语气与上次一致 → 视为命中缓存，绝不当成「改语气」把整盘成果清掉重算。
        if (ran === undefined || ran === currentTone) {
          markUsedTone(base.id, currentTone);
          setProgress(null);
          setHint('已存在该语气下的完整分析结果（命中缓存/已保存）。要改语气后重出，请拖动下方语气条再点 AI 分析。');
          return;
        }
        setHint('语气已从 ' + ran + ' 调到 ' + currentTone + '：先清旧结果，按新语气重新生成…');
        const cleared = await saveBaziRecord({ ...base, aiTasks: undefined, aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiStatus: 'not_started' });
        onUpdated(cleared);
        base = cleared;
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      beginAiSession();
      markBusy(true); enteredBusy = true;
      setHint(undefined); setCopyNote(undefined);
      setProgress({ done: 0, total: plannedTaskIds(base, horizonRef.current).length, label: '准备任务…' });
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
        }, { signal: controller.signal, tone: currentTone, now: horizonRef.current, local: offline });
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
        const reason = error instanceof Error ? error.message : 'request failed';
        try {
          const partial = await saveBaziRecord({ ...lastSnapshot, aiStatus: 'failed', aiError: aborted ? ABORTED_MESSAGE : reason });
          onUpdated(partial);
        } catch { /* 保存部分进度失败也不卡住界面 */ }
        setHint(aborted ? '已停止：已完成的任务已保存，可随时再点 AI 分析继续。' : '分析失败：' + safeAiError(reason));
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
    setHint('正在停止…已阻止后续任务，正在中断当前请求。');
  }
  function cancelAutoRetryFromHint() {
    autoRetryCountRef.current = 0;
    cancelAutoRetry();
    setHint('已取消自动重试。需要时可手动点 AI 分析。');
  }
  async function clearResultsOnly() {
    if (busy) return;
    cancelAutoRetry();
    autoRetryCountRef.current = 0;
    const cleared = await saveBaziRecord({ ...record, aiTasks: undefined, aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiStatus: 'not_started' });
    // 缓存清没清掉要如实说：网页版的缓存在服务器库里，离线/未登录时根本清不动，
    // 谎报「已清除」会让人以为下次分析必然重算(其实仍会命中旧缓存)。
    let cacheNote = '';
    try {
      const removed = await clearChartCache({ gender: record.gender, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar }, record.id);
      cacheNote = removed > 0 ? '，并清掉服务器上 ' + removed + ' 条命中缓存' : '（该盘在服务器上本无缓存）';
    } catch { cacheNote = '，但服务器缓存没清掉：下次分析可能仍复用旧结果'; }
    onUpdated(cleared);
    setDisabledTasks(new Set()); setDisabledDims(new Set());
    setHint('已清除该命盘的 AI 结果' + cacheNote + '（未重新调用 AI）。需要时请再点“AI 分析”。');
  }
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); if (autoTimerRef.current) clearTimeout(autoTimerRef.current); }, []);

  return <section className="detail-section" aria-labelledby="ai-title" aria-label="AI 分析">
    <div className="section-heading"><div><p className="eyebrow">03 / AI ANALYSIS</p><h2 id="ai-title">AI 分析</h2></div><div className="button-group"><button className="primary-button" type="button" onClick={() => void requestAnalysis()} disabled={busy}>{busy ? '分析中…' : 'AI 分析'}</button>{busy && <button className="danger-button stop-button" type="button" onClick={stopAnalysis}>立即停止</button>}<button className="text-button" type="button" onClick={() => void clearResultsOnly()} disabled={busy}>清除AI结果与缓存（只清除，不重算）</button></div></div>
    <div className="tone-block" aria-label="分析语气">
      <span className="tone-label">措辞语气</span>
      <input id="tone-slider" type="range" min={0} max={100} step={5} value={tone} aria-valuetext={toneLabel(tone)} onChange={(event) => { const v = Number(event.target.value); setTone(v); saveRecordTone(record.id, v); }} />
      <span className="tone-value">{toneLabel(tone)}{tone === 80 ? '（默认：八成好话 + 两成委婉点不足）' : ''}</span>
      <span className="tone-scale"><em>犀利</em><em>中立</em><em>温柔夸夸</em></span>
    </div>
    <p className="ai-status" role="status">状态：{record.aiStatus === 'pending' ? aiStatusText(record, horizonRef.current) : statusText[record.aiStatus]}</p>
    {localSystemOn && <p className="ai-mode-note" role="status">当前为本地系统：点「AI 分析」由本机规则引擎就上方排盘事实直接批断，不联网、不消耗额度；结果同样写入本条命盘并随账号同步，可在设置页取消勾选切回云端重算覆盖。</p>}
    {!localSystemOn && aiResults.some((r) => r.source === 'local') && <p className="ai-mode-note" role="status">下方带 <span className="local-dot" aria-hidden="true" /> 的段落为上次本地系统批断的结果；当前用云端通道，点「AI 分析」会用云端结果重算并覆盖它们。</p>}
    {hint && <p role="status">{hint}</p>}
    {autoWaiting && <div className="button-group"><button className="text-button" type="button" onClick={cancelAutoRetryFromHint}>取消自动重试</button></div>}
    {(progress || busy) && <div className="progress-block" aria-label="AI 分析进度">
      <p className="progress-text">任务 {progress ? progress.done + ' / ' + progress.total : '0'}：{progress?.label ?? '准备中…'}</p>
      <div className="progress-track" role="progressbar" aria-valuenow={progress?.done ?? 0} aria-valuemin={0} aria-valuemax={progress?.total || queuedTotal() || 1}><div className="progress-fill" style={{ width: `${Math.round(((progress?.done ?? 0) / (progress?.total || queuedTotal() || 1)) * 100)}%` }} /></div>
    </div>}
    {/* 同一份 pending 有两种来历：本机真在跑，或别的设备跑一半走了/刷新前没来得及收尾。
       只有前者才该讲进度与自动重试 —— 对后者说「进度即时保存」是谎话，用户会一直等。 */}
    {record.aiStatus === 'pending' && <p role="status">{busy
      ? '按任务逐个调用 AI（本命 → 每年流年 → 每月流月 → 大运 → 后天调整 → 全盘总结），每个任务数秒到数十秒；失败会自动重试一次，进度即时保存，中断后可随时继续。'
      : '这条盘显示「分析中」，但那不是本设备发起的：多半是另一台设备上分析没跑完就离开了。这里没有在等，直接点「AI 分析」即可补齐。'}
    </p>}
    {(record.aiStatus === 'not_configured' || hasUnconfiguredTask) && <p role="status">{keyMissingHintOf()}<button type="button" className="text-button chat-settings-link" onClick={openSettings}>去设置 ›</button></p>}
    {record.aiStatus === 'failed' && <p role="status">{/未配置|没有可用的通道凭据/.test(record.aiError ?? '')
      // 一个凭据都没填时曾按 failed 上报(现已归为 not_configured)，此处兜住历史数据，
      // 别把「余额不足/限流」那串无关原因摆在一个根本没配密钥的用户面前。
      ? keyMissingHintOf()
      : '个别任务自动重试多轮后仍未成功。常见原因：余额不足或额度已用完 / 密钥无效 / 请求过于频繁（限流）/ 网络超时或不可达 / 所选服务不可用。请按下方原因处理后，再点 AI 分析（只补失败项，不重复花钱）。'}</p>}
    {record.aiError && !/未配置|没有可用的通道凭据/.test(record.aiError) && <p role="alert">原因：{safeAiError(record.aiError)}</p>}
    {record.aiAnalysis && <div className="long-text"><strong>格局与强弱</strong>{record.aiTasks?.['task-01']?.source === 'local' ? <span className="local-dot" title="本地离线批断（第四路）" aria-label="本地离线批断" /> : null}<p>{sanitizeAnalysisText(record.aiAnalysis.pattern || '') || '—'} · {sanitizeAnalysisText(record.aiAnalysis.strength || '') || '—'}</p><p>喜：{(record.aiAnalysis.usefulElements ?? []).map((item) => sanitizeAnalysisText(item)).join('、') || '—'}　忌：{(record.aiAnalysis.avoidElements ?? []).map((item) => sanitizeAnalysisText(item)).join('、') || '—'}</p><PointsView text={record.aiAnalysis.explanation} /></div>}
    {/* 全盘总结正文(含古风标题)在下方「② 全盘总结」分组里完整展示；这里只留一处入口提示，避免同一段内容渲染两遍 */}
    {record.aiOverview && <p className="long-text" aria-label="全盘总结提要"><strong>全盘总结已完成：</strong>值得关注的年份与机会/风险窗口见下方「② 全盘总结」段落。</p>}
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
          <div className="chip-list">{DIMS.map((dim) => { const enabled = !disabledDims.has(dim.key); return <button key={dim.key} type="button" className={enabled ? 'filter-chip selected' : 'filter-chip'} aria-pressed={enabled} title={dim.markers.join('/')} onClick={() => toggleDim(dim.key)}>{dim.label}</button>; })}</div>
          <span className="chip-actions"><button type="button" className="text-button tiny" onClick={() => setDisabledDims(new Set())}>全选</button><button type="button" className="text-button tiny" onClick={() => setDisabledDims(new Set(DIM_KEYS as unknown as DimKey[]))}>清空</button></span>
        </div>
        <div className="copy-actions"><button className="primary-button copy-selected" type="button" onClick={() => void copySelected()}>复制勾选内容（{selectedCount}/{totalCompleted} 项 · {disabledDims.size === 0 ? '全部' : enabledDims.length} 维度）</button>{copyNote && <span className="copy-note" role="status">{copyNote}</span>}</div>
        <p className="copy-help">范围与维度都默认全勾。比如只勾“爱情”维度再复制，就只会得到各范围里的【爱情】正文；勾选内容排版带范围标题与【主题】标记，方便粘贴后检索。</p>
      </div>

      {scopeGroups.map((group) => {
        const items = byGroup(group.key);
        if (items.length === 0) return null;
        return <section key={group.key} className="subsection scope-group" aria-label={group.title}><h4>{group.title}</h4>
          {items.map((item, idx) => {
            const analysis = item.analysis;
            const lead = analysis && (analysis.pattern || analysis.strength) ? <p className="scope-lead">格局：{sanitizeAnalysisText(analysis.pattern || '') || '—'} · 强弱：{sanitizeAnalysisText(analysis.strength || '') || '—'}　喜：{(analysis.usefulElements ?? []).map((item) => sanitizeAnalysisText(item)).join('、') || '—'}　忌：{(analysis.avoidElements ?? []).map((item) => sanitizeAnalysisText(item)).join('、') || '—'}</p> : null;
            return <details key={group.key + '-' + idx} className="scope-item" open={group.key === 'baseline' && item.status === 'completed'}>
              <summary>{describeScope(item, record)}{item.source === 'local' ? <span className="local-dot" title="本地离线批断（第四路）：不联网、可随时用云端重算覆盖" aria-label="本地离线批断" /> : null}<span className="scope-status">　{statusText[item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'not_configured']}</span></summary>
              {item.status === 'completed' && analysis ? <div className="scope-body">{analysis.title ? <p className="scope-title"><strong>{sanitizeAnalysisText(analysis.title)}</strong></p> : null}{lead}<PointsView text={analysis.explanation} /></div> : item.status === 'failed' ? (busy ? <p className="retry-hint">该任务失败，正在自动重新调用 AI…</p> : <p className="form-error">自动重试多轮后仍失败：{safeAiError(item.error ?? '未知错误')}</p>) : item.status === 'not_configured' ? <p>未配置密钥，本项未生成。<button type="button" className="text-button chat-settings-link" onClick={openSettings}>去设置 ›</button></p> : null}
            </details>;
          })}
        </section>;
      })}
    </div>}
  </section>;
}
/** 详情页是否摆出「本地系统」这块：已开通且没被暗门收起。与设置页的可见性判据同源，
    避免两处各写一份条件而漂开。 */
const readLocalVisible = () => localSystemUnlocked() && !isLocalSystemHidden();
/* 本地系统（原「本地离线·第四路」）：不联网、不调大模型、不耗额度，由 localAnalysis 规则引擎
   就上方排盘事实直接批断。结果只存组件 state、绝不写进 record —— record 会同步上行服务器、
   下发别的设备，把本地批断塞进去会污染云端 AI 结果与 aiStatus。每次点击现算，确定性可复现。
   这是**独立于生成方式开关**的预览入口：即使没勾「使用本地系统」也能在这里试跑看看。但整块只在
   本机已开通第四路、且没被暗门收起时才出现（判据见上面的 readLocalVisible）。 */
function LocalAnalysisSection({ record }: { record: BaziRecord }) {
  const [data, setData] = useState<{ lead: string; blocks: Array<{ title: string; text: string }> } | null>(null);
  const [note, setNote] = useState<string>();
  const [loading, setLoading] = useState(false);
  const disabled = !canBuildLocalAnalysis(record);
  const run = async () => {
    setLoading(true);
    let engine: typeof import('../../data/localAnalysis');
    try {
      // 点一次才加载一次规则引擎；module 自带缓存，第二次点击不会再走网络。
      engine = await import('../../data/localAnalysis');
    } catch (error) {
      setLoading(false);
      setData(null); setNote('本地引擎加载失败：' + (error instanceof Error ? error.message : String(error)));
      return;
    }
    setLoading(false);
    const { buildLocalAnalysis, buildLocalTaskAnalysis } = engine;
    try {
      const base = buildLocalAnalysis(record);
      if (!base) { setData(null); setNote('缺少基础排盘数据：请先点上方「重新计算非 AI」再来本地批断。'); return; }
      const blocks: Array<{ title: string; text: string }> = [{ title: '本命命局', text: base.explanation }];
      const overview = buildLocalTaskAnalysis(record, { taskId: 'local-overview', type: 'overview' });
      if (overview?.explanation) blocks.push({ title: '未来十年 · 全盘总结', text: overview.explanation });
      const adjust = buildLocalTaskAnalysis(record, { taskId: 'local-adjust', type: 'adjustment' });
      if (adjust?.explanation) blocks.push({ title: '后天调整与职业适配', text: adjust.explanation });
      setData({ lead: `格局：${base.pattern} · 强弱：${base.strength}　喜：${base.usefulElements.join('、') || '—'}　忌：${base.avoidElements.join('、') || '—'}`, blocks });
      setNote(undefined);
    } catch (error) {
      setData(null); setNote('本地批断失败：' + (error instanceof Error ? error.message : String(error)));
    }
  };
  const copyAll = async () => { if (data) { await copy(data.blocks.map((b) => b.title + '\n' + b.text).join('\n\n')); setNote('已复制本地批断'); } };
  return <section className="detail-section" aria-label="本地系统">
    <div className="section-heading"><div><p className="eyebrow">03 / LOCAL SYSTEM</p><h2>本地系统（本机规则引擎）</h2></div>
      <div className="button-group"><button className="primary-button" type="button" onClick={() => void run()} disabled={disabled || loading}>{disabled ? '先算排盘数据' : loading ? '加载引擎…' : '生成本地批断'}</button>{data && <button className="text-button" type="button" onClick={() => void copyAll()}>复制本地批断</button>}</div></div>
    <p className="local-note">不联网、不调用云端服务、不消耗额度：由本机规则引擎就上方排盘事实直接批断，含本命、全盘总结与后天调整，供参考与兜底；多因素权衡的综合细断请以「AI 分析」为准。</p>
    {note && <p role="status">{note}</p>}
    {data && <div className="long-text"><p className="scope-lead">{data.lead}</p>{data.blocks.map((block) => <div className="local-block" key={block.title}><p className="scope-lead">{block.title}</p><PointsView text={block.text} /></div>)}</div>}
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

  /* 详情页这块「本地系统」跟着设置页那扇暗门一起收放：本机没开通、或已被连点藏起来时就不摆出来。
     两头各漏一处的后果不一样 —— 从没开过第四路的设备会在命盘里看见一整块用不上的入口；而知道
     暗门节奏的人把设置页藏干净后，详情页仍留着同一功能的标题和按钮，等于从另一头又把门露出来。
     读数走同一个订阅源：在设置页里放出/收回暗门，不用重进详情页就该同步改可见性。 */
  const showLocalSection = useSyncExternalStore(subscribeLocalSystem, readLocalVisible, readLocalVisible);
  // 排盘数据是读取时重算的(存储里已瘦身)，所以首帧先给加载态：直接拿旧数据显示会闪出
  // 「④ 未来大运」下早已走完的大运段，正是这次要修的那个假标题。
  if (!record) return <main className="person-detail placeholder-page"><header className="page-heading"><h1>人物详情</h1></header><p role="status">正在读取命盘…</p><button className="text-button" type="button" onClick={onBack}>返回记录</button></main>;
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
      setNotice('非 AI 已重新计算');
    } catch (error) {
      setNotice(`非 AI 计算失败：${error instanceof Error ? error.message : '计算失败'}`);
    }
  }
  return <main className="person-detail">
    <header className="page-heading detail-top"><div><p className="eyebrow">PERSON RECORD · {record.id}</p><h1>人物详情</h1><p className="page-description">{record.name} 的八字记录与 AI 分析</p></div><div>{confirmDelete
      ? <div className="button-group" role="group" aria-label="确认删除"><span className="danger-hint">确定删除「{record.name}」？四柱、排盘数据与全部 AI 结果一并清除，无法撤销。</span><button className="danger-button" type="button" onClick={() => void remove()}>确认删除</button><button className="text-button" type="button" onClick={() => setConfirmDelete(false)}>取消</button></div>
      : <button className="text-button" type="button" onClick={onBack}>返回记录</button>}<button className="danger-button" type="button" onClick={() => setConfirmDelete(true)} hidden={confirmDelete}>删除数据</button></div></header>
    {notice && <p role="status">{notice}</p>}
    <BasicInfo record={record} /><NonAiAnalysis result={record.nonAiResult} record={record} /><div className="section-actions"><button className="text-button" type="button" onClick={() => void recalculateNonAi()}>重新计算非 AI</button></div>{showLocalSection && <LocalAnalysisSection record={record} />}<AIAnalysis record={record} onUpdated={setRecord} />
  </main>;
}
