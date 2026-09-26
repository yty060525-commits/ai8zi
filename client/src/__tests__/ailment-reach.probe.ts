import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import type { StrengthScore } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis } from '../data/localAnalysis';

/**
 * 可达性穷举：ailment() 只看 strengthScore.detail 的 tenGod/side/weight 与档位标签，
 * 不看干支本身。故把「同侧各组权重」当自变量枚举，即可判定七条尾巴分支里哪些根本
 * 不可能出现 —— 真实命局网格只跑出了 A(独占)/C(全忌+次之) 两支。
 *
 * tenGod 必须用**真十神名**(比肩/劫财/食神/伤官/偏财/正财/七杀/正官/偏印/正印/日主)：
 * 产品按 TEN_GOD_GROUP[tenGod] 归组，写成组名会退回原字符串、既不进病处句也不进余组，
 * 整张探针就只是在测自己造的假数据。
 */
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
const ELEMENTS = ['木', '火', '土', '金', '水'] as const;
const STEM_EL: Record<string, string> = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
const OFF: Record<string, number> = { 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 };
/** 档位 → 病处所取的一侧 + 该侧可用的十神名(比劫/印属助身方，食伤/财/官杀属克泄耗方)。 */
const CASES: Array<{ day: string; label: string; side: string; groups: Record<string, string[]> }> = [
  { day: '庚午', label: '身强', side: 'support', groups: { 比劫: ['比肩', '劫财'], 印: ['偏印', '正印'] } },
  { day: '甲子', label: '身弱', side: 'drain', groups: { 食伤: ['食神', '伤官'], 财: ['偏财', '正财'], 官杀: ['七杀', '正官'] } },
];
// 引擎实际权重取自 STEM_WEIGHT=6 / ROOT_WEIGHT=[10,5,3](月令印比再×2)，故档位取到 20 已够宽。
const WEIGHTS = [0, 1, 3, 6, 10, 20];

describe('病处尾巴分支可达性', () => {
  it('枚举同侧权重组合，标出每条分支能否出现', () => {
    const tally: Record<string, number> = {};
    const examples: Record<string, string> = {};
    let n = 0;
    const dfHits: string[] = [];
    for (const c of CASES) {
      const dayIdx = ELEMENTS.indexOf(STEM_EL[c.day[0]] as (typeof ELEMENTS)[number]);
      // 与 deriveUsefulAvoid 同式：身强/中和偏旺 忌印、比劫；身弱/中和偏弱 忌财、官杀、食伤。
      const avoidGroups = c.side === 'support' ? ['印', '比劫'] : ['财', '官杀', '食伤'];
      const isAvoid = (g: string) => {
        const first = ELEMENTS[(dayIdx + OFF[g]) % 5];
        return avoidGroups.some((x) => ELEMENTS[(dayIdx + OFF[x]) % 5] === first);
      };
      const gnames = Object.keys(c.groups);
      for (const w1 of WEIGHTS) for (const w2 of WEIGHTS) for (const w3 of WEIGHTS) {
        const ws = [w1, w2, w3];
        while (ws.length < gnames.length) ws.push(0);
        // 「日主」只在助身方出现(权重 6)，克泄耗方不会有它。
        const cells = [...gnames.map((g, i) => ({ group: g, weight: ws[i] })),
          // 「日主」不是病处组，但计在助身方且占权重，必须一起进明细。
          ...(c.side === 'support' ? [{ group: '日主', weight: 6 }] : [])];
        const detail = cells.map((x) => ({ pillar: '年', stem: '?', tenGod: x.group === '日主' ? '日主' : c.groups[x.group][0], side: c.side, weight: x.weight }));
        const score = { support: 0, drain: 0, net: 0, index: 0, label: c.label, inSeason: false, monthHasSupport: false, detail } as unknown as StrengthScore;
        const n2 = { pillars: { year: '甲子', month: '丙寅', day: c.day, hour: '壬午' }, strengthScore: score } as unknown as BaziRecord['nonAiResult'];
        const rec = { id: 'x', name: 'x', gender: 'male', createdAt: NOW.toISOString(),
          yearPillar: '甲子', monthPillar: '丙寅', dayPillar: c.day, hourPillar: '壬午', nonAiResult: n2, aiStatus: 'completed' } as unknown as BaziRecord;
        const base = buildLocalAnalysis(rec, NOW)!;
        const fullSent = /净分[^。]*。/.exec(base.explanation)?.[0] ?? '';
        const body = /命局病处在于([^。]*)。$/.exec(fullSent)?.[1] ?? '';
        if (/[A-Za-z]/.test(fullSent)) throw new Error(`正文含拉丁字母: ${fullSent}`);
        const tail = /（(.*)）$/.exec(body)?.[1] ?? '';
        // 复算侧独立分组，用于给分支定性
        const byGroup: Record<string, number> = {};
        for (const x of cells) byGroup[x.group] = (byGroup[x.group] ?? 0) + x.weight;
        const ranked = gnames.filter((g) => byGroup[g] > 0).sort((a, b) => byGroup[b] - byGroup[a]);
        const top = ranked.slice(0, 2), rest = ranked.slice(2);
        const namedSum = top.reduce((a, g) => a + byGroup[g], 0);
        const sideTotal = cells.reduce((a, x) => a + x.weight, 0);
        const cheng = sideTotal > 0 ? Math.round((namedSum / sideTotal) * 10) / 10 : 0;
        /* 判据与产品同式：低于一成的读数中文以「零」起头，此时不报独占。
           复算侧自己另算 cheng(含日主)，若产品的分母漏了日主就会在此劈叉。 */
        const dropsReading = cheng < 0.95;   // 四舍五入到一位小数后为 0.0 ⇔ 读数「零…」
        const key = !rest.length ? (!dropsReading ? 'A独占' : 'G无尾巴') : top.every(isAvoid) ? (rest.some(isAvoid) ? 'C全忌+次之' : 'D全忌无尾')
          : rest.some(isAvoid) ? 'F余组有忌' : 'G无尾巴';
        // 判据：复算归类与实际句子形态必须吻合，否则说明分类或产品错位。
        if (key === 'D全忌无尾' || key === 'F余组有忌') dfHits.push(`${c.label} ${gnames.map((g, i) => `${g}:${ws[i]}`).join(' ')} top=${top.join(',')} rest=${rest.join(',')} tail=${tail || '(无)'}`);
        const actual = !tail ? 'G无尾巴' : tail.includes('独占') ? 'A独占'
          : tail.includes('此即忌神之所在') ? (tail.includes('次之') ? 'C全忌+次之' : 'D全忌无尾')
          : tail.includes('次之') ? 'F余组有忌' : 'G无尾巴';
        // 死码钉子：删掉的措辞不得从任何盘子复活。
        if (tail.includes('两组合计')) throw new Error(`已删措辞复活: ${c.label} 句=${tail}`);
        if (actual !== key) throw new Error(`分支错配 ${key} vs ${actual}: ${c.label} ${JSON.stringify(cells)} 句=${tail}`);
        tally[key] = (tally[key] ?? 0) + 1;
        if (!examples[key]) examples[key] = `${c.label} ${gnames.map((g, i) => `${g}:${ws[i]}`).join(' ')}${c.side === 'support' ? ' 日主:6' : ''} cheng=${cheng} 句=${tail || '(无)'}`;
        n++;
      }
    }
    const head = [`COMBOS=${n}`,
      ...Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v} (${((v / n) * 100).toFixed(1)}%)`),
      ...['A独占', 'C全忌+次之', 'D全忌无尾', 'F余组有忌', 'G无尾巴'].filter((k) => !tally[k]).map((k) => `不可达 ${k}`)];
    const body2 = head.join('\n') + `\nD/F 命中数=${dfHits.length}\n` + dfHits.slice(0, 6).join('\n') + '\n--- 各分支样例 ---\n' + Object.entries(examples).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
    writeFileSync(DIR + 'ailment-reach.txt', body2, 'utf8');
    // 钉住网格规模：3 组×身强(2 命名组) 与 3 组×身弱(3 命名组)，各 6^3 / 6^2。
    expect(n).toBe(432);
  }, 120000);
});
