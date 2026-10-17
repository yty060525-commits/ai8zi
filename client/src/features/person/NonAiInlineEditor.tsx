import type { ReactNode } from 'react';

/** 分重在数据契约中是中文重量，输入时统一以两为单位。 */
export const weightNumber = (text: string): number => {
  if (text && !/[两钱零]/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  const read = (value: string): number => value.includes('十')
    ? (digits.indexOf(value.split('十')[0]) || 1) * 10 + Math.max(0, digits.indexOf(value.split('十')[1] ?? '零'))
    : Math.max(0, digits.indexOf(value));
  const [whole, rest] = text.includes('两') ? text.split('两') : ['', text];
  return (whole ? read(whole) : 0) + (rest?.includes('钱') ? read(rest.replace('钱', '')) / 10 : 0);
};
export const weightText = (value: string): string => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 99.9 || Math.abs(number * 10 - Math.round(number * 10)) > 1e-8) return value;
  const digits = '零一二三四五六七八九';
  const whole = Math.floor(number), fraction = Math.round(number * 10) % 10;
  const cn = whole < 10 ? digits[whole] : (whole < 20 ? '十' : digits[Math.floor(whole / 10)] + '十') + (whole % 10 ? digits[whole % 10] : '');
  return (whole ? cn + '两' : '') + (fraction ? digits[fraction] + '钱' : whole ? '' : '零');
};

interface InlineValueProps {
  label: string;
  value: string;
  editing: boolean;
  type?: 'text' | 'number' | 'date';
  step?: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}

export function InlineValue({ label, value, editing, type = 'text', step, min, max, onChange }: InlineValueProps) {
  if (!editing) return <>{value || '暂无'}</>;
  return <label className="non-ai-inline-field">{label}<input aria-label={label} type={type} value={value} step={step} min={min} max={max} onChange={(event) => onChange(event.target.value)} /></label>;
}

interface InlineListProps {
  label: string;
  values: string[];
  editing: boolean;
  maxItems?: number;
  onChange: (values: string[]) => void;
}

export function InlineList({ label, values, editing, maxItems = 20, onChange }: InlineListProps) {
  if (!editing) return <>{values.join('、') || '暂无'}</>;
  return <fieldset className="non-ai-inline-list" aria-label={label}>
    <legend>{label}</legend>
    {values.map((value, index) => <div className="non-ai-inline-row" key={index}>
      <input aria-label={`${label}第${index + 1}项`} value={value} onChange={(event) => onChange(values.map((item, i) => i === index ? event.target.value : item))} />
      <button type="button" className="text-button tiny" aria-label={`${label}删除第${index + 1}项`} onClick={() => onChange(values.filter((_, i) => i !== index))}>删除</button>
    </div>)}
    {values.length < maxItems ? <button type="button" className="text-button tiny" aria-label={`${label}添加一项`} onClick={() => onChange([...values, ''])}>添加</button> : null}
  </fieldset>;
}

interface InlineHiddenGodsProps {
  label: string;
  values: Array<{ stem: string; tenGod: string; position: 'root' | 'middle' | 'residual' }>;
  editing: boolean;
  onChange: (values: InlineHiddenGodsProps['values']) => void;
}

export function InlineHiddenGods({ label, values, editing, onChange }: InlineHiddenGodsProps) {
  if (!editing) return <>{values.map((item) => item.stem + item.tenGod).join('、') || '暂无'}</>;
  const normalize = (items: InlineHiddenGodsProps['values']) => items.map((item, index) => ({ ...item, position: (['root', 'middle', 'residual'] as const)[index] }));
  return <fieldset className="non-ai-inline-list" aria-label={label}>
    <legend>{label}</legend>
    {values.map((item, index) => <div className="non-ai-inline-row" key={index}>
      <input aria-label={`${label}第${index + 1}项天干`} value={item.stem} onChange={(event) => onChange(normalize(values.map((value, i) => i === index ? { ...value, stem: event.target.value } : value)))} />
      <input aria-label={`${label}第${index + 1}项十神`} value={item.tenGod} onChange={(event) => onChange(normalize(values.map((value, i) => i === index ? { ...value, tenGod: event.target.value } : value)))} />
      <button type="button" className="text-button tiny" aria-label={`${label}删除第${index + 1}项`} onClick={() => onChange(normalize(values.filter((_, i) => i !== index)))}>删除</button>
    </div>)}
    {values.length < 3 ? <button type="button" className="text-button tiny" aria-label={`${label}添加一项`} onClick={() => onChange(normalize([...values, { stem: '', tenGod: '', position: 'root' }]))}>添加</button> : null}
  </fieldset>;
}

export function InlineEditActions({ editing, disabled, onEdit, onSave, onCancel }: {
  editing: boolean; disabled: boolean; onEdit: () => void; onSave: () => void; onCancel: () => void;
}) {
  return <div className="button-group non-ai-inline-actions">
    {editing ? <>
      <button type="button" className="primary-button" onClick={onSave} disabled={disabled}>保存修改</button>
      <button type="button" className="text-button" onClick={onCancel} disabled={disabled}>取消</button>
    </> : <button type="button" className="text-button" onClick={onEdit} disabled={disabled}>编辑数据</button>}
  </div>;
}

export function EditMessage({ children }: { children: ReactNode }) {
  return <p className="non-ai-edit-message" role="status">{children}</p>;
}
