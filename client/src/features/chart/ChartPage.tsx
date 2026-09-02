import { useState } from 'react';
import type { BaziRecord, Gender } from '../../types/domain';
import { BirthInputModal } from './BirthInputModal';


interface ChartPageProps { onRecordCreated?: (record: Omit<BaziRecord, 'id' | 'aiStatus'>) => void; }

export function ChartPage({ onRecordCreated }: ChartPageProps) {
  const [name, setName] = useState(''); const [birthYear, setBirthYear] = useState(''); const [birthMonth, setBirthMonth] = useState('');
  const [gender, setGender] = useState<Gender>('male'); const [open, setOpen] = useState(false); const [error, setError] = useState('');
  async function createRecord(pillars: Pick<BaziRecord, 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'>) {
    if (!name.trim()) { setError('请输入姓名'); return; }
    const year = Number(birthYear); const month = Number(birthMonth);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) { setError('出生年和出生月必须为整数'); return; }
    const createdAt = new Date().toISOString();
    let nonAiResult;
    try {
      // 历法引擎按需加载(动态分包)，不占首屏
      const { calculateNonAi } = await import('./nonAiCalculator');
      nonAiResult = calculateNonAi({ birthYear: year, birthMonth: month, ...pillars }, gender, createdAt);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '四柱无法计算'); return; }
    const record: Omit<BaziRecord, 'id' | 'aiStatus'> = { name: name.trim(), gender, birthYear: year, birthMonth: month, createdAt, ...pillars, nonAiResult };
    setError(''); setOpen(false); onRecordCreated?.(record);
  }
  return <main className="chart-page"><header className="page-heading"><p className="eyebrow">LOCAL WORKSPACE</p><h1>排盘</h1><p>输入基本信息和四柱八字，保存一条记录。</p></header>
    <section className="form-section" aria-label="排盘基本信息"><div className="field-grid"><label>姓名<input required value={name} onChange={(e) => { setError(''); setName(e.target.value); }} placeholder="请输入姓名" /></label><label>出生年<input required type="number" step="1" value={birthYear} onChange={(e) => { setError(''); setBirthYear(e.target.value); }} /></label><label>出生月<input required type="number" min="1" max="12" step="1" value={birthMonth} onChange={(e) => { setError(''); setBirthMonth(e.target.value); }} /></label></div>
      <fieldset className="gender-field"><legend>性别</legend><div className="button-group">{(['male', 'female'] as Gender[]).map((item) => <button type="button" key={item} className={gender === item ? 'choice-button selected' : 'choice-button'} onClick={() => setGender(item)} aria-pressed={gender === item}>{item === 'male' ? '男' : '女'}</button>)}</div></fieldset>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" type="button" onClick={() => setOpen(true)}>录入四柱八字</button>
    <BirthInputModal open={open} onClose={() => setOpen(false)} onSubmit={(pillars) => createRecord(pillars)} />
  </main>;
}