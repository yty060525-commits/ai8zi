import { useState, type FormEvent } from 'react';
import type { BaziRecord } from '../../types/domain';
import { Modal } from '../../components/Modal';

interface BirthInputModalProps { open: boolean; onClose: () => void; onSubmit: (pillars: Pick<BaziRecord, 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'>) => void; /** 排盘引擎回传的校验错误(该月找不到日期/时柱不合)，必须显示在弹窗内 */ error?: string; }

const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const GZ = STEMS + BRANCHES;
/** 一柱两位：天干一位 + 地支一位。逐位过滤，粘错内容也只留合法字。 */
const cleanPair = (value: string) => {
  const s = value.replace(new RegExp('[^' + STEMS + ']', 'g'), '').slice(0, 1);
  const b = value.replace(new RegExp('[^' + BRANCHES + ']', 'g'), '').slice(0, 1);
  return s + b;
};
type PillarKey = keyof typeof PILLAR_TITLES;
const PILLAR_TITLES = { yearPillar: '年柱', monthPillar: '月柱', dayPillar: '日柱', hourPillar: '时柱' } as const;

export function BirthInputModal({ open, onClose, onSubmit, error: engineError }: BirthInputModalProps) {
  const [pillars, setPillars] = useState<Record<PillarKey, string>>({ yearPillar: '', monthPillar: '', dayPillar: '', hourPillar: '' });
  const [combined, setCombined] = useState('');
  const [error, setError] = useState('');
  if (!open) return null;
  /** 弹窗内报错优先；外层(排盘引擎)那条要等弹窗自己没报错时才顶上来 —— 见下面渲染处。 */
  const shown = error || engineError;
  /** 整串 → 四柱：只认干支汉字，空格与标点忽略；满八字即拆入四栏。 */
  function onCombined(value: string) {
    setCombined(value);
    const cleaned = value.replace(new RegExp('[^' + GZ + ']', 'g'), '');
    setCombined(cleaned);
    if (cleaned.length >= 8) {
      setPillars({ yearPillar: cleaned.slice(0, 2), monthPillar: cleaned.slice(2, 4), dayPillar: cleaned.slice(4, 6), hourPillar: cleaned.slice(6, 8) });
    }
  }
  function onPillar(key: PillarKey, value: string) {
    setError('');
    // 改动任一柱就丢弃整串栏：两者不一致时以最后编辑的为准，避免提交的是看不见的旧值。
    setCombined('');
    setPillars((current) => ({ ...current, [key]: cleanPair(value) }));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const incomplete = (Object.keys(PILLAR_TITLES) as PillarKey[]).find((k) => pillars[k].length !== 2);
    if (incomplete) { setError(PILLAR_TITLES[incomplete] + '要填满两个字(一天干、一地支)，四柱都要填'); return; }
    const badYy = (Object.keys(PILLAR_TITLES) as PillarKey[]).find((k) => (STEMS.indexOf(pillars[k][0]) & 1) !== (BRANCHES.indexOf(pillars[k][1]) & 1));
    if (badYy) { setError(PILLAR_TITLES[badYy] + '「' + pillars[badYy] + '」不成柱：天干与地支要同阴阳(如甲子、乙丑)，干支里不存在这一柱'); return; }
    setError(''); onSubmit(pillars);
  }
  const field = (label: PillarKey) => <label>{PILLAR_TITLES[label]}<input required={!combined} value={pillars[label]} maxLength={2} inputMode="text" autoComplete="off" placeholder={label === 'yearPillar' ? '如 甲子' : ''} onChange={(event) => onPillar(label, event.target.value)} /></label>;
  return <Modal title="四柱八字" onClose={onClose}><form className="input-form" onSubmit={submit}>
    {(shown) && <p className="form-error" role="alert">{shown}</p>}
    <label>八字整串（八个字一起输，自动分成四柱；也可只用这一栏）<input value={combined} maxLength={8} autoComplete="off" placeholder="例如 甲子丙寅戊辰庚申" onChange={(event) => { setError(''); onCombined(event.target.value); }} /></label>
    <div className="field-grid">{field('yearPillar')}{field('monthPillar')}{field('dayPillar')}{field('hourPillar')}</div>
    <button className="primary-button" type="submit">提交</button>
  </form></Modal>;
}
