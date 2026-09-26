/* 探针：同一张盘里相邻两个时段的正文有多少行逐字相同（同盘雷同），以及两句「看起来一样」的行
   实际差多少字。用户提的是「相同的时候输出的话也一样」—— 跨盘雷同类探针测不到这一维：
   同一人连看十年流年，若每年健康/财运那两行一字不改，体验上就是「没批」。 */
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis, buildLocalTaskAnalysis } from '../data/localAnalysis';
import { buildBaziTasks } from '../data/baziOrchestrator';
import type { BaziRecord } from '../types/domain';

const NOW = new Date('2026-09-26T08:00:00Z');

function make(y: number, m: number, d: number, h: number, gender: 'male' | 'female'): BaziRecord {
  // calculateNonAi 要求四柱是真实干支（空串会抛「四柱必须填写有效的天干地支」），先按生日排出来。
  const pillars = computePillarsFromDate({ year: y, month: m, day: d, hour: h });
  const nonAiResult = calculateNonAi({ birthYear: y, birthMonth: m, ...pillars }, gender, NOW.toISOString());
  return {
    id: `${y}${m}${d}${h}`, name: 'p', gender, birthYear: String(y), birthMonth: String(m), birthDay: d, birthHour: h,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...pillars,
    nonAiResult, aiTasks: {},
  } as unknown as BaziRecord;
}

/** 把两行剥成「只留骨架」再比：先算逐字相同的行数，再对最像的一对报出差异字数。 */
function diffChars(a: string, b: string): number {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return Math.max(0, Math.max(a.length, b.length) - i - j);
}

describe('同盘相邻时段的雷同度', () => {
  it('流年逐年、流月逐月的正文不许整行照抄', () => {
    const out: string[] = [];
    for (const rec of [make(1972, 4, 19, 6, 'male'), make(1988, 11, 3, 14, 'male'), make(1990, 6, 15, 10, 'female')]) {
      buildLocalAnalysis(rec, NOW);
      const byScope: Record<string, Array<{ tag: string; lines: string[] }>> = { annual: [], monthly: [], decade: [] };
      for (const t of buildBaziTasks(rec, NOW)) {
        const a = buildLocalTaskAnalysis(rec, t, NOW);
        if (!a) continue;
        const scope = t.type === 'annual' ? 'annual' : t.type === 'monthly' ? 'monthly' : t.type === 'decade' ? 'decade' : '';
        if (!scope) continue;
        byScope[scope].push({ tag: `${t.year ?? ''}${(t as { month?: number }).month ? (t as { month: number }).month + '月' : ''}${rec.nonAiResult!.annualFortunes?.find((r) => r.year === t.year)?.ganZhi ?? ''}`, lines: a.explanation.split('\n').filter((l) => /^\d+\. /.test(l)) });
      }
      for (const scope of ['annual', 'monthly', 'decade']) {
        const rows = byScope[scope];
        // 按行号对齐比较相邻两年的第 k 行：这是读者真正会并排看到的两行
        let same = 0, total = 0, minDiff = Infinity, worstPair = ''; const dups: string[] = [];
        for (let i = 1; i < rows.length; i++) {
          const A = rows[i - 1], B = rows[i];
          for (let k = 0; k < Math.min(A.lines.length, B.lines.length); k++) {
            total++;
            if (A.lines[k] === B.lines[k]) { same++; if (0 < minDiff) { minDiff = 0; worstPair = `${A.tag}/${B.tag} 第${k + 1}行`; } dups.push(`${A.tag}/${B.tag} 第${k + 1}行：${A.lines[k]}`); }
            else { const d = diffChars(A.lines[k], B.lines[k]); if (d < minDiff) { minDiff = d; worstPair = `${A.tag}/${B.tag} 第${k + 1}行 差${d}字\n    A: ${A.lines[k]}\n    B: ${B.lines[k]}`; } }
          }
        }
        out.push(`${rec.id} ${scope}: 相邻对比 ${total} 对，逐字相同 ${same} 对(${total ? (same * 100 / total).toFixed(1) : '-'}%)，最接近的一对=${worstPair}`);
        for (const l of dups) out.push(`   [同] ${l}`);
      }
    }
    writeFileSync(resolve(__dirname, '../../.scratch/same-chart-similarity.txt'), out.join('\n') + '\n');
    console.log(out.join('\n'));
  });
});
