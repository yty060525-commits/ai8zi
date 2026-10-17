import type {
  FiveElement, FortuneIndex, ManualNonAiEdits, ManualNonAiFields, NonAiChart,
  PillarKey, RelationshipFacts,
} from '../types/domain';
// @ts-ignore Native Node also loads this shared module; it requires the real .ts extension.
import { interpersonalZodiac } from '../utils/interpersonal.ts';

const pillars: Record<PillarKey, number> = { year: 0, month: 1, day: 2, hour: 3 };
const elements: FiveElement[] = ['木', '火', '土', '金', '水'];
const pillarKeys: PillarKey[] = ['year', 'month', 'day', 'hour'];
const fortuneIndexes: FortuneIndex[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const chineseDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const cnSmall = (n: number): string => n < 10 ? chineseDigits[n] : (n < 20 ? '十' : chineseDigits[Math.floor(n / 10)] + '十') + (n % 10 ? chineseDigits[n % 10] : '');

function liangText(liang: number): string {
  const units = Math.round(liang * 10);
  const whole = Math.floor(units / 10);
  const qian = units % 10;
  return (whole > 0 ? cnSmall(whole) + '两' : '') + (qian > 0 ? chineseDigits[qian] + '钱' : whole > 0 ? '' : '零');
}

function parseLiangText(text: string): number | undefined {
  if (text === '零') return 0;
  const numeral = (char: string | undefined): number | undefined => char === undefined ? 0 : chineseDigits.indexOf(char) >= 0 ? chineseDigits.indexOf(char) : undefined;
  const liang = text.indexOf('两');
  const qian = text.indexOf('钱');
  if (liang < 0 && qian < 0) return undefined;
  const whole = liang >= 0 ? Array.from({ length: 100 }, (_, n) => cnSmall(n)).indexOf(text.slice(0, liang)) : 0;
  const fraction = qian >= 0 ? numeral(text[qian - 1]) : 0;
  if (whole < 0 || fraction === undefined || text !== liangText(whole + fraction / 10)) return undefined;
  return whole + fraction / 10;
}

function mergeFields(left: ManualNonAiFields = {}, right: ManualNonAiFields = {}): ManualNonAiFields {
  const result: ManualNonAiFields = { ...left, ...right };
  if (left.elements || right.elements) result.elements = { ...left.elements, ...right.elements };
  if (left.elementRatio || right.elementRatio) result.elementRatio = { ...left.elementRatio, ...right.elementRatio };
  if (left.hiddenStems || right.hiddenStems) result.hiddenStems = { ...left.hiddenStems, ...right.hiddenStems };
  if (left.tenGods || right.tenGods) result.tenGods = { ...left.tenGods, ...right.tenGods };
  if (left.naYin || right.naYin) result.naYin = { ...left.naYin, ...right.naYin };
  if (left.twelveLongevity || right.twelveLongevity) result.twelveLongevity = { ...left.twelveLongevity, ...right.twelveLongevity };
  if (left.luckStart || right.luckStart) result.luckStart = { ...left.luckStart, ...right.luckStart };
  if (right.luckStart?.date !== undefined) result.luckOnset = right.luckStart.date;
  if (right.luckOnset !== undefined) result.luckStart = { ...result.luckStart, date: right.luckOnset };
  if (left.relationships || right.relationships) result.relationships = { ...left.relationships, ...right.relationships };
  if (left.zodiacCompatibility || right.zodiacCompatibility) result.zodiacCompatibility = { ...left.zodiacCompatibility, ...right.zodiacCompatibility };
  if (left.tenGodDetails?.hidden || right.tenGodDetails?.hidden) {
    result.tenGodDetails = { ...left.tenGodDetails, ...right.tenGodDetails,
      hidden: { ...left.tenGodDetails?.hidden, ...right.tenGodDetails?.hidden } };
  }
  if (left.chenggu || right.chenggu) {
    result.chenggu = { ...left.chenggu, ...right.chenggu,
      parts: { ...left.chenggu?.parts, ...right.chenggu?.parts } };
    if (right.chenggu?.totalLiang !== undefined) result.chenggu.totalText = liangText(right.chenggu.totalLiang);
    else if (right.chenggu?.totalText !== undefined) result.chenggu.totalLiang = parseLiangText(right.chenggu.totalText);
  }
  if (left.greatFortunes || right.greatFortunes) {
    const fortunes: Partial<Record<FortuneIndex, NonNullable<ManualNonAiFields['greatFortunes']>[FortuneIndex]>> = { ...left.greatFortunes, ...right.greatFortunes };
    for (const index of fortuneIndexes) {
      if (left.greatFortunes?.[index] || right.greatFortunes?.[index]) {
        fortunes[index] = { ...left.greatFortunes?.[index], ...right.greatFortunes?.[index] };
      }
    }
    result.greatFortunes = fortunes;
  }
  return result;
}

export function mergeManualNonAiEdits(previous: ManualNonAiEdits | undefined, fields: ManualNonAiFields): ManualNonAiEdits {
  return { version: 1, fields: mergeFields(previous?.fields, fields) };
}

function applyColumn<T>(values: T[] = [], changes: Partial<Record<PillarKey, T>> | undefined): T[] {
  if (!changes) return values;
  let result: T[] | undefined;
  for (const key of pillarKeys) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      result ??= values.slice();
      result[pillars[key]] = structuredClone(changes[key] as T);
    }
  }
  return result ?? values;
}

function applyElementValues(base: Record<string, number> = {}, patch: Partial<Record<FiveElement, number>> | undefined): Record<string, number> {
  return patch ? { ...base, ...patch } : base;
}

export function applyManualNonAi(base: NonAiChart, edits?: ManualNonAiEdits): NonAiChart {
  if (!edits || edits.version !== 1) return base;
  const f = edits.fields;
  const next: NonAiChart = { ...base, manualEdits: { version: 1, fields: mergeFields({}, f) } };
  next.elements = applyElementValues(base.elements, f.elements);
  next.elementRatio = applyElementValues(base.elementRatio, f.elementRatio);
  next.hiddenStems = applyColumn(base.hiddenStems, f.hiddenStems);
  next.tenGods = applyColumn(base.tenGods, f.tenGods);
  next.naYin = applyColumn(base.naYin, f.naYin);
  next.twelveLongevity = applyColumn(base.twelveLongevity, f.twelveLongevity);
  if (f.tenGods) next.tenGodDetails = { ...base.tenGodDetails, heavenly: next.tenGods };
  if (f.tenGodDetails?.hidden) {
    next.tenGodDetails = { ...base.tenGodDetails, heavenly: base.tenGodDetails?.heavenly ?? base.tenGods ?? [], hidden: applyColumn(base.tenGodDetails?.hidden, f.tenGodDetails.hidden) };
    if (f.tenGods) next.tenGodDetails.heavenly = next.tenGods;
  }
  if (f.luckStart) {
    next.luckStart = { ...(base.luckStart ?? { years: 0, months: 0, days: 0, date: '' }), ...f.luckStart };
    if (Object.prototype.hasOwnProperty.call(f.luckStart, 'date')) next.luckOnset = f.luckStart.date;
  }
  if (Object.prototype.hasOwnProperty.call(f, 'luckOnset')) {
    next.luckOnset = f.luckOnset;
    next.luckStart = { ...(next.luckStart ?? { years: 0, months: 0, days: 0, date: '' }), date: f.luckOnset as string };
  }
  if (f.chenggu) {
    const totalLiang = Object.prototype.hasOwnProperty.call(f.chenggu, 'totalLiang')
      ? f.chenggu.totalLiang
      : f.chenggu.totalText !== undefined ? parseLiangText(f.chenggu.totalText) : base.chenggu?.totalLiang ?? 0;
    next.chenggu = {
      ...(base.chenggu ?? { totalLiang: 0, totalText: '', ruleVersion: '', parts: { year: '', month: '', day: '', hour: '' } }),
      ...f.chenggu,
      totalLiang: totalLiang ?? 0,
      totalText: totalLiang === undefined ? (f.chenggu.totalText ?? base.chenggu?.totalText ?? '') : liangText(totalLiang),
      parts: { year: '', month: '', day: '', hour: '', ...base.chenggu?.parts, ...f.chenggu.parts },
    };
  }
  if (f.greatFortunes) {
    next.greatFortunes = (base.greatFortunes ?? []).map((fortune, index) => {
      const changes = f.greatFortunes?.[index as FortuneIndex];
      return changes ? { ...fortune, ...changes } : fortune;
    });
  }
  if (Object.prototype.hasOwnProperty.call(f, 'zodiac')) next.zodiac = f.zodiac as string;
  if (f.zodiacCompatibility) next.zodiacCompatibility = {
    ...interpersonalZodiac(base.pillars?.year?.[1] ?? ''), ...f.zodiacCompatibility,
  };
  if (f.relationships) next.relationships = { ...base.relationships, ...f.relationships } as RelationshipFacts;
  if (Object.prototype.hasOwnProperty.call(f, 'fortuneDirection')) next.fortuneDirection = f.fortuneDirection;
  return next;
}

export function effectiveNonAiFacts(chart: NonAiChart): NonAiChart {
  return applyManualNonAi(chart, chart.manualEdits);
}

/** The same effective, bounded additions are appended to all natal payloads. */
export function manualNatalFacts(chart: NonAiChart | undefined) {
  return { tenGodDetails: chart?.tenGodDetails, chenggu: chart?.chenggu,
    fortuneDirection: chart?.fortuneDirection, zodiacCompatibility: chart?.zodiacCompatibility };
}

export function effectiveElementFacts(chart: NonAiChart | undefined, counted: { elements: Record<string, number>; elementRatio: Record<string, number> } | null) {
  return { elements: { ...(counted?.elements ?? chart?.elements), ...chart?.manualEdits?.fields.elements },
    elementRatio: { ...(counted?.elementRatio ?? chart?.elementRatio), ...chart?.manualEdits?.fields.elementRatio } };
}

export function effectiveTaskDecade(chart: NonAiChart | undefined, year: number, inline: NonAiChart['greatFortunes'][number] | undefined) {
  const selected = chart?.greatFortunes?.find((row) => year >= row.startYear && year <= row.endYear);
  return chart?.manualEdits?.fields.greatFortunes && chart.greatFortunes?.length ? selected : inline?.ganZhi ? inline : selected;
}

export interface ManualNonAiValidation { valid: boolean; errors: string[] }

export function validNonAiDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(0); date.setUTCFullYear(y, m - 1, d);
  return y >= 1 && y <= 9999 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
const validGanZhi = (value: unknown): boolean => typeof value === 'string' && value.length === 2 && '甲乙丙丁戊己庚辛壬癸'.includes(value[0]) && '子丑寅卯辰巳午未申酉戌亥'.includes(value[1]) && '甲乙丙丁戊己庚辛壬癸'.indexOf(value[0]) % 2 === '子丑寅卯辰巳午未申酉戌亥'.indexOf(value[1]) % 2;
const chineseValue = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && /^[\u3400-\u9fff、，。；（）\s]+$/.test(value);

export function validateManualNonAiFields(input: unknown): ManualNonAiValidation {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['修改内容格式无效'] };
  const fields = input as Record<string, unknown>;
  const names: Record<string, string> = { elements: '五行计数', elementRatio: '五行比例', hiddenStems: '藏干', tenGods: '十神', naYin: '纳音', twelveLongevity: '十二长生', tenGodDetails: '藏干十神', luckStart: '起运跨度', luckOnset: '交运日期', chenggu: '称骨', greatFortunes: '大运', zodiac: '生肖', zodiacCompatibility: '生肖关系', relationships: '命局关系', fortuneDirection: '大运方向' };
  const allowed = new Set(Object.keys(names));
  for (const key of Object.keys(fields)) if (!allowed.has(key)) errors.push('包含不支持修改的字段');
  for (const key of ['elements', 'elementRatio'] as const) {
    const values = fields[key];
    if (values === undefined) continue;
    if (!values || typeof values !== 'object' || Array.isArray(values)) { errors.push(`${names[key]}格式无效`); continue; }
    for (const [element, value] of Object.entries(values)) {
      if (!elements.includes(element as FiveElement) || typeof value !== 'number' || !Number.isFinite(value)
        || (key === 'elements' && (!Number.isInteger(value) || value < 0))
        || (key === 'elementRatio' && (value < 0 || value > 1))) errors.push(`${names[key]}数值无效`);
    }
  }
  for (const key of ['hiddenStems', 'tenGods', 'naYin', 'twelveLongevity'] as const) {
    const values = fields[key];
    if (values === undefined) continue;
    if (!values || typeof values !== 'object' || Array.isArray(values)) { errors.push(`${names[key]}格式无效`); continue; }
    for (const [pillar, value] of Object.entries(values)) {
      if (!pillarKeys.includes(pillar as PillarKey) || (key === 'hiddenStems' ? !Array.isArray(value) || value.length > 3 || !value.every((item) => typeof item === 'string' && item.length === 1 && '甲乙丙丁戊己庚辛壬癸'.includes(item)) : !chineseValue(value))) errors.push(`${names[key]}格式无效`);
    }
  }
  if (fields.fortuneDirection !== undefined && fields.fortuneDirection !== 'forward' && fields.fortuneDirection !== 'backward') errors.push('大运方向无效');
  if (fields.zodiac !== undefined && (typeof fields.zodiac !== 'string' || !['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'].includes(fields.zodiac))) errors.push('生肖格式无效');
  if (fields.luckOnset !== undefined && !validNonAiDate(fields.luckOnset)) errors.push('交运日期格式无效');
  for (const key of ['relationships', 'zodiacCompatibility'] as const) {
    const group = fields[key];
    if (group === undefined) continue;
    if (!group || typeof group !== 'object' || Array.isArray(group)) { errors.push(`${names[key]}格式无效`); continue; }
    const allowedGroups = key === 'relationships' ? ['sanHe', 'liuHe', 'chong', 'xing', 'po', 'hai', 'ke'] : ['sanHe', 'liuHe', 'chong', 'hai'];
    for (const [groupName, value] of Object.entries(group)) {
      if (!allowedGroups.includes(groupName) || !Array.isArray(value) || !value.every((item) => key === 'zodiacCompatibility' ? typeof item === 'string' && ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'].includes(item) : chineseValue(item))) errors.push(`${names[key]}格式无效`);
    }
  }
  if (fields.luckStart !== undefined) {
    const span = fields.luckStart;
    if (!span || typeof span !== 'object' || Array.isArray(span)) errors.push('起运跨度格式无效');
    else {
      const value = span as Record<string, unknown>;
      if (Object.keys(value).some((key) => !['years', 'months', 'days', 'date'].includes(key))
        || (value.years !== undefined && (typeof value.years !== 'number' || !Number.isInteger(value.years) || value.years < 0))
        || (value.months !== undefined && (typeof value.months !== 'number' || !Number.isInteger(value.months) || value.months < 0 || value.months > 11))
        || (value.days !== undefined && (typeof value.days !== 'number' || !Number.isInteger(value.days) || value.days < 0 || value.days > 30))
        || (value.date !== undefined && !validNonAiDate(value.date))) errors.push('起运跨度数值无效');
    }
  }
  if (fields.chenggu !== undefined) {
    const value = fields.chenggu;
    if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('称骨格式无效');
    else {
      const chenggu = value as Record<string, unknown>;
      if (chenggu.totalLiang !== undefined && (typeof chenggu.totalLiang !== 'number' || !Number.isFinite(chenggu.totalLiang) || chenggu.totalLiang < 0 || chenggu.totalLiang > 99.9 || Math.abs(chenggu.totalLiang * 10 - Math.round(chenggu.totalLiang * 10)) > 1e-8)) errors.push('称骨总重须为零至九十九两九钱，精确到钱');
      if (chenggu.totalText !== undefined && (typeof chenggu.totalText !== 'string' || parseLiangText(chenggu.totalText) === undefined)) errors.push('称骨总重格式无效');
      if (chenggu.parts !== undefined && (!chenggu.parts || typeof chenggu.parts !== 'object' || Array.isArray(chenggu.parts)
        || Object.entries(chenggu.parts).some(([key, part]) => !['year', 'month', 'day', 'hour'].includes(key) || typeof part !== 'string' || parseLiangText(part) === undefined))) errors.push('称骨分重格式无效');
      if (Object.keys(chenggu).some((key) => !['totalLiang', 'totalText', 'parts'].includes(key))) errors.push('称骨字段无效');
    }
  }
  if (fields.greatFortunes !== undefined) {
    if (!fields.greatFortunes || typeof fields.greatFortunes !== 'object' || Array.isArray(fields.greatFortunes)) errors.push('大运修改格式无效');
    else for (const [index, value] of Object.entries(fields.greatFortunes)) {
      if (String(Number(index)) !== index || !fortuneIndexes.includes(Number(index) as FortuneIndex) || !value || typeof value !== 'object' || Array.isArray(value)) errors.push('大运步序或字段格式无效');
      else if (Object.entries(value).some(([key, item]) => !['ganZhi', 'startYear', 'endYear', 'onsetDate', 'endDate'].includes(key)
        || (['startYear', 'endYear'].includes(key) ? typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 9999 : key === 'ganZhi' ? !validGanZhi(item) : !validNonAiDate(item)))) errors.push('大运字段格式无效');
    }
  }
  if (fields.tenGodDetails !== undefined) {
    const details = fields.tenGodDetails as { hidden?: Record<string, unknown> };
    if (!details || typeof details !== 'object' || Array.isArray(details) || Object.keys(details).some((key) => key !== 'hidden') || !details.hidden || typeof details.hidden !== 'object' || Array.isArray(details.hidden)
      || Object.entries(details.hidden).some(([key, rows]) => !pillarKeys.includes(key as PillarKey) || !Array.isArray(rows) || rows.length > 3 || rows.some((row, index) => !row || typeof row !== 'object' || Object.keys(row).some((key) => !['stem', 'tenGod', 'position'].includes(key)) || typeof row.stem !== 'string' || row.stem.length !== 1 || !'甲乙丙丁戊己庚辛壬癸'.includes(row.stem) || !chineseValue(row.tenGod) || row.position !== ['root', 'middle', 'residual'][index]))) errors.push('藏干十神格式无效');
  }
  return { valid: errors.length === 0, errors };
}
