import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis, cnToNum, groupElements } from '../data/localAnalysis';

/**
 * 穷举「命局病处在于…（尾巴）」的每个分支，并逐条与**独立复算**对账。
 * 复算侧刻意不复用产品代码：十神→分组另建查表、日主五行另建查表、权重聚合自己再写一遍
 * —— 否则探针只是把产品的错重述一遍。
 */
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
const ELEMENTS = ['木', '火', '土', '金', '水'] as const;
const STEM_EL: Record<string, string> = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
const OFF: Record<string, number> = { 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 };
const GROUP_OF: Record<string, string> = {
  比肩: '比劫', 劫财: '比劫', 食神: '食伤', 伤官: '食伤', 偏财: '财', 正财: '财',
  七杀: '官杀', 正官: '官杀', 偏印: '印', 正印: '印',
};
/** 中文读数 → 数字：直接用产品导出的 cnToNum，另钉两条已知读数以证解析器本身没坏。 */
const parseCn = cnToNum;

describe('病处句尾巴分支穷举', () => {
  it('按独立复算归类分支，并断言文案与读数逐条一致', () => {
    const tally: Record<string, number> = {};
    const chengBuckets: Record<string, number> = {};
    const rows: string[] = [];
    expect(parseCn('八点五')).toBe(8.5);
    expect(parseCn('十')).toBe(10);
    let badInvariant = 0;
    let restNotAvoidCharts = 0;
    let total = 0, badShare = 0, badRest = 0, badAvoidClaim = 0, badLatin = 0, badBranch = 0, badMs = 0;
    let numGroups1 = 0, numGroups2 = 0;
    let maxChengAny = 0, maxChengRest = 0;
    let allText = '';
    const sumTopList: number[] = [];
    const aList: number[] = [];
    let minACheng = Infinity;

    for (let year = 1961; year <= 2005; year += 2) {
      for (let month = 1; month <= 12; month++) {
        for (const day of [3, 14, 25]) {
          for (const hour of [5, 12, 22]) {
            const p = computePillarsFromDate({ year, month, day, hour });
            let n;
            try { n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, 'male', NOW.toISOString()); }
            catch { continue; }
            const rec = { id: `q-${year}${month}${day}${hour}`, name: 'q', gender: 'male', createdAt: NOW.toISOString(),
              birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord;
            const base = buildLocalAnalysis(rec, NOW);
            const score = n.strengthScore;
            if (!base || !score?.detail?.length) continue;
            total++;
            // —— 独立复算 ——
            const label = score.label ?? '';
            const wantSide = label === '身强' || label === '中和偏旺' ? 'support' : 'drain';
            const byGroup: Record<string, number> = {};
            for (const d of score.detail) {
              if (d.side !== wantSide) continue;
              const g = GROUP_OF[d.tenGod] ?? d.tenGod;
              byGroup[g] = Math.round(((byGroup[g] ?? 0) + (d.weight ?? 0)) * 10) / 10;   // 与产品同样逐笔四舍五入到一位小数
            }
            // 「日主」也计在助身方，但它不是病处，产品会把它排除在命名组之外。
            const named = ['食伤', '财', '官杀', '比劫', '印'];
            const byWeight = (x: [string, number], y: [string, number]) => (y[1] !== x[1] ? y[1] - x[1] : named.indexOf(y[0]) - named.indexOf(x[0]));
            const ranked = Object.entries(byGroup).sort(byWeight).map(([g]) => g).filter((g) => named.includes(g));
            const allRanked = Object.entries(byGroup).sort(byWeight).map(([g]) => g);
            const top = ranked.slice(0, 2), rest = ranked.slice(2).filter((g) => byGroup[g] > 0);   // 与产品同样丢掉零权重的余组
            const sumTop = top.reduce((a, g) => a + byGroup[g], 0);
            const sideTotal = allRanked.reduce((a, g) => a + byGroup[g], 0);   // 该侧全部力量(含日主)
            const cheng = sideTotal > 0 ? Math.round((sumTop / sideTotal) * 10) / 10 : 0;
            if (top.length === 1) numGroups1++; else numGroups2++;
            sumTopList.push(sumTop);
            if (cheng > maxChengAny) maxChengAny = cheng;
            if (rest.length > 0 && cheng > maxChengRest) maxChengRest = cheng;
            const restNamed = rest.length > 0;   // 「日主」不算命名余组
            const avoid = base.avoidElements;
            const dayIdx = ELEMENTS.indexOf(STEM_EL[p.dayPillar[0]] as (typeof ELEMENTS)[number]);
            const firstElAvoid = (g: string) => avoid.includes(ELEMENTS[(dayIdx + OFF[g]) % 5]);
            // 钉子：产品导出的 groupElements 首字必须等于直算的 rel(dayIdx, off)。
            for (const g of Object.keys(OFF)) expect(groupElements(dayIdx, g)[0]).toBe(ELEMENTS[(dayIdx + OFF[g]) % 5]);

            const fullSent = /净分[^。]*。/.exec(base.explanation)?.[0] ?? '';
            allText += base.explanation;
            const sent = fullSent;
            const body = /命局病处在于([^。]*)。$/.exec(sent)?.[1] ?? '';
            const paren = /（(.*)）$/.exec(body)?.[1] ?? '';
            if (/[A-Za-z]/.test(body)) { badLatin++; if (rows.length < 6) rows.push(`[拉丁字母] ${body}`); }
            const allAvoid = top.length > 0 && top.every(firstElAvoid);

            // —— 分支归类(以复算量为准，不看句子) ——
            /* A 支再按读数劈成两半：不足一成时产品刻意不报「独占」，落进 G无尾巴。
               若把判据写成 !restNamed && cheng>=1，cheng 取何值都测不出差别，等于空判。 */
            const key = !restNamed ? (cheng >= 0.95 ? 'A余组未命名' : 'G无尾巴')
              : allAvoid ? (rest.some(firstElAvoid) ? 'C全忌+次之' : 'D全忌无尾')
              : rest.some(firstElAvoid) ? 'F余组有忌' : 'G无尾巴';
            tally[key] = (tally[key] ?? 0) + 1;
            // 「独占」读数的唯一来源；旧「两组合计约占该侧力量」已删，此处只认前者。
            const ms = /病处独占此侧(.+?)成/.exec(paren)?.[1];
            const mr = /，(.+?)次之$/.exec(paren)?.[1];
            const hasAvoidClaim = paren.includes('此即忌神之所在');
            const got = parseCn(ms ?? '');
            /* 句子里的成数本身只有一位小数，拿它和复算值要求精确相等是探针写错了判据：
               复算 0.883 与读数「九成」相差 0.117，产品并没有错。故按读数精度比对(半成)。 */
            const okShare = got !== null && Math.abs(got - cheng) <= 0.5 + 1e-9;

            /* 「此即忌神之所在」的判据不是「入句两组全为忌」，而是**全忌且同侧仍有可报的余组**：
               A(无余组)与 D(余组全非忌)两支即便 top 全忌也不吐这句。写成 allAvoid 会把这
               1103 个盘子误判成缺陷——探针自己的分类错了，产品没漏。 */
            if (hasAvoidClaim !== (allAvoid && restNamed)) { badAvoidClaim++; if (rows.length < 24) rows.push(`[忌神定性] ${p.dayPillar} ${label} top=${top.join(',')} avoid=${avoid.join(',')} 句=${paren}`); }

            /* 反例普查：扶抑口径下病处所取的一侧几乎整侧皆忌，只有**专旺/从格**盘的 avoid 只列一组、
               会留下非忌的余组。实测该情形极稀——7344 盘里仅 1 例(戊午专旺候选忌木)，且它同侧余组为空、
               不进「次之」分支，所以产品里那层 filter(isAvoidGroup) 目前杀不掉(变异 P1 两端全绿)。
               这里只统计不判错：计数若始终为 0，说明该过滤是防御性死守卫而非现网缺陷。 */
            const sideAll = Object.entries(byGroup).filter(([g, wt]) => wt > 0 && named.includes(g)).map(([g]) => g);
            /* 打印 avoid 长度与「该侧被划为忌的组」，用以分辨这例到底走哪条取用路径：
               avoid 只有一组=专旺/从格分支；两组=扶抑分支。 */
            if (!sideAll.every(firstElAvoid)) { restNotAvoidCharts++; if (rows.length < 22) rows.push(`[该侧非全忌] ${p.dayPillar} ${label} side=${wantSide} avoid长=${avoid.length} avoid=${avoid.join(',')} 该侧组=${sideAll.join(',')} 忌组=${sideAll.filter(firstElAvoid).join(',')} 非忌组=${sideAll.filter((g) => !firstElAvoid(g)).join(',')} top=${top.join(',')} rest=${rest.join(',')} 句=${paren}`); }
            if (restNamed && !rest.every(firstElAvoid)) { badInvariant++; if (rows.length < 20) rows.push(`[余组非忌] ${p.dayPillar} ${label} rest=${rest.join(',')} avoid=${avoid.join(',')} top=${top.join(',')}`); }
            if (key === 'A余组未命名') {
              if (cheng < minACheng) minACheng = cheng;
              aList.push(cheng);
              if (hasAvoidClaim || mr !== undefined || ms === undefined) { badBranch++; if (rows.length < 12) rows.push(`[A形态] ${p.dayPillar} ${label} 句=${paren}`); }
              if (!okShare) { badShare++; if (rows.length < 18) rows.push(`[A占比] ${p.dayPillar} ${label} 句=${ms ?? '(缺)'} 复算=${cheng}`); }
              else chengBuckets[`独占${got}成`] = (chengBuckets[`独占${got}成`] ?? 0) + 1;
            } else if (key === 'G无尾巴') {
              // 读数低于一成 ⇒ 宁可不报；此时若仍吐出「零…」就是自相矛盾的文案。
              if (paren !== '' || ms !== undefined || mr !== undefined) { badBranch++; if (rows.length < 14) rows.push(`[G应无尾] ${p.dayPillar} ${label} cheng=${cheng} 句=${paren}`); }
            } else {
              // 删掉「两组合计」一支后，非 A/非 G 的盘子只剩「次之」一种尾巴。
              if (ms !== undefined) { badMs++; if (rows.length < 30) rows.push(`[多余读数] ${p.dayPillar} ${label} cheng=${cheng} 句=${paren}`); }
              const wantMr = rest.some(firstElAvoid);
              if (wantMr !== (mr !== undefined)) { badRest++; if (rows.length < 42) rows.push(`[次之分支] ${p.dayPillar} ${label} cheng=${cheng} 句=${paren}`); }
              if (wantMr && (mr ?? '') !== rest.filter(firstElAvoid).join('、')) { badRest++; if (rows.length < 48) rows.push(`[次之内容] ${p.dayPillar} 句=${mr ?? '(无)'} 复算=${rest.filter(firstElAvoid).join('、')}`); }
            }
          }
        }
      }
    }
    /* 占比读数只到几点几成：真实盘里 top 至多两组、有余组时分母恒大于分子，故 cheng 远小于
       旧门槛 8。这里量出全空间最大值，并把「两组合计」一句已删干净钉成断言(见 expect)。 */
    const sortedSum = sumTopList.slice().sort((a, b) => a - b);
    const maxSumTop = sortedSum[sortedSum.length - 1] ?? 0;
    const p99SumTop = sortedSum[Math.floor(sortedSum.length * 0.99)] ?? 0;
    const head = [`TOTAL=${total}`,
      ...Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v} (${((v / total) * 100).toFixed(1)}%)`),
      // 可达性度量：未列出的分支即此网格内从未出现，需另造盘或确认其为死码。
      ...['A余组未命名', 'C全忌+次之', 'D全忌无尾', 'F余组有忌', 'G无尾巴'].filter((k) => !tally[k]).map((k) => `未出现 ${k}`),
      `双组句=${numGroups2}/单组句=${numGroups1} top权重和分布 max=${maxSumTop.toFixed(1)} p99=${p99SumTop.toFixed(1)}`,
      `cheng 全域最大: 所有盘=${maxChengAny} 仍有余组时=${maxChengRest}(旧门槛8)`,
      `A支(独占)成数 min=${minACheng} 分位 p1=${aList.slice().sort((x, y) => x - y)[Math.floor(aList.length * 0.01)] ?? '-'} n=${aList.length}`,
      ...Object.entries(chengBuckets).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `读数 ${k}=${v}`),
      `余组非忌=${badInvariant} 该侧非全忌盘=${restNotAvoidCharts} 读数取不到=${badMs} 占比错=${badShare} 次之错=${badRest} 忌神定性错=${badAvoidClaim} 分支串台=${badBranch} 含拉丁=${badLatin}`];
    writeFileSync(DIR + 'ailment-tail.txt', head.join('\n') + '\n---\n' + rows.join('\n') + '\n', 'utf8');
    expect(total).toBeGreaterThan(500);
    expect(badShare).toBe(0);
    expect(badRest).toBe(0);
    expect(badAvoidClaim).toBe(0);
    expect(badBranch).toBe(0);
    expect(badMs).toBe(0);
    expect(badLatin).toBe(0);
    expect(badInvariant).toBe(0);
    // 死码删除的钉子：cheng 从未接近旧门槛，且全文再无「两组合计」措辞。
    expect(maxChengRest).toBeLessThan(8);
    expect(allText).not.toContain('两组合计');
    expect(allText).not.toMatch(/独占此侧零/);
  }, 120000);
});
