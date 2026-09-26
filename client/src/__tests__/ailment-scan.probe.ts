import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis } from '../data/localAnalysis';

/* 取证扫描 5：本命「命局病处在于X」这句的**信息量与自洽性**。
 * localAnalysis.ts 的 ailment() 取「克泄耗方（身强档取助身方）权重最大的一组十神」定性，
 * 最多列两组、用「兼有」连接。本探针读的是**引擎自己发射的那句正文**（正则从 explanation
 * 里抠「命局病处在于…。」），不是复算结果 —— 避免把探针的实现当成被测对象。
 * 量三件事：
 *   A 短语分布：是否退化成永远同一句；
 *   B 按档位交叉：某档位内是否几乎恒为同一组（若是则该句≈档位的复述）；
 *   C 自洽对账：句中点名的每一组，其权重必须真是该侧第一（并列取二），
 *      且不得出现「另一侧权重更大却被忽略」。 */
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
const GROUP_OF_TEN_GOD: Record<string, string> = {
  比肩: '比劫', 劫财: '比劫', 食神: '食伤', 伤官: '食伤', 偏财: '财', 正财: '财',
  七杀: '官杀', 正官: '官杀', 偏印: '印', 正印: '印',
};
const PHRASE: Record<string, string> = {
  食伤: '食伤太旺泄身过重', 财: '财星耗身、任财不易', 官杀: '官杀攻身、压力沉重',
  比劫: '比劫结党、分夺财星', 印: '印绶太过、反掩秀气',
};
/** 反向表：短语 → 组。用它解析正文，确保判据来自实际字串。 */
const GROUP_OF_PHRASE: Record<string, string> = Object.fromEntries(
  Object.entries(PHRASE).map(([g, ph]) => [ph, g]),
);

describe('本命「命局病处」的信息量与自洽（取证）', () => {
  it('枚举真实盘，从引擎正文抠句子统计分布并与评分明细对账', () => {
    // 钉子零：反向表必须能覆盖全部五组，否则解析会静默漏项。
    for (const g of Object.keys(PHRASE)) expect(GROUP_OF_PHRASE[PHRASE[g]]).toBe(g);
    const out: string[] = [];
    let charts = 0, noSentence = 0;
    const phraseTally: Record<string, number> = {};
    const byLabel: Record<string, Record<string, number>> = {};
    const problems: string[] = [];
    let twoGroups = 0;
    for (let year = 1963; year <= 2005; year += 2) {
      for (let month = 1; month <= 12; month += 3) {
        for (const day of [3, 14, 26]) {
          for (const hour of [1, 9, 13, 21]) {
            const p = computePillarsFromDate({ year, month, day, hour });
            let n;
            try { n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, 'male', NOW.toISOString()); }
            catch { continue; }
            const rec = { id: `a-${year}${month}${day}${hour}`, name: 'a', gender: 'male', createdAt: NOW.toISOString(),
              birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord;
            const base = buildLocalAnalysis(rec, NOW);
            if (!base || !n.strengthScore) continue;
            charts++;
            const score = n.strengthScore;
            const label = score.label ?? '中和';
            const m = /命局病处在于([^。]+)。/.exec(base.explanation);
            if (!m) { noSentence++; continue; }
            const sentence = m[1];
            const parts = sentence.split('，兼有');
            const named = parts.map((s) => GROUP_OF_PHRASE[s]).filter(Boolean) as string[];
            if (named.length !== parts.length) { problems.push(`无法解析全部短语: ${sentence}`); continue; }
            if (parts.length > 2) problems.push(`句子里出现超过两组: ${sentence}`);
            if (parts.length === 2) twoGroups++;
            phraseTally[named[0]] = (phraseTally[named[0]] ?? 0) + 1;
            byLabel[label] = byLabel[label] ?? {};
            byLabel[label][named[0]] = (byLabel[label][named[0]] ?? 0) + 1;
            /* 对账：按 side 聚合权重，取该侧前两名，必须与句中点名一致；
               并检查被点名的组确实属于该侧（wantSide）。 */
            const wantSide = label === '身强' || label === '中和偏旺' ? 'support' : 'drain';
            const agg: Record<string, number> = {};
            for (const d of score.detail ?? []) {
              if (d.side !== wantSide) continue;
              const grp = GROUP_OF_TEN_GOD[d.tenGod] ?? d.tenGod;
              agg[grp] = (agg[grp] ?? 0) + (d.weight ?? 0);
            }
            const ranked = Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([g]) => g);
            const want = ranked.slice(0, 2).filter((g) => PHRASE[g]);
            if (want.join('|') !== named.join('|')) {
              problems.push(`${p.dayPillar} ${label} 正文=[${named}] 明细=[${want}] 权重=${JSON.stringify(agg)}`);
            }
          }
        }
      }
    }
    out.push(`CHARTS=${charts} 无此句=${noSentence}`);
    out.push('首组分布=' + JSON.stringify(phraseTally));
    out.push(`两组并列=${twoGroups} ${((twoGroups / charts) * 100).toFixed(1)}%`);
    for (const [l, t] of Object.entries(byLabel)) {
      const total = Object.values(t).reduce((a, b) => a + b, 0);
      const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
      out.push(`档位[${l}] n=${total} 单一组占比=${top ? ((top[1] / total) * 100).toFixed(1) : '-'}% ` + JSON.stringify(t));
    }
    out.push(`正文与明细不一致=${problems.length}`);
    for (const s of problems.slice(0, 6)) out.push('  ' + s);
    writeFileSync(DIR + 'ailment-scan.txt', out.join('\n') + '\n', 'utf8');
    expect(charts).toBeGreaterThan(100);
    expect(problems.length, `见 ${DIR}ailment-scan.txt`).toBe(0);
  });
});
