import { useEffect, useRef, useState } from 'react';
import { deleteBaziRecord, getBaziRecord, saveBaziRecord } from '../../data/clientRepository';
import { buildBaziTasks, orchestrateBaziAnalysis } from '../../data/baziOrchestrator';
import { clearChartCache } from '../../data/storageInfo';
import type { BaziRecord, BaziTaskResult, NonAiChart } from '../../types/domain';
import { interpersonalZodiac, zodiacOfBranch } from '../../utils/interpersonal';

export interface PersonDetailProps { personId: string; onBack: () => void; refreshKey?: number }
const copy = (text: string) => navigator.clipboard?.writeText(text);
const hasReusableAnalysis = (aiTasks: BaziRecord['aiTasks'] | undefined): boolean => {
  return Object.values(aiTasks ?? {}).some((item) => item.status === 'completed' && !!item.analysis && (!!item.analysis.explanation || !!item.analysis.pattern));
};
const statusText: Record<BaziRecord['aiStatus'], string> = {
  not_started: '未开始', pending: '分析中', completed: '已完成', failed: '分析失败', not_configured: '未配置',
};

const scopeLabel = (result: BaziTaskResult): string => {
  const task = result.task;
  switch (task.type) {
    case 'baseline': return '本命命局（身强身弱/格局/喜忌）';
    case 'overview': return '性格与行为总评';
    case 'decade': return `大运：${task.year ?? ''} 起（约十年）`;
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

const fortuneMeta = (result: BaziTaskResult, record: BaziRecord): string => {
  const task = result.task;
  const nonAi = record.nonAiResult;
  const age = task.year !== undefined && record.birthYear ? `年龄约 ${task.year - record.birthYear} 岁` : '';
  let ganZhi = '';
  if (task.type === 'decade') {
    const seg = decadeSegment(task.year, record);
    const decade = (nonAi?.greatFortunes ?? []).find((item) => item.startYear === task.year);
    const name = decade?.ganZhi ?? '';
    if (name) ganZhi = `${name} 大运段(${seg.start}-${seg.end})`;
  } else if (task.type === 'annual' && nonAi) {
    ganZhi = nonAi.annualFortunes.find((item) => item.year === task.year)?.ganZhi ?? '';
  } else if (task.type === 'monthly') {
    ganZhi = task.monthly?.ganZhi ?? (nonAi ? nonAi.monthlyFortunes.find((item) => item.year === task.year && item.month === task.month)?.ganZhi ?? '' : '');
  }
  return [ganZhi, age].filter(Boolean).join(' · ');
};
const describeScope = (result: BaziTaskResult, record: BaziRecord): string => {
  const meta = fortuneMeta(result, record);
  return scopeLabel(result) + (meta ? ' · ' + meta : '');
};

const scopeGroups: Array<{ key: BaziTaskResult['task']['type']; title: string }> = [
  { key: 'baseline', title: '① 本命（身强身弱/格局/喜忌 + 健康·事业·财运·爱情）' },
  { key: 'adjustment', title: '② 后天调整与职业适配（按喜用五行）' },
  { key: 'decade', title: '③ 所处大运（未来十年）' },
  { key: 'annual', title: '④ 未来十年 · 每年流年' },
  { key: 'monthly', title: '⑤ 从今天起 · 未来十二个月' },
];
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
    <div className="section-heading"><div><p className="eyebrow">01 / PROFILE</p><h2 id="basic-title">基础信息</h2></div><button className="text-button" type="button" onClick={() => copy(generatePersonDetailText(record))}>复制基础信息</button></div>
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
function AIAnalysis({ record, onUpdated }: { record: BaziRecord; onUpdated: (next: BaziRecord) => void }) {
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [hint, setHint] = useState<string>();
  const cancelRef = useRef(false);
  async function requestAnalysis(base: BaziRecord = record, force = false) {
    if (!force && hasReusableAnalysis(base.aiTasks)) {
      setProgress(null);
      setHint('已存在有效分析结果(命中缓存/已保存)，故未重复调用 AI。如需真正重新分析，请点“真·清空并全量重算（删缓存）”。');
      return;
    }
    cancelRef.current = false;
    setHint(undefined);
    const pending = await saveBaziRecord({ ...base, aiStatus: 'pending' }); onUpdated(pending);
    setProgress({ done: 0, total: buildBaziTasks(pending).length, label: '准备任务…' });
    let lastSnapshot: BaziRecord = pending;
    try {
      // 每个任务完成即顺序落库一次(await，避免并发写互相覆盖)；中断/退出后重试只补缺失任务
      const finished = await orchestrateBaziAnalysis(pending, undefined, async (step) => {
        if (cancelRef.current) {
          setProgress(null);
          throw new Error('已停止：已完成的任务已保存，可随时用“AI 分析”或真重算继续');
        }
        setProgress({ done: step.done, total: step.total, label: step.label });
        const persisted = await saveBaziRecord(step.record);
        lastSnapshot = persisted;
        onUpdated(persisted);
      });
      const saved = await saveBaziRecord(finished);
      lastSnapshot = saved;
      setProgress(null);
      onUpdated(saved);
    } catch (error) {
      setProgress(null);
      // 保存已完成的部分进度，避免整段结果丢失
      const partial = await saveBaziRecord({ ...lastSnapshot, aiStatus: 'failed', aiError: error instanceof Error ? error.message : 'request failed' });
      onUpdated(partial);
    }
  }
  async function clearAndReanalyze() {
    // 真·清空重算：先删该命盘的命中缓存，再清空记录，随后重新调用 AI(不命中缓存)
    const cleared = await saveBaziRecord({ ...record, aiTasks: undefined, aiAnalysis: undefined, aiOverview: undefined, aiError: undefined, aiStatus: 'not_started' });
    try { await clearChartCache({ gender: record.gender, yearPillar: record.yearPillar, monthPillar: record.monthPillar, dayPillar: record.dayPillar, hourPillar: record.hourPillar }); } catch { /* 清缓存失败也继续 */ }
    onUpdated(cleared);
    await requestAnalysis(cleared, true);
  }
  const aiResults = Object.values(record.aiTasks ?? {});
  const byGroup = (key: string) => aiResults.filter((item) => item.task.type === key).sort((a, b) => (a.task.year ?? 0) - (b.task.year ?? 0) || (a.task.month ?? 0) - (b.task.month ?? 0));
  const bodyOf = (item: BaziTaskResult) => {
    const analysis = item.analysis;
    if (!analysis) return '';
    const parts: string[] = [];
    if (analysis.title) parts.push(analysis.title);
    if (analysis.pattern || analysis.strength) parts.push(['格局：' + analysis.pattern, '强弱：' + analysis.strength].filter(Boolean).join(' · '));
    if (analysis.explanation) parts.push(analysis.explanation);
    return parts.join('\n\n');
  };
  const copyAllResults = () => copy(scopeGroups.map((group) => {
    const items = byGroup(group.key);
    if (items.length === 0) return '';
    const head = '【' + group.title.replace(/^\d+\s*[①-⑨]?\s*/, '') + '】';
    const body = items.map((item) => describeScope(item, record) + (item.analysis?.explanation ? '\n' + bodyOf(item) : '')).join('\n\n');
    return head + '\n' + body;
  }).filter(Boolean).join('\n\n\n'));
  return <section className="detail-section" aria-labelledby="ai-title" aria-label="AI 分析">
    <div className="section-heading"><div><p className="eyebrow">03 / AI ANALYSIS</p><h2 id="ai-title">AI 分析</h2></div><div className="button-group"><button className="primary-button" type="button" onClick={() => void requestAnalysis()} disabled={record.aiStatus === 'pending'}>AI 分析</button>{record.aiStatus === 'pending' && <button className="text-button" type="button" onClick={() => { cancelRef.current = true; }}>停止（保存已完成）</button>}<button className="text-button" type="button" onClick={() => void clearAndReanalyze()} disabled={record.aiStatus === 'pending'}>真·清空并全量重算（删缓存）</button></div></div>
    <p className="ai-status" role="status">状态：{statusText[record.aiStatus]}</p>
    {hint && <p role="status">{hint}</p>}
    {(progress || (record.aiStatus === 'pending' && !progress)) && <div className="progress-block" aria-label="AI 分析进度">
      <p className="progress-text">任务 {progress?.done ?? 0} / {progress?.total ?? 25}：{progress?.label ?? '排队中'}…</p>
      <div className="progress-track" role="progressbar" aria-valuenow={progress?.done ?? 0} aria-valuemin={0} aria-valuemax={progress?.total ?? 25}><div className="progress-fill" style={{ width: `${Math.round(((progress?.done ?? 0) / (progress?.total ?? 25)) * 100)}%` }} /></div>
    </div>}
    {record.aiStatus === 'pending' && <p role="status">按任务逐个调用 AI（本命 → 每年 → 每月 → 总评），每个任务数秒到数十秒；进度即时保存，中断后重试会跳过已完成部分。</p>}
    {record.aiStatus === 'not_configured' && <p role="status">AI 尚未可用：请先点页面左上角「设置」，在服务一/服务二中任选一个填写访问凭据并保存，再回来点 AI 分析。</p>}
    {record.aiStatus === 'failed' && <p role="status">分析失败：请到「设置」确认密钥有效、所选服务可用后重试。</p>}
    {record.aiError && <p role="alert">原因：{safeAiError(record.aiError)}</p>}
    {record.aiAnalysis && <div className="long-text"><strong>格局与强弱</strong><p>{record.aiAnalysis.pattern || '—'} · {record.aiAnalysis.strength || '—'}</p><p>喜：{(record.aiAnalysis.usefulElements ?? []).join('、') || '—'}　忌：{(record.aiAnalysis.avoidElements ?? []).join('、') || '—'}</p><p>{record.aiAnalysis.explanation || '—'}</p></div>}
    {record.aiOverview && <div className="long-text"><strong>最终结论：八字总览、工作与生活方式</strong><p>格局：{record.aiOverview.pattern || '—'}　强弱：{record.aiOverview.strength || '—'}</p><p>喜：{(record.aiOverview.usefulElements ?? []).join('、') || '—'}　忌：{(record.aiOverview.avoidElements ?? []).join('、') || '—'}</p><p>{record.aiOverview.explanation || '—'}</p></div>}
    {aiResults.length > 0 && <div className="ai-scopes">
      <div className="section-heading"><div><h3>各范围分析结果</h3></div><button className="text-button" type="button" onClick={copyAllResults}>复制全部分析</button></div>
      {scopeGroups.map((group) => {
        const items = byGroup(group.key);
        if (items.length === 0) return null;
        return <section key={group.key} className="subsection scope-group" aria-label={group.title}><h4>{group.title}</h4>
          {items.map((item, idx) => {
            const analysis = item.analysis;
            const lead = analysis && (analysis.pattern || analysis.strength) ? <p className="scope-lead">格局：{analysis.pattern || '—'} · 强弱：{analysis.strength || '—'}　喜：{(analysis.usefulElements ?? []).join('、') || '—'}　忌：{(analysis.avoidElements ?? []).join('、') || '—'}</p> : null;
            return <details key={group.key + '-' + idx} className="scope-item" open={group.key === 'baseline' && item.status === 'completed'}>
              <summary>{describeScope(item, record)}<span className="scope-status">　{statusText[item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'not_configured']}</span></summary>
              {item.status === 'completed' && analysis ? <div className="scope-body">{analysis.title ? <p className="scope-title"><strong>{analysis.title}</strong></p> : null}{lead}<p style={{ whiteSpace: 'pre-wrap' }}>{analysis.explanation || '（无正文）'}</p></div> : item.status === 'failed' ? <p className="form-error">本次失败：{safeAiError(item.error ?? '未知错误')}</p> : item.status === 'not_configured' ? <p>未配置密钥，本项未生成。</p> : null}
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