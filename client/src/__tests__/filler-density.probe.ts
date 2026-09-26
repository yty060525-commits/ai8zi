import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord, BaziAnalysisTask } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';

const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');

/** 把一句正文里所有「引擎算出来的事实」涂白：干支字、五行、十神、宫位脏腑、年份、岁数、
 *  方位颜色。剩下的就是纯粹靠模板撑着的字。剩得越多，这句话越像套话。 */
const FACT = /(甲|乙|丙|丁|戊|己|庚|辛|壬|癸|子|丑|寅|卯|辰|巳|午|未|申|酉|戌|亥|木|火|土|金|水|比肩|劫财|食神|伤官|偏财|正财|七杀|正官|偏印|正印|比劫|食伤|财|官杀|印|禄|刃|肝胆|筋骨|情志|血脉|眼目|脾胃|消化|肺|呼吸|皮肤|大肠|肾|泌尿|内分泌|耳|骨|身强|身弱|中和偏旺|中和偏弱|喜用|忌神|配偶宫|夫妻宫|妻星|夫星|\d{4}|[一二三四五六七八九十两]+\s*载|[一二三四五六七八九十两]+(?:岁|成|年|月|个月))/g;
const fillerChars = (line: string) => line.replace(FACT, '').replace(/[（）()、，。：；「」·\-—\s]/g, '').length;

describe('时段批断的套话负载（取证）', () => {
  it('本命 + 流年/流月/大运：平均填充字数、整句复用率、同盘之间雷同率', async () => {
    const { buildLocalAnalysis, buildLocalTaskAnalysis } = await import('../data/localAnalysis');
    const out: string[] = [];
    const recs: BaziRecord[] = [];
    for (let year = 1962; year <= 2002; year += 5) {
      for (const month of [3, 8]) {
        for (const day of [7, 21]) {
          for (const hour of [6, 14, 21]) {
            const p = computePillarsFromDate({ year, month, day, hour });
            let n; try { n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, 'male', NOW.toISOString()); } catch { continue; }
            recs.push({ id: `f-${year}${month}${day}${hour}`, name: 'f', gender: 'male', createdAt: NOW.toISOString(),
              birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord);
          }
        }
      }
    }
    out.push(`CHARTS=${recs.length}`);
    /** 同一盘内取多个不同时段：跨期复用才是真套话，只取一个时点会把「本期固定那句」低估。 */
    const tasksOf = (r: BaziRecord, scope: 'annual' | 'monthly' | 'decade'): BaziAnalysisTask[] => {
      const n = r.nonAiResult!;
      if (scope === 'annual') return (n.annualFortunes ?? []).slice(0, 10).map((a) => ({ taskId: 't', type: 'annual', year: a.year, annual: a }));
      if (scope === 'monthly') return (n.monthlyFortunes ?? []).filter((_, i) => i % 11 === 0).slice(0, 10).map((m) => ({ taskId: 't', type: 'monthly', year: m.year, month: m.month, monthly: m }));
      return (n.greatFortunes ?? []).slice(0, 9).map((g) => ({ taskId: 't', type: 'decade', year: g.startYear, decade: g }));
    };
    const linesOf = (text: string) => text.split('\n').map((l) => l.replace(/^\d+\.\s*/, '').trim()).filter((l) => l.length > 4 && !l.startsWith('【'));

    stat('natal', recs.map((r) => linesOf(buildLocalAnalysis(r, NOW)?.explanation ?? '')));
    for (const scope of ['annual', 'monthly', 'decade'] as const) {
      stat(scope, recs.map((r) => tasksOf(r, scope).flatMap((t) => linesOf(buildLocalTaskAnalysis(r, t, NOW)?.explanation ?? ''))));
    }
    writeFileSync(DIR + 'filler-density.txt', out.join('\n') + '\n');

    function stat(label: string, perChart: string[][]) {
      const flat = perChart.flat();
      if (!flat.length) return;
      const avg = flat.reduce((s, l) => s + fillerChars(l), 0) / flat.length;
      const seen = new Map<string, number>();
      for (const l of flat) seen.set(l, (seen.get(l) ?? 0) + 1);
      const dup = [...seen.entries()].sort((a, b) => b[1] - a[1]);
      const reusedLines = dup.filter(([, c]) => c > 1).reduce((s, [, c]) => s + c, 0);
      let samePair = 0, pairs = 0;
      for (let i = 0; i < perChart.length; i++) {
        for (let j = i + 1; j < perChart.length && j < i + 6; j++) {
          pairs++;
          const a = perChart[i], b = perChart[j];
          let same = 0;
          for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] === b[k]) same++;
          samePair += same / Math.max(1, Math.min(a.length, b.length));
        }
      }
      out.push(`\n[${label}] 行数=${flat.length} 平均填充=${avg.toFixed(1)}字 整句复用占行=${((reusedLines / flat.length) * 100).toFixed(1)}% 邻盘逐行雷同率=${((samePair / Math.max(1, pairs)) * 100).toFixed(1)}%`);
      out.push(dup.slice(0, 12).map(([l, c]) => `  ×${c} ${l.slice(0, 60)}`).join('\n'));
    }
  });
});
