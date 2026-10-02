import { describe, expect, it } from 'vitest';
import { analysisHorizon, collectFindings } from '../data/baziOrchestrator';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

/** 汇总标题的大运区间必须与详情页④栏同口径：只显「未来十年」窗口的交集。 */
const record = (createdAt: string, greatFortunes: unknown[]): BaziRecord =>
  ({ createdAt, nonAiResult: { greatFortunes } } as unknown as BaziRecord);

const done = (task: BaziTaskResult['task']): BaziTaskResult =>
  ({ task, status: 'completed', analysis: { explanation: '【事业】顺遂。' } } as unknown as BaziTaskResult);

describe('collectFindings 大运标题区间(裁到未来十年窗口)', () => {
  // analysisHorizon 有意只在「未来建的盘」上跟随 createdAt，过去的 createdAt 会回落成今天。
  // 所以钉死窗口用一年后的建盘时间：2027-06 → 窗口 [2027, 2036]。
  const r = record(new Date(Date.UTC(2027, 5, 1)).toISOString(), []);
  it('夹具钉子：窗口确实是 2027-2036', () => {
    expect(analysisHorizon(r).year).toBe(2027);
  });

  it('戊申本运 2033-2042，窗口 2027-2036 → 要点标题写二零三三至二零三六', () => {
    const rec = { ...r, nonAiResult: { greatFortunes: [{ ganZhi: '戊申', startYear: 2033, endYear: 2042 }] } } as BaziRecord;
    const task = { taskId: 'task-24', type: 'decade' as const, year: 2033, decade: { ganZhi: '戊申', startYear: 2033, endYear: 2042, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } } };
    expect(collectFindings(rec, { 'task-24': done(task) }, [task]).decades[0].heading).toBe('戊申、大运段、二零三三至二零三六');
  });

  it('整段在窗口之前、但与窗口有几年重叠的旧运：起点抬到窗口，只显相交的那一截', () => {
    const rec = { ...r, nonAiResult: { greatFortunes: [{ ganZhi: '庚子', startYear: 2020, endYear: 2029 }] } } as BaziRecord;
    const task = { taskId: 'task-24', type: 'decade' as const, year: 2020, decade: { ganZhi: '庚子', startYear: 2020, endYear: 2029, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } } };
    expect(collectFindings(rec, { 'task-24': done(task) }, [task]).decades[0].heading).toBe('庚子、大运段、二零二七至二零二九');
  });

  it('终点不往「起点+9」抬：当前运走到 2033，窗口 2027-2036 → 标题写二零二七至二零三三，与正文覆盖的年份一致', () => {
    const rec = { ...r, nonAiResult: { greatFortunes: [{ ganZhi: '丁未', startYear: 2017, endYear: 2033 }] } } as BaziRecord;
    const task = { taskId: 'task-24', type: 'decade' as const, year: 2017, decade: { ganZhi: '丁未', startYear: 2017, endYear: 2033, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } } };
    expect(collectFindings(rec, { 'task-24': done(task) }, [task]).decades[0].heading).toBe('丁未、大运段、二零二七至二零三三');
  });

  it('整段都在窗口之前(无重叠)：退回真实整段，不截成假一年', () => {
    const rec = { ...r, nonAiResult: { greatFortunes: [{ ganZhi: '己亥', startYear: 2010, endYear: 2019 }] } } as BaziRecord;
    const task = { taskId: 'task-24', type: 'decade' as const, year: 2010, decade: { ganZhi: '己亥', startYear: 2010, endYear: 2019, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } } };
    expect(collectFindings(rec, { 'task-24': done(task) }, [task]).decades[0].heading).toBe('己亥、大运段、二零一零至二零一九');
  });
});
