import { describe, expect, it } from 'vitest';
import { findDecade } from '../features/person/PersonDetail';
import type { BaziRecord } from '../types/domain';

/** 大运段列表(现在引擎产出：对齐十年边界) */
const greatFortunes = [
  { ganZhi: '乙未', startYear: 2020, endYear: 2029, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } },
  { ganZhi: '丙申', startYear: 2030, endYear: 2039, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } },
];
const record = { nonAiResult: { greatFortunes } } as unknown as BaziRecord;

describe('大运段查找(兼容旧记录的起运年龄式 startYear)', () => {
  it('新任务按精确起点命中', () => {
    expect(findDecade(record, { year: 2030 })?.ganZhi).toBe('丙申');
  });

  it('旧记录里非十年边界的年份(如 2019/2029)按区间兜底命中', () => {
    // 2019 落在 2020-2029 之前 → 无匹配；2029 落在第一段内 → 命中乙未
    expect(findDecade(record, { year: 2029 })?.ganZhi).toBe('乙未');
    expect(findDecade(record, { year: 2025 })?.ganZhi).toBe('乙未');
    expect(findDecade(record, { year: 2035 })?.ganZhi).toBe('丙申');
  });

  it('任务自带内联行时优先使用它(不依赖数组，瘦身后仍可用)', () => {
    const inline = { ganZhi: '丁酉', startYear: 2040, endYear: 2049 };
    expect(findDecade(record, { year: 2019, decade: inline })).toBe(inline);
  });

  it('旧记录偏移年份也能拿到干支；无数据时才返回 undefined', () => {
    // 原「起运年龄推算」会让年份偏离十年边界一两年，取最近一段保证标题仍有干支
    expect(findDecade(record, { year: 2019 })?.ganZhi).toBe('乙未');
    expect(findDecade(record, { year: 2044 })?.ganZhi).toBe('丙申');
    // 没有任何大运段数据时不报错
    const empty = { nonAiResult: { greatFortunes: [] } } as unknown as BaziRecord;
    expect(findDecade(empty, { year: 2025 })).toBeUndefined();
    expect(findDecade(record, {})).toBeUndefined();
  });
});
