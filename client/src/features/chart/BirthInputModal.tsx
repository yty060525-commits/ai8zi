import { useState, type FormEvent } from 'react';
import type { BaziRecord } from '../../types/domain';
import { Modal } from '../../components/Modal';

interface BirthInputModalProps { open: boolean; onClose: () => void; onSubmit: (pillars: Pick<BaziRecord, 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'>) => void; }

const GZ = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
export function BirthInputModal({ open, onClose, onSubmit }: BirthInputModalProps) {
  const [pillars, setPillars] = useState({ yearPillar: '', monthPillar: '', dayPillar: '', hourPillar: '' });
  const [combined, setCombined] = useState('');
  const [error, setError] = useState('');
  if (!open) return null;
  function onCombined(value: string) {
    setCombined(value);
    const cleaned = value.replace(new RegExp('[^' + GZ + ']', 'g'), '');
    if (cleaned.length >= 8) {
      setPillars({ yearPillar: cleaned.slice(0, 2), monthPillar: cleaned.slice(2, 4), dayPillar: cleaned.slice(4, 6), hourPillar: cleaned.slice(6, 8) });
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (Object.values(pillars).some((value) => !/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/.test(value))) {
      setError('四柱必须是两个天干地支汉字'); return;
    }
    setError(''); onSubmit(pillars);
  }
  const field = (label: keyof typeof pillars, title: string) => <label>{title}<input required={!combined} value={pillars[label]} onChange={(event) => { setError(''); setCombined(''); setPillars((current) => ({ ...current, [label]: event.target.value })); }} /></label>;
  return <Modal title="四柱八字" onClose={onClose}><form className="input-form" onSubmit={submit}>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="field-grid">{field('yearPillar', '年柱')}{field('monthPillar', '月柱')}{field('dayPillar', '日柱')}{field('hourPillar', '时柱')}</div>
    <label>八字整串（八个字一起输，自动分成四柱；也可只用这一栏）<input value={combined} placeholder="例如 甲子 丙寅 戊辰 庚申" onChange={(event) => { setError(''); onCombined(event.target.value); }} /></label>
    <button className="primary-button" type="submit">提交</button>
  </form></Modal>;
}