import { useEffect, useRef, useState } from 'react';
import { deleteBaziRecord, getBaziRecord, saveBaziRecord } from '../../data/clientRepository';
import { ABORTED_MESSAGE, buildBaziTasks, isRetryableFailure, orchestrateBaziAnalysis, DEFAULT_TONE } from '../../data/baziOrchestrator';
import { beginAiSession, cancelAiSession } from '../../data/deepseekAdapter';
import { clearChartCache } from '../../data/storageInfo';
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
    case 'overview': return '性格与行为总评';
    case 'adjustment': return '后天调整与职业适配（按喜用五行）';
    case 'annual': return `${task.year ?? ''} 年流年`;
    case 'monthly': return `${task.year ?? ''} 年 ${task.month ?? ''} 月`;
    case 'synthesis': return '最终总结';
    default: return task.type;
  }
};
/** 附加元信息：目标时段的干支与年龄 —— 正对应“每个任务只换日子干支和年龄”。 */
const horizonOf = (record: BaziRecord) => {
  const start = new Date(record.createdAt || Date.now());
  const year = new Date(start.getTime() + 8 * 60 * 60 * 1000).getUTCFullYear();
  return { from: year, to: year + 9 };
};

/** 大运展示段：第一段“当年→本大运结束”，第二段“下一大运起→十年后”。 */
const decadeSegment = (taskYear: number | undefined, record: BaziRecord): { start: number; end: number } => {
  const nonAi = record.nonAiResult;
  const horizon = horizonOf(record);
  const decade = (nonAi?.greatFortunes ?? []).find((item) => item.startYear === taskYear);
  const rawStart = decade?.startYear ?? taskYear ?? horizon.from;
  const rawEnd = decade?.endYear ?? horizon.to;
  return { start: Math.max(rawStart, horizon.from), end: Math.min(rawEnd, horizon.to) };
};

/** 大运标题：去掉“2020 起”这类日期前缀，只保留干支+时段，如“庚子 大运段(2020-2029)”。 */
const decadeHeading = (result: BaziTaskResult, record: BaziRecord): string => {
  const seg = decadeSegment(result.task.year, record);
  const decade = (record.nonAiResult?.greatFortunes ?? []).find((item) => item.startYear === result.task.year);
  const name = decade?.ganZhi ?? '';
  const span = name ? `${name} 大运段(${seg.start}-${seg.end})` : `大运段(${seg.start}-${seg.end})`;
  const age = result.task.year !== undefined && record.birthYear ? `年龄约 ${result.task.year - record.birthYear} 岁` : '';
  return [span, age].filter(Boolean).join(' · ');
};

const fortuneMeta = (result: BaziTaskResult, record: BaziRecord): string => {
  const task = result.task;
  const nonAi = record.nonAiResult;
  const age = task.year !== undefined && record.birthYear ? `年龄约 ${task.year - record.birthYear} 岁` : '';
  let ganZhi = '';
  if (task.type === 'annual' && nonAi) {
    ganZhi = nonAi.annualFortunes.find((item) => item.year === task.year)?.ganZhi ?? '';
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
  { key: 'adjustment', title: '② 后天调整与职业适配（按喜用五行）' },
  { key: 'decade', title: '③ 未来大运' },
  { key: 'annual', title: '④ 未来十年 · 每年流年' },
  { key: 'monthly', title: '⑤ 从今天起 · 未来十二个月' },
];
const groupTitle = (title: string) => '【' + title.replace(/^\d+\s*[①-⑨]?\s*/, '') + '】';

/* ---------------- 语气滑杆(犀利 ↔ 中立 ↔ 温柔夸夸，默认 80) ---------------- */
const TONE_KEY = 'mingli.analysis.tone';
export const readTone = (): number => {
  try { const raw = localStorage.getItem(TONE_KEY); if (raw === null || raw.trim() === '') return DEFAULT_TONE; const v = Number(raw); return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : DEFAULT_TONE; } catch { return DEFAULT_TONE; }
};
export const saveTone = (v: number) => { try { localStorage.setItem(TONE_KEY, String(v)); } catch { /* 忽略 */ } };
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
const mapText = (value: Record<string, number>) => Object.entries(value).map(([key, count]) => `${key} ${count}`).join(' · ') || '—';
function NonAiAnalysis({ result, record }: { result?: NonAiChart; record: BaziRecord }) {
  if (!result) return <section className="detail-section" aria-label="基础排盘数据"><div className="section-heading"><div><p className="eyebrow">02 / CHART DATA</p><h2>基础排盘数据</h2></div></div><p role="status">暂无基础排盘数据</p></section>;
  const fields: [string, string][] = [
    ['四柱', `${result.pillars.year} · ${result.pillars.month} · ${result.pillars.day} · ${result.pillars.hour}`],
    ['公历日期', result.solarDate],
    ['五行', mapText(result.elements)], ['五行比例', mapText(result.elementRatio)],
    ['日主', result.dayMaster], ['十二长生', listText(result.twelveLongevity)],
    ['袁天罡称骨', result.chenggu ? `${result.chenggu.totalText}（年 ${result.chenggu.parts.year}·月 ${result.chenggu.parts.month}·日 ${result.chenggu.parts.day}·时 ${result.chenggu.parts.hour}，${result.chenggu.ruleVersion}）` : '—'],
  ];
  const columns: [string, string][] = [['四柱', fields[0][1]], ['藏干', listText(result.hiddenStems)], ['藏干十神', result.tenGodDetails.hidden.map((items) => items.map((item) => `${item.stem}:${item.tenGod}`).join('、')).join(' · ') || '—'], ['十神', listText(result.tenGods)], ['纳音', listText(result.naYin)]];
  const relationLabels: Array<[keyof NonAiChart['relationships'], string]> = [['sanHe', '三合'], ['liuHe', '六合'], ['xing', '刑'], ['chong', '冲'], ['po', '破'], ['hai', '害'], ['ke', '克']];
  const yb = record.yearPillar?.[1] ?? '';
  const zs = yb && '子丑寅卯辰巳午未申酉戌亥'.includes(yb) ? interpersonalZodiac(yb) : null;
  const selfZodiac = yb ? zodiacOfBranch(yb) : '';
  return <section className="detail-section" aria-label="基础排盘数据"><div className="section-heading"><div><p className="eyebrow">02 / CHART DATA</p><h2>基础排盘数据</h2></div></div><dl className="info-grid chart-data-grid">{fields.slice(1).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="chart-columns">{columns.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</div><section className="subsection" aria-label="生肖关系"><h3>生肖关系</h3><p>本命生肖：{result.zodiac}（年支 {record.yearPillar[1]}）</p>
      {zs && <p>人际适配：我属{selfZodiac} → 三合 {zs.sanHe.join('、')} · 六合 {zs.liuHe.join('、')} · 六冲 {zs.chong.join('、')} · 六害 {zs.hai.join('、')}（生肖人际参考，非决断）</p>}<ul>{relationLabels.map(([key, label]) => <li key={key}><strong>{label}</strong>：{result.relationships[key].join('、') || '—'}</li>)}</ul></section><details className="subsection shen-sha" aria-label="神煞"><summary>神煞</summary>
      <p>命理吉神：{result.shenSha.auspicious.join('、') || '—'}</p>
      <p>命理凶神：{result.shenSha.inauspicious.join('、') || '—'}</p>
      {(result.shenSha.items ?? []).length > 0 && <ul className="shensha-list">{(result.shenSha.items ?? []).map((item, index) => <li key={`s${index}`}>{item.name} · {['年柱', '月柱', '日柱', '时柱'][item.pillarIndex]}{item.position}（{item.basis}）</li>)}</ul>}
      <p>日煞：{result.shenSha.daySha || '—'}　日天神：{result.shenSha.dayTianShen || '—'}　时天神：{result.shenSha.timeTianShen || '—'}</p>
      <small>规则版本：{result.shenSha.ruleVersion || '—'}；来源：{result.shenSha.source || '—'}</small></details></section>;
}
const safeAiError = (error: string) => error
  .replace(/sk-[a-z0-9_-]+/gi, '[已隐藏]')
  .replace(/bearer\s+[^\s]+/gi, '[已隐藏]')
  .replace(/deepseek|moonshot|kimi|api\s*key|模型|厂商/gi, '[已隐藏]');

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

/** 复制正文排版：标题行 + 分点条目(•) + 段落间空行，方便检索/定位。 */
export function formatCopyBody(analysis: NonNullable<BaziTaskResult['analysis']>, selected: DimKey[] | null): string {
  const blocks: string[] = [];
  if (selected === null && analysis.title) blocks.push('标题：' + analysis.title);
  if (analysis.pattern && selected === null && !analysis.explanation) {
    blocks.push('格局：' + analysis.pattern + ' · 强弱：' + (analysis.strength || '—') + '　喜：' + (analysis.usefulElements ?? []).join('、') + '　忌：' + (analysis.avoidElements ?? []).join('、'));
  }
  const text = analysis.explanation || '';
  const allBlocks = toPointBlocks(text);
  let used: PointBlock[];
  if (!selected) {
    used = allBlocks;
  } else {
    const headName = (head: string) => head.replace(/^【|】$/g, '');
    used = allBlocks.filter((block) => block.head && selected.some((dim) => markerOf(dim, headName(block.head))));
    // 老数据没有【】标记：仅“不筛选(全选)”才整体带出，避免维度勾选下误传无关正文
    if (used.length === 0 && !hasAnyMarker(text)) used = [];
  }
  const body = pointBodyText(used).trim();
  if (body) blocks.push(body);
  return blocks.join('\n\n');
}

/** 展示用：分点渲染 AI 正文。 */
function PointsView({ text }: { text?: string }) {
  const blocks = toPointBlocks(text || '');
  if (blocks.length === 0) return <p>（无正文）</p>;
  return <div className="points-view">{blocks.map((block, index) => (
    <div className="point-block" key={index}>{block.head ? <p className="point-head">{block.head}</p> : null}{block.points.length > 0 && <ul className="point-list">{block.points.map((point, i) => <li key={i}>{point}</li>)}</ul>}</div>
  ))}</div>;
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
  const [tone, setTone] = useState<number>(() => readTone());
  const toneRef = useRef(tone); toneRef.current = tone;
  const [autoWaiting, setAutoWaiting] = useState(false);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoRetryCountRef = useRef(0);
  const busyRef = useRef(false);
  const markBusy = (v: boolean) => { busyRef.current = v; setBusy(v); };
  const cancelAutoRetry = () => { if (autoTimerRef.current) { clearTimeout(autoTimerRef.current); autoTimerRef.current = undefined; } setAutoWaiting(false); };

  const aiResults = Object.values(record.aiTasks ?? {});
  const byGroup = (key: string) => aiResults.filter((item) => item.task.type === key).sort((a, b) => (a.task.year ?? 0) - (b.task.year ?? 0) || (a.task.month ?? 0) - (b.task.month ?? 0));
  /** 有正文/格局可用的已完成结果(按界面展示顺序)，可作复制范围。 */
  const completedResults = (key: string): BaziTaskResult[] => byGroup(key).filter((item) => item.status === 'completed' && !!item.analysis && (!!item.analysis.explanation || !!item.analysis.pattern));
  const allCompleted = scopeGroups.flatMap((group) => completedResults(group.key));
  const totalCompleted = allCompleted.length;
  const selectedCount = allCompleted.filter((item) => !disabledTasks.has(item.task.taskId)).length;

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
        const body = formatCopyBody(analysis, selected);
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
    if (t.type === 'adjustment') return '后天调整';
    if (t.type === 'decade') {
      const gf = (record.nonAiResult?.greatFortunes ?? []).find((g) => g.startYear === t.year);
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
    const currentTone = toneRef.current;
    const expectedIds = buildBaziTasks(base).map((task) => task.taskId);
    const completeTasks = expectedIds.filter((id) => {
      const item = base.aiTasks?.[id];
      return item?.status === 'completed' && !!item.analysis && (!!item.analysis.explanation || !!item.analysis.pattern);
    });
    if (expectedIds.length > 0 && completeTasks.length === expectedIds.length) {
      if (base.toneUsed === currentTone) {
        setProgress(null);
        setHint('已存在该语气下的完整分析结果（命中缓存/已保存）。要改语气后重出，请拖动下方语气条再点 AI 分析。');
        return;
      }
      // 语气变了：清掉本地旧结果，按新语气重新生成(服务器缓存按语气分档，不会命中旧语气)
      setHint('语气已从 ' + (base.toneUsed ?? 80) + ' 调到 ' + currentTone + '：先清旧结果，按新语气重新生成…');
      const cleared = await saveBaziRecord({ ...base, aiTasks: undefined, aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiStatus: 'not_started' });
      onUpdated(cleared);
      base = cleared;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    beginAiSession();
    markBusy(true);
    setHint(undefined);
    setCopyNote(undefined);
    setProgress({ done: 0, total: expectedIds.length, label: '准备任务…' });
    const pending = await saveBaziRecord({ ...base, aiStatus: 'pending', aiError: undefined, toneUsed: currentTone });
    onUpdated(pending);
    let lastSnapshot: BaziRecord = pending;
    try {
      // 每个任务完成即顺序落库一次(await，避免并发写互相覆盖)；中断/退出后重试只补缺失任务
      const finished = await orchestrateBaziAnalysis(pending, undefined, async (step) => {
        setProgress({ done: step.done, total: step.total, label: step.label });
        const persisted = await saveBaziRecord(step.record);
        lastSnapshot = persisted;
        onUpdated(persisted);
      }, { signal: controller.signal, tone: currentTone });
      const saved = await saveBaziRecord(finished);
      lastSnapshot = saved;
      setProgress(null);
      markBusy(false);
      onUpdated(saved);
      if (saved.aiStatus === 'failed') {
        scheduleAutoRetry(saved); // 失败后自动再分析，不需要人点按钮
      }
    } catch (error) {
      setProgress(null);
      markBusy(false);
      const aborted = controller.signal.aborted;
      const reason = error instanceof Error ? error.message : 'request failed';
      // 保存已完成的部分进度，避免整段结果丢失
      const partial = await saveBaziRecord({ ...lastSnapshot, aiStatus: 'failed', aiError: aborted ? ABORTED_MESSAGE : reason });
      onUpdated(partial);
      setHint(aborted ? '已停止：正在分析/已完成的任务均已按实际情况保存，可随时再点 AI 分析继续（自动跳过已完成项）。' : '分析失败：' + safeAiError(reason));
    }
  }
  function stopAnalysis() {
    cancelAutoRetry();
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
    if (record.aiStatus === 'pending' || busy) return;
    cancelAutoRetry();
    autoRetryCountRef.current = 0;
    const cleared = await saveBaziRecord({ ...record, aiTasks: undefined, aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiStatus: 'not_started' });
    try { await clearChartCache({ gender: record.gender, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar }); } catch { /* 清缓存失败也继续 */ }
    onUpdated(cleared);
    setDisabledTasks(new Set()); setDisabledDims(new Set());
    setHint('已清除该命盘的 AI 结果与命中缓存（未重新调用 AI）。需要时请再点“AI 分析”。');
  }
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); if (autoTimerRef.current) clearTimeout(autoTimerRef.current); }, []);

  return <section className="detail-section" aria-labelledby="ai-title" aria-label="AI 分析">
    <div className="section-heading"><div><p className="eyebrow">03 / AI ANALYSIS</p><h2 id="ai-title">AI 分析</h2></div><div className="button-group"><button className="primary-button" type="button" onClick={() => void requestAnalysis()} disabled={record.aiStatus === 'pending' || busy}>{busy ? '分析中…' : 'AI 分析'}</button>{(record.aiStatus === 'pending' || busy) && <button className="danger-button stop-button" type="button" onClick={stopAnalysis}>立即停止</button>}<button className="text-button" type="button" onClick={() => void clearResultsOnly()} disabled={record.aiStatus === 'pending' || busy}>清除AI结果与缓存（只清除，不重算）</button></div></div>
    <div className="tone-block" aria-label="分析语气">
      <span className="tone-label">措辞语气</span>
      <input id="tone-slider" type="range" min={0} max={100} step={5} value={tone} aria-valuetext={toneLabel(tone)} onChange={(event) => { const v = Number(event.target.value); setTone(v); saveTone(v); }} />
      <span className="tone-value">{toneLabel(tone)}{tone === 80 ? '（默认：八成好话 + 两成委婉点不足）' : ''}</span>
      <span className="tone-scale"><em>犀利</em><em>中立</em><em>温柔夸夸</em></span>
    </div>
    <p className="ai-status" role="status">状态：{statusText[record.aiStatus]}</p>
    {hint && <p role="status">{hint}</p>}
    {autoWaiting && <div className="button-group"><button className="text-button" type="button" onClick={cancelAutoRetryFromHint}>取消自动重试</button></div>}
    {(progress || busy || (record.aiStatus === 'pending' && !progress)) && <div className="progress-block" aria-label="AI 分析进度">
      <p className="progress-text">任务 {progress?.done ?? 0} / {progress?.total ?? buildBaziTasks(record).length}：{progress?.label ?? '排队中…'}…</p>
      <div className="progress-track" role="progressbar" aria-valuenow={progress?.done ?? 0} aria-valuemin={0} aria-valuemax={progress?.total ?? buildBaziTasks(record).length}><div className="progress-fill" style={{ width: `${Math.round(((progress?.done ?? 0) / (progress?.total ?? buildBaziTasks(record).length)) * 100)}%` }} /></div>
    </div>}
    {record.aiStatus === 'pending' && <p role="status">按任务逐个调用 AI（本命 → 每年 → 每月 → 大运 → 后天调整），每个任务数秒到数十秒；失败会自动重试一次，进度即时保存，中断后可随时继续。</p>}
    {record.aiStatus === 'not_configured' && <p role="status">AI 尚未可用：请先点页面左上角「设置」，在服务一/服务二中任选一个填写访问凭据并保存，再回来点 AI 分析。</p>}
    {record.aiStatus === 'failed' && <p role="status">个别任务自动重试多轮后仍未成功：请先到「设置」确认密钥有效、网络可用，再点 AI 分析（只补失败项，不重复花钱）。</p>}
    {record.aiError && <p role="alert">原因：{safeAiError(record.aiError)}</p>}
    {record.aiAnalysis && <div className="long-text"><strong>格局与强弱</strong><p>{record.aiAnalysis.pattern || '—'} · {record.aiAnalysis.strength || '—'}</p><p>喜：{(record.aiAnalysis.usefulElements ?? []).join('、') || '—'}　忌：{(record.aiAnalysis.avoidElements ?? []).join('、') || '—'}</p><PointsView text={record.aiAnalysis.explanation} /></div>}
    {record.aiOverview && <div className="long-text"><strong>最终结论：八字总览、工作与生活方式</strong><p>格局：{record.aiOverview.pattern || '—'}　强弱：{record.aiOverview.strength || '—'}</p><p>喜：{(record.aiOverview.usefulElements ?? []).join('、') || '—'}　忌：{(record.aiOverview.avoidElements ?? []).join('、') || '—'}</p><PointsView text={record.aiOverview.explanation} /></div>}
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
            const lead = analysis && (analysis.pattern || analysis.strength) ? <p className="scope-lead">格局：{analysis.pattern || '—'} · 强弱：{analysis.strength || '—'}　喜：{(analysis.usefulElements ?? []).join('、') || '—'}　忌：{(analysis.avoidElements ?? []).join('、') || '—'}</p> : null;
            return <details key={group.key + '-' + idx} className="scope-item" open={group.key === 'baseline' && item.status === 'completed'}>
              <summary>{describeScope(item, record)}<span className="scope-status">　{statusText[item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'not_configured']}</span></summary>
              {item.status === 'completed' && analysis ? <div className="scope-body">{analysis.title ? <p className="scope-title"><strong>{analysis.title}</strong></p> : null}{lead}<PointsView text={analysis.explanation} /></div> : item.status === 'failed' ? (busy ? <p className="retry-hint">该任务失败，正在自动重新调用 AI…</p> : <p className="form-error">自动重试多轮后仍失败：{safeAiError(item.error ?? '未知错误')}</p>) : item.status === 'not_configured' ? <p>未配置密钥，本项未生成。</p> : null}
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
  useEffect(() => {
    let active = true;
    setRecord(undefined);
    void getBaziRecord(personId).then((next) => { if (active) setRecord(next); });
    return () => { active = false; };
  }, [personId, refreshKey]);
  if (!record) return <main className="person-detail placeholder-page"><header className="page-heading"><h1>人物详情</h1></header><p role="status">未找到人物记录，请返回记录列表。</p><button className="text-button" type="button" onClick={onBack}>返回记录</button></main>;
  const loadedRecord = record;
  const recordId = loadedRecord.id;
  async function remove() { await deleteBaziRecord(recordId); onBack(); }
  async function recalculateNonAi() {
    setNotice(undefined);
    try {
      const { calculateNonAi } = await import('../chart/nonAiCalculator');
      const nonAiResult = calculateNonAi({ birthYear: loadedRecord.birthYear, birthMonth: loadedRecord.birthMonth, yearPillar: loadedRecord.yearPillar, monthPillar: loadedRecord.monthPillar, dayPillar: loadedRecord.dayPillar, hourPillar: loadedRecord.hourPillar }, loadedRecord.gender, loadedRecord.createdAt);
      const updated = await saveBaziRecord({ ...loadedRecord, nonAiResult, aiStatus: 'not_started', aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiTasks: undefined });
      setRecord(updated);
      setNotice('非 AI 已重新计算');
    } catch (error) {
      setNotice(`非 AI 计算失败：${error instanceof Error ? error.message : '计算失败'}`);
    }
  }
  return <main className="person-detail">
    <header className="page-heading detail-top"><div><p className="eyebrow">PERSON RECORD · {record.id}</p><h1>人物详情</h1><p className="page-description">{record.name} 的八字记录与 AI 分析</p></div><div><button className="text-button" type="button" onClick={onBack}>返回记录</button><button className="danger-button" type="button" onClick={() => void remove()}>删除数据</button></div></header>
    {notice && <p role="status">{notice}</p>}
    <BasicInfo record={record} /><NonAiAnalysis result={record.nonAiResult} record={record} /><div className="section-actions"><button className="text-button" type="button" onClick={() => void recalculateNonAi()}>重新计算非 AI</button></div><AIAnalysis record={record} onUpdated={setRecord} />
  </main>;
}
