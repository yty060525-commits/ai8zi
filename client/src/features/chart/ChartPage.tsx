import { useEffect, useState } from 'react';
import type { BaziRecord, Gender } from '../../types/domain';
import { BirthInputModal } from './BirthInputModal';
import { ChartChat, scrollToChat } from './ChartChat';
import { loadTrueSolarProvinces } from './trueSolarCities';
import type { SolarProvince } from './trueSolarCities';


type Pillars = Pick<BaziRecord, 'yearPillar' | 'monthPillar' | 'dayPillar' | 'hourPillar'>;
interface ChartPageProps { onRecordCreated?: (record: Omit<BaziRecord, 'id' | 'aiStatus'>) => void; }

export function ChartPage({ onRecordCreated }: ChartPageProps) {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [calendar, setCalendar] = useState<'solar' | 'lunar'>('solar');
  const [leapMonth, setLeapMonth] = useState(false);
  const [name, setName] = useState(''); const [birthYear, setBirthYear] = useState(''); const [birthMonth, setBirthMonth] = useState('');
  const [birthDay, setBirthDay] = useState(''); const [birthHour, setBirthHour] = useState(''); const [birthMinute, setBirthMinute] = useState('');
  const [gender, setGender] = useState<Gender>('male'); const [open, setOpen] = useState(false); const [error, setError] = useState('');
  // 真太阳时选点：省→市→区(区县)。整表 ~92KB，进首屏不加载，挂载后惰性取一次填入下拉。
  const [provinces, setProvinces] = useState<SolarProvince[]>([]);
  const [tsProvince, setTsProvince] = useState('off'); const [tsCity, setTsCity] = useState(''); const [tsDistrict, setTsDistrict] = useState(''); const [tsLng, setTsLng] = useState('');
  useEffect(() => { let on = true; void loadTrueSolarProvinces().then((p) => { if (on) setProvinces(p); }); return () => { on = false; }; }, []);
  /** 拿到四柱后统一走这条：定位出生日期、算非 AI 事实、存库、跳转。手动/自动两条录入路径共用。 */
  async function savePillars(pillars: Pillars, year: number, month: number) {
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
  /** 手动录入四柱：只校验姓名与生年/生月(用于在该月内定位具体生日)。 */
  async function createRecord(pillars: Pillars) {
    if (!name.trim()) { setError('请输入姓名'); return; }
    const year = Number(birthYear); const month = Number(birthMonth);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) { setError('出生年和出生月必须为整数'); return; }
    await savePillars(pillars, year, month);
  }
  const selectedProvince = provinces.find((p) => p.name === tsProvince);
  const selectedCity = selectedProvince?.cities.find((c) => c.name === tsCity);
  /** 解析真太阳时用经度：关=不修正(null)；自定义=手填；省市区=取最深一级(有区用区、无区用市)。
   *  未选到足够粒度 / 自定义非法 → 返回 {error} 文案，交由 autoCreate 直接提示。 */
  function resolveSolarLongitude(): { lng: number } | { error: string } {
    if (tsProvince === 'custom') { const v = Number(tsLng); return tsLng !== '' && Number.isFinite(v) ? { lng: v } : { error: '请填写有效的出生地经度' }; }
    if (!selectedCity) return { error: '请选择出生所在城市' };
    if (selectedCity.districts?.length) {
      const d = selectedCity.districts.find((x) => x.name === tsDistrict);
      return d ? { lng: d.lng } : { error: '请选择出生所在区/县' };
    }
    return { lng: selectedCity.lng };
  }
  /** 按生日自动排盘：先定公历日期(农历则换算)，再(可选)真太阳时修正，最后正向算四柱保存。 */
  async function autoCreate() {
    if (!name.trim()) { setError('请输入姓名'); return; }
    const year = Number(birthYear); const month = Number(birthMonth); const day = Number(birthDay);
    const hour = birthHour === '' ? 0 : Number(birthHour); const minute = birthMinute === '' ? 0 : Number(birthMinute);
    const lunar = calendar === 'lunar';
    if (!Number.isInteger(year) || year < 1 || year > 9999) { setError('出生年应为 1–9999 的整数'); return; }
    if (!Number.isInteger(month) || month < 1 || month > 12) { setError(lunar ? '农历月应为 1–12 的整数' : '出生月应为 1–12 的整数'); return; }
    if (!Number.isInteger(day) || day < 1 || day > (lunar ? 30 : 31)) { setError(lunar ? '农历日应为 1–30 的整数' : '出生日应为 1–31 的整数'); return; }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) { setError('时应为 0–23 的整数'); return; }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) { setError('分应为 0–59 的整数'); return; }
    // 1) 定公历日期：农历(闰月传负月)先换算，换算后一律按公历继续
    let dt: { year: number; month: number; day: number; hour: number; minute: number };
    if (lunar) {
      try {
        const { lunarToSolar } = await import('./nonAiCalculator');
        const solar = lunarToSolar(year, leapMonth ? -month : month, day);
        dt = { ...solar, hour, minute };
      } catch { setError('该农历日期不存在，请核对月份、闰月与初几'); return; }
    } else {
      const probe = new Date(year, month - 1, day);
      if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) { setError('该日期不存在，请核对'); return; }
      dt = { year, month, day, hour, minute };
    }
    // 2) 真太阳时：在公历钟点上按经度差修正(东加西减，每度 4 分)，可能改时辰、跨子夜改公历日
    if (tsProvince !== 'off') {
      const r = resolveSolarLongitude();
      if ('error' in r) { setError(r.error); return; }
      if (r.lng < -180 || r.lng > 180) { setError('经度应在 −180 到 180 之间'); return; }
      try {
        const { applyTrueSolar } = await import('./nonAiCalculator');
        dt = applyTrueSolar(dt, r.lng);
      } catch (cause) { setError(cause instanceof Error ? cause.message : '真太阳时换算失败'); return; }
    }
    // 3) 正向算四柱并保存(存的是最终公历年月，与引擎定位口径一致)
    let pillars: Pillars;
    try {
      const { computePillarsFromDate } = await import('./nonAiCalculator');
      pillars = computePillarsFromDate(dt);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '四柱无法计算'); return; }
    await savePillars(pillars, dt.year, dt.month);
  }
  const numField = (label: string, value: string, set: (v: string) => void, extra: Record<string, string | number> = {}) =>
    <label>{label}<input type="number" step={1} value={value} onChange={(e) => { setError(''); set(e.target.value); }} {...extra} /></label>;
  const cityLevel = selectedProvince?.municipality ? '区' : '市';
  const showDistricts = !!selectedCity?.districts?.length;
  return <main className="chart-page"><header className="page-heading"><p className="eyebrow">LOCAL WORKSPACE</p><h1>排盘</h1><p>{mode === 'auto' ? '输入出生日期和时辰，自动排四柱八字并保存。' : '输入基本信息和四柱八字，保存一条记录。'}</p>
    <p className="chat-shortcut"><button className="text-button" type="button" onClick={scrollToChat}>问问 AI ›</button></p></header>
    <div className="button-group mode-switch" role="group" aria-label="排盘方式">
      {(['auto', 'manual'] as const).map((item) => <button type="button" key={item} className={mode === item ? 'choice-button selected' : 'choice-button'} onClick={() => { setError(''); setMode(item); }} aria-pressed={mode === item}>{item === 'auto' ? '按生日排' : '手录四柱'}</button>)}
    </div>
    <section className="form-section" aria-label="排盘基本信息"><div className="field-grid"><label>姓名<input required value={name} onChange={(e) => { setError(''); setName(e.target.value); }} placeholder="请输入姓名" /></label>{numField('出生年', birthYear, setBirthYear, { required: 1, min: 1, max: 9999, placeholder: '如 1990' })}{numField(mode === 'auto' && calendar === 'lunar' ? '月(农历)' : '出生月', birthMonth, setBirthMonth, { required: 1, min: 1, max: 12 })}{mode === 'auto' && numField(mode === 'auto' && calendar === 'lunar' ? '日(初几)' : '出生日', birthDay, setBirthDay, { required: 1, min: 1, max: calendar === 'lunar' ? 30 : 31 })}{mode === 'auto' && numField('时(0–23)', birthHour, setBirthHour, { min: 0, max: 23 })}{mode === 'auto' && numField('分(0–59)', birthMinute, setBirthMinute, { min: 0, max: 59 })}</div>
      {mode === 'auto' && <div className="button-group calendar-switch" role="group" aria-label="历法"><button type="button" className={calendar === 'solar' ? 'choice-button selected' : 'choice-button'} onClick={() => { setError(''); setCalendar('solar'); setLeapMonth(false); }} aria-pressed={calendar === 'solar'}>阳历(公历)</button><button type="button" className={calendar === 'lunar' ? 'choice-button selected' : 'choice-button'} onClick={() => { setError(''); setCalendar('lunar'); }} aria-pressed={calendar === 'lunar'}>农历(夏历)</button>{calendar === 'lunar' && <label className="checkbox-inline"><input type="checkbox" checked={leapMonth} onChange={(e) => { setError(''); setLeapMonth(e.target.checked); }} />闰月</label>}</div>}
      <fieldset className="gender-field"><legend>性别</legend><div className="button-group">{(['male', 'female'] as Gender[]).map((item) => <button type="button" key={item} className={gender === item ? 'choice-button selected' : 'choice-button'} onClick={() => setGender(item)} aria-pressed={gender === item}>{item === 'male' ? '男' : '女'}</button>)}</div></fieldset>
      {mode === 'auto' && <div className="field-grid true-solar"><label>真太阳时·省
        <select value={tsProvince} onChange={(e) => { setError(''); setTsProvince(e.target.value); setTsCity(''); setTsDistrict(''); }}>
          <option value="off">关(用所填钟点)</option>
          {provinces.map((p) => <option value={p.name} key={p.name}>{p.name}</option>)}
          {provinces.length === 0 && <option disabled value="">加载中…</option>}
          <option value="custom">自定义经度…</option>
        </select>
      </label>{tsProvince !== 'off' && tsProvince !== 'custom' && <label>{cityLevel}
        <select value={tsCity} onChange={(e) => { setError(''); setTsCity(e.target.value); setTsDistrict(''); }}>
          <option value="">{`请选择${cityLevel}`}</option>
          {selectedProvince?.cities.map((c) => <option value={c.name} key={c.name}>{c.name}</option>)}
        </select>
      </label>}{showDistricts && <label>区/县
        <select value={tsDistrict} onChange={(e) => { setError(''); setTsDistrict(e.target.value); }}>
          <option value="">请选择区/县</option>
          {selectedCity?.districts?.map((d) => <option value={d.name} key={d.name}>{d.name}</option>)}
        </select>
      </label>}{tsProvince === 'custom' && numField('出生地经度(°E)', tsLng, setTsLng, { min: -180, max: 180, step: 0.1, placeholder: '如 87.6' })}</div>}
      {mode === 'auto' && <p className="field-hint">{calendar === 'lunar' ? '农历按夏历输入，闰月出生请勾选「闰月」；' : ''}命盘年柱以立春为界，时辰按十二时辰、23 点后归当日子时(与命盘校验同口径)。真太阳时按所选地经度做「北京时 +（经度−120）×4 分」的东加西减修正，与主流排盘一致(不计均时差)。</p>}
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    {mode === 'auto'
      ? <button className="primary-button" type="button" onClick={() => { void autoCreate(); }}>排盘并保存</button>
      : <button className="primary-button" type="button" onClick={() => setOpen(true)}>录入四柱八字</button>}
    {/* 四柱校验(该月找不到日期/时柱不合)是在弹窗提交后才报错的：弹窗还开着时，
        上面那行错误在遮罩后面、手机上又往往滚不到，用户只看到「点了提交没反应」。
        所以弹窗内也要出现这一条。 */}
    <BirthInputModal open={open} onClose={() => { setError(''); setOpen(false); }} onSubmit={(pillars) => createRecord(pillars)} error={error} />
    <ChartChat />
  </main>;
}
