import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../../src/types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalTaskAnalysis } from '../data/localAnalysis';
import { buildBaziTasks } from '../data/baziOrchestrator';

const NOW = new Date('2026-09-26T06:00:00Z');
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const make = (gender: 'male' | 'female'): BaziRecord => {
  const args = gender === 'male' ? [1986, 3, 12, 8] : [1990, 6, 15, 10];
  const p = computePillarsFromDate({ year: args[0], month: args[1], day: args[2], hour: args[3] });
  const nonAiResult = calculateNonAi({ birthYear: args[0], birthMonth: args[1], birthDay: args[2], ...p }, gender, NOW.toISOString());
  return { id: 'probe-' + gender, name: 'p', gender, createdAt: NOW.toISOString(),
    birthYear: args[0], birthMonth: args[1], birthDay: args[2], ...p, nonAiResult, aiStatus: 'completed' } as unknown as BaziRecord;
};
describe('取向探针', () => {
  it('印出男女两盘逐年爱情句与档位', () => {
    const out: string[] = [];
    for (const g of ['male', 'female'] as const) {
      const rec = make(g);
      out.push(`=== ${g} day=${rec.nonAiResult!.pillars.day} useful=${JSON.stringify(rec.nonAiResult!.strengthScore)}`);
      for (const t of buildBaziTasks(rec, NOW)) {
        if (t.type !== 'annual') continue;
        const a = buildLocalTaskAnalysis(rec, t, NOW); if (!a) continue;
        const love = /【爱情】\n([\s\S]*?)(?:\n【|$)/.exec(a.explanation)?.[1]?.trim() ?? '(none)';
        out.push(`${t.year} ${(t.annual?.ganZhi) ?? '?'} | ${a.strength} | ${love}`);
      }
    }
    writeFileSync(DIR + 'love-orient.txt', out.join('\n') + '\n', 'utf8');
  });
});
