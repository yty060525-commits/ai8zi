import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord, BaziAnalysisTask } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';

const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');

describe('时段正文抽样：看真实句子长什么样', () => {
  it('打印两盘的同一年流年与一步大运全文', async () => {
    const { buildLocalTaskAnalysis } = await import('../data/localAnalysis');
    const out: string[] = [];
    const make = (year: number, month: number, day: number, hour: number): BaziRecord => {
      const p = computePillarsFromDate({ year, month, day, hour });
      const n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, 'male', NOW.toISOString());
      return { id: `${year}${month}${day}`, name: 'x', gender: 'male', createdAt: NOW.toISOString(), birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord;
    };
    for (const r of [make(1972, 4, 19, 6), make(1988, 11, 3, 14)]) {
      const n = r.nonAiResult!;
      out.push(`\n======== ${r.id} 四柱 ${n.pillars.year} ${n.pillars.month} ${n.pillars.day} ${n.pillars.hour} 日主${n.dayMaster} ${n.strengthScore?.label}`);
      const a = n.annualFortunes.find((x) => x.year === 2029)!;
      const g = (n.greatFortunes ?? []).find((x) => x.startYear > 2026)!;
      const m = n.monthlyFortunes.find((x) => x.year === 2029 && x.month === 5)!;
      for (const t of [{ taskId: 'a', type: 'annual', year: a.year, annual: a }, { taskId: 'd', type: 'decade', year: g.startYear, decade: g }, { taskId: 'm', type: 'monthly', year: m.year, month: m.month, monthly: m }] as BaziAnalysisTask[]) {
        out.push(`\n---- ${t.type} ----\n${buildLocalTaskAnalysis(r, t, NOW)?.explanation ?? '(null)'}`);
      }
    }
    writeFileSync(DIR + 'sample-prose.txt', out.join('\n') + '\n');
  });
});
