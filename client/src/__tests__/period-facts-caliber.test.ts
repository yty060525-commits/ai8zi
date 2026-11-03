import { describe, expect, it } from 'vitest';
import { calculateNonAi, singleCalendarMonth } from '../features/chart/nonAiCalculator';
import { buildPeriodFacts } from '../data/chatEngine';
import type { BaziRecord } from '../types/domain';

/** 时段事实是模型「不必自己推算」的前提。两处曾让模型被迫自圆其说：
 *  1) 聊天问「某年某月」时按公历月去查节月序号的 monthlyFortunes，干支整整错一个月，与流月批断互相矛盾；
 *  2) 时段行里混着本命四柱之间的冲刑(如本命子午冲)，模型把它说成「本期新逢六冲」；也没给地支藏干十神。 */
const natal = { birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
const nonAiResult = calculateNonAi(natal, 'male', '2026-11-03T02:00:00.000Z');
const record = { id: 'p', name: '甲', gender: 'male', ...natal, nonAiResult } as unknown as BaziRecord;

describe('时段事实口径', () => {
  it('聊天流月与流月任务同口径：公历十二月取子月而非丑月', () => {
    for (const [y, m] of [[2026, 11], [2026, 12], [2027, 1], [2027, 5]]) {
      const facts = buildPeriodFacts(record, { year: y, month: m } as never) as { monthly?: { ganZhi: string } };
      expect(facts?.monthly?.ganZhi, `${y}-${m}`).toBe(singleCalendarMonth(natal as never, y, m).ganZhi);
    }
    expect((buildPeriodFacts(record, { year: 2026, month: 12 } as never) as { monthly: { ganZhi: string } }).monthly.ganZhi).toBe('庚子');
  });

  it('时段行只含「时段↔本命」的关系，并带地支藏干十神', () => {
    const rows = [...nonAiResult.annualFortunes, ...nonAiResult.monthlyFortunes, ...nonAiResult.greatFortunes, singleCalendarMonth(natal as never, 2027, 5)];
    for (const row of rows) {
      const details = (row as { relationshipDetails?: Array<{ sourceLayer: string; targetLayer: string }> }).relationshipDetails ?? [];
      expect(details.filter((d) => d.sourceLayer === 'natal' && d.targetLayer === 'natal'), row.ganZhi).toEqual([]);
      expect(row.branchTenGods?.length, row.ganZhi).toBeGreaterThan(0);
    }
    const dingWei = nonAiResult.annualFortunes.find((r) => r.ganZhi === '丁未')!;
    // 相克按真实克向：丁火克庚金(时段在前)，壬水克丁火(本命在前)
    const ke = (dingWei.relationshipDetails ?? []).filter((d) => d.type === 'ke').map((d) => d.sourcePillar + '克' + d.targetPillar).sort();
    expect(ke).toEqual([...dingWei.relationships.ke].sort());
    expect(dingWei.branchTenGods).toEqual([{ stem: "己", tenGod: "正印", element: "土" }, { stem: "丁", tenGod: "正官", element: "火" }, { stem: "乙", tenGod: "正财", element: "木" }]);
  });
});
