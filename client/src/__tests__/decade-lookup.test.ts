import { describe, expect, it } from 'vitest';
import { decadeSegment, findDecade } from '../features/person/PersonDetail';
import type { BaziRecord } from '../types/domain';

/** 大运段列表(现在引擎产出：按经典起运排定，起点不再是十年整数边界) */
const greatFortunes = [
  { ganZhi: '乙未', startYear: 2023, endYear: 2032, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } },
  { ganZhi: '丙申', startYear: 2033, endYear: 2042, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } },
];
const record = { nonAiResult: { greatFortunes } } as unknown as BaziRecord;

describe('大运段查找(兼容旧记录的起运年龄式 startYear)', () => {
  it('新任务按精确起点命中', () => {
    expect(findDecade(record, { year: 2033 })?.ganZhi).toBe('丙申');
  });

  it('区间内的任意年份都能命中所属大运段', () => {
    expect(findDecade(record, { year: 2032 })?.ganZhi).toBe('乙未');
    expect(findDecade(record, { year: 2025 })?.ganZhi).toBe('乙未');
    expect(findDecade(record, { year: 2035 })?.ganZhi).toBe('丙申');
  });

  it('任务自带内联行时优先使用它(不依赖数组，瘦身后仍可用)', () => {
    const inline = { ganZhi: '丁酉', startYear: 2040, endYear: 2049 };
    expect(findDecade(record, { year: 2019, decade: inline })).toBe(inline);
  });

  it('落在所有段之外时取最近一段兜底；无数据时才返回 undefined', () => {
    // 存量记录的大运任务是旧口径(对齐十年边界)算出的年份，与新排出的区间可能对不上，
    // 兜底保证标题仍有干支 —— 但这是「近似」，不是「正确」，所以重算非 AI 会换新结果。
    expect(findDecade(record, { year: 2019 })?.ganZhi).toBe('乙未');
    expect(findDecade(record, { year: 2044 })?.ganZhi).toBe('丙申');
    // 没有任何大运段数据时不报错
    const empty = { nonAiResult: { greatFortunes: [] } } as unknown as BaziRecord;
    expect(findDecade(empty, { year: 2025 })).toBeUndefined();
    expect(findDecade(record, {})).toBeUndefined();
  });
});

describe('大运标题区间(起止只显未来十年窗口的交集，跨出窗口的年份不显示)', () => {
  const year = new Date().getFullYear();
  const at = (createdAt: string, extra: Partial<BaziRecord> = {}) => ({ createdAt, ...extra } as BaziRecord);
  // 窗口 = [year, year+9]（analysisHorizon 从今天算）。下面每条都同时钉"裁到哪"和"没裁过头"。

  it('本运跨越窗口起点(交运在十年前)：起点裁到窗口，终点整段保留', () => {
    const r = at(new Date(Date.UTC(year - 1, 5, 1)).toISOString());
    expect(decadeSegment({ year, decade: { ganZhi: '乙酉', startYear: year - 3, endYear: year + 6 } }, r)).toEqual({ start: year, end: year + 6 });
  });

  it('旧记录同一运少了两年：先按起点补满十年，再裁窗口 —— 不能裁出短于十年的假段', () => {
    const r = at(new Date(Date.UTC(year - 1, 5, 1)).toISOString());
    // rawStart=year-8 → 补满十年到 year+1；与窗口 [year, year+9] 的交集是 year..year+1。
    expect(decadeSegment({ year, decade: { ganZhi: '甲申', startYear: year - 8, endYear: year - 1 } }, r)).toEqual({ start: year, end: year + 1 });
  });

  it('下一运多年后才起、又越过窗口末尾：裁成窗口内的真实交集(如 2033-2042 显 2033-2035)', () => {
    const r = at(new Date(Date.UTC(year - 1, 5, 1)).toISOString(), { nonAiResult: { greatFortunes: [{ ganZhi: '乙酉', startYear: year - 10, endYear: year - 1 }, { ganZhi: '丙戌', startYear: year + 9, endYear: year + 18 }] } } as never);
    // 上一运整段都在窗口之前：交集为空 → 退回整段，不渲染出「(year-year)」这种假一年。
    expect(decadeSegment({ year: year - 10 }, r)).toEqual({ start: year - 10, end: year - 1 });
    // 下一运起点正好压在窗口末尾 year+9：交集只剩那一年，这就是「未来十年所包含」的真实范围。
    expect(decadeSegment({ year: year + 9, decade: { ganZhi: '丙戌', startYear: year + 9, endYear: year + 9 } }, r)).toEqual({ start: year + 9, end: year + 9 });
  });

  it('正例钉子：戊申本运 2033-2042，窗口 2026-2035 → 只显示 2033-2035', () => {
    // 建盘时间设在 2026 年内，analysisHorizon 才会落在 2026(否则跟随今天)。
    const r = at(new Date(Date.UTC(2026, 5, 1)).toISOString(), { nonAiResult: { greatFortunes: [{ ganZhi: '戊申', startYear: 2033, endYear: 2042 }] } } as never);
    expect(decadeSegment({ year: 2033, decade: { ganZhi: '戊申', startYear: 2033, endYear: 2042 } }, r)).toEqual({ start: 2033, end: 2035 });
  });
});
