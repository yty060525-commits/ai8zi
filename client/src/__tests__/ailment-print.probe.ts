import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis } from '../data/localAnalysis';
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
describe('打印病处句原文', () => {
  it('抽若干盘，把含「命局病处」与「故喜用定为」的两句原样写盘', () => {
    const lines: string[] = [];
    let tailCount = 0, total = 0;
    for (let year = 1961; year <= 2005; year += 4) {
      for (let month = 2; month <= 11; month += 3) {
        for (const day of [6, 19]) {
          for (const hour of [5, 12, 22]) {
            const p = computePillarsFromDate({ year, month, day, hour });
            let n;
            try { n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, 'male', NOW.toISOString()); }
            catch { continue; }
            const rec = { id: `p-${year}${month}${day}${hour}`, name: 'p', gender: 'male', createdAt: NOW.toISOString(),
              birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord;
            const base = buildLocalAnalysis(rec, NOW);
            if (!base) continue;
            total++;
            const a = /净分[^。]*。/.exec(base.explanation)?.[0] ?? '(无)';
            const b = /依扶抑通则[^。]*。/.exec(base.explanation)?.[0] ?? '(无)';
            if (a.includes('忌神') || a.includes('非忌')) tailCount++;
            if (lines.length < 14) lines.push(`${p.dayPillar} ${n.strengthScore?.label}\n  病处句: ${a}\n  喜忌句: ${b}`);
          }
        }
      }
    }
    lines.unshift(`TOTAL=${total} 带括号尾巴的病处句=${tailCount} ${((tailCount / total) * 100).toFixed(1)}%`);
    writeFileSync(DIR + 'ailment-print.txt', lines.join('\n') + '\n', 'utf8');
    expect(total).toBeGreaterThan(20);
  });
});
