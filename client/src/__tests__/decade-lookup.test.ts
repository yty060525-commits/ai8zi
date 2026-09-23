import { describe, expect, it } from 'vitest';
import { findDecade } from '../features/person/PersonDetail';
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
