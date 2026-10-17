import { useEffect, useRef, useState, type CompositionEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { BaziRecord } from '../../types/domain';
import { Modal } from '../../components/Modal';

interface BirthInputModalProps { open: boolean; onClose: () => void; onSubmit: (pillars: Pick<BaziRecord, 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'>) => void; /** 排盘引擎回传的校验错误(该月找不到日期/时柱不合)，必须显示在弹窗内 */ error?: string; /** 详情页「修正四柱」用：把当前命盘的四柱预填进来(#151)。缺省即新建时的空表。 */ initial?: Partial<Pick<BaziRecord, 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'>>; /** 提交按钮文案：建盘是「提交」，修正是「保存修正」，别让改完的人以为又建了一条。 */ submitLabel?: string; }

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

/** 预填值必须过同一道 cleanPair：外部传进非法字符时截成合法一柱，而不是让非法字直接躺在输入框里提交。 */
const initialPillars = (initial?: BirthInputModalProps['initial']): Record<PillarKey, string> => {
  const empty = { yearPillar: '', monthPillar: '', dayPillar: '', hourPillar: '' };
  if (!initial) return empty;
  const out = { ...empty };
  for (const key of Object.keys(empty) as PillarKey[]) { const v = initial[key]; if (v) out[key] = cleanPair(v); }
  return out;
};

export function BirthInputModal({ open, onClose, onSubmit, error: engineError, initial, submitLabel = '提交' }: BirthInputModalProps) {
  const [pillars, setPillars] = useState<Record<PillarKey, string>>(() => initialPillars(initial));
  const [combined, setCombined] = useState('');
  const [error, setError] = useState('');
  const composing = useRef<PillarKey | 'combined' | null>(null);
  const suppressCompositionSubmit = useRef(false);
  useEffect(() => {
    if (open) return;
    suppressCompositionSubmit.current = false;
    if (composing.current === null) return;
    const key = composing.current;
    composing.current = null;
    if (key === 'combined') finishCombined(combined);
    else {
      setCombined('');
      setPillars((current) => ({ ...current, [key]: cleanPair(current[key]) }));
    }
  }, [combined, open]);
  if (!open) return null;
  /** 弹窗内报错优先；外层(排盘引擎)那条要等弹窗自己没报错时才顶上来 —— 见下面渲染处。 */
  const shown = error || engineError;
  /** 整串 → 四柱：只认干支汉字，空格与标点忽略；满八字即拆入四栏。 */
  function finishCombined(value: string) {
    const cleaned = value.replace(new RegExp('[^' + GZ + ']', 'g'), '').slice(0, 8);
    setCombined(cleaned);
    if (cleaned.length >= 8) {
      setPillars({ yearPillar: cleaned.slice(0, 2), monthPillar: cleaned.slice(2, 4), dayPillar: cleaned.slice(4, 6), hourPillar: cleaned.slice(6, 8) });
    }
  }
  function onCombined(value: string) {
    if (composing.current === 'combined') setCombined(value);
    else finishCombined(value);
  }
  function onCompositionEnd(key: PillarKey | 'combined', event: CompositionEvent<HTMLInputElement>) {
    if (composing.current !== key) return;
    composing.current = null;
    const value = event.currentTarget.value;
    if (key === 'combined') finishCombined(value);
    else {
      setCombined('');
      setPillars((current) => ({ ...current, [key]: cleanPair(value) }));
    }
  }
  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && (composing.current !== null || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
      suppressCompositionSubmit.current = true;
      window.setTimeout(() => { suppressCompositionSubmit.current = false; }, 0);
    }
  }
  function onPillar(key: PillarKey, value: string) {
    setError('');
    setCombined('');
    if (composing.current === key) {
      setPillars((current) => ({ ...current, [key]: value }));
      return;
    }
    // 改动任一柱就丢弃整串栏：两者不一致时以最后编辑的为准，避免提交的是看不见的旧值。
    setPillars((current) => ({ ...current, [key]: cleanPair(value) }));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composing.current !== null || suppressCompositionSubmit.current) { suppressCompositionSubmit.current = false; return; }
    const incomplete = (Object.keys(PILLAR_TITLES) as PillarKey[]).find((k) => pillars[k].length !== 2);
    if (incomplete) { setError(PILLAR_TITLES[incomplete] + '要填满两个字，一天干、一地支，四柱都要填'); return; }
    const badYy = (Object.keys(PILLAR_TITLES) as PillarKey[]).find((k) => (STEMS.indexOf(pillars[k][0]) & 1) !== (BRANCHES.indexOf(pillars[k][1]) & 1));
    if (badYy) { setError(PILLAR_TITLES[badYy] + pillars[badYy] + '不成柱：天干与地支要同阴阳，如甲子、乙丑，干支里不存在这一柱'); return; }
    setError(''); onSubmit(pillars);
  }
  const field = (label: PillarKey) => <label>{PILLAR_TITLES[label]}<input required={!combined} value={pillars[label]} inputMode="text" autoComplete="off" placeholder={label === 'yearPillar' ? '如 甲子' : ''} onCompositionStart={() => { composing.current = label; }} onCompositionEnd={(event) => onCompositionEnd(label, event)} onKeyDown={onInputKeyDown} onChange={(event) => onPillar(label, event.target.value)} /></label>;
  return <Modal title="四柱八字" onClose={onClose}><form className="input-form" onSubmit={submit}>
    {(shown) && <p className="form-error" role="alert">{shown}</p>}
    <label>八字整串，八个字一起输、自动分成四柱，也可只用这一栏<input value={combined} autoComplete="off" placeholder="例如 甲子丙寅戊辰庚申" onCompositionStart={() => { composing.current = 'combined'; }} onCompositionEnd={(event) => onCompositionEnd('combined', event)} onKeyDown={onInputKeyDown} onChange={(event) => { setError(''); onCombined(event.target.value); }} /></label>
    <div className="field-grid">{field('yearPillar')}{field('monthPillar')}{field('dayPillar')}{field('hourPillar')}</div>
    <button className="primary-button" type="submit">{submitLabel}</button>
  </form></Modal>;
}
