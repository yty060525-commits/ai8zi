import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis } from '../data/localAnalysis';
import { STEMS, ELEMENTS, stemElementIndex } from '../features/chart/elements';
void STEMS;

/* 取证扫描 7：本命段里相邻两句的**自相矛盾面**。
 * localAnalysis.ts 同一小节连着发射两句：
 *   :298  `净分…，档位判为${label}；命局病处在于${ailment(score, label)}。`
 *   :305  `依扶抑通则，${principle}，故喜用定为${useful}，忌${avoid}。`
 * ailment() 取「该侧权重最大的两组」，deriveUsefulAvoid() 把**整组**划进 avoid。
 * 于是身强/中和偏旺档会出现：前句说「病处在印绶太过」、后句说「忌印」——同一字既是病又是忌。
 * 这究竟是同义重复还是硬矛盾（病处点名的组却被列为喜用），取决于「某组是否属忌」怎么判：
 * 旧实现拿一组的两个五行字求交来判，与 deriveUsefulAvoid 只记首字的口径不符，会得出相反结论，
 * 因而虚报出一批「硬矛盾」。改成只比首字后重测：病处点名的组从不落进喜用集合(硬矛盾=0%)，
 * 即两句是「病即所忌」的同义呼应、并无自相矛盾。本探针量三种关系各占多少并钉住这一判据。 */
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
const PHRASE_GROUP: Record<string, string> = {
  食伤太旺: '食伤', 财星耗身: '财', 官杀攻身: '官杀', 比劫结党: '比劫', 印绶太过: '印',
};

describe('病处句与喜忌句的矛盾面（取证）', () => {
  it('枚举真实盘，按组名直接比对两句的点名集合', () => {
    const out: string[] = [];
    let charts = 0, unparsed = 0;
    let subsetOfAvoid = 0, partlyInAvoid = 0, disjointFromAvoid = 0;
    let namedAsUseful = 0;   // 最硬矛盾：病处点名的组同时出现在「喜用定为…」里
    const samplesHard: string[] = [];
    const byLabel: Record<string, number> = {};
    for (let year = 1961; year <= 2005; year += 2) {
      for (let month = 2; month <= 11; month += 3) {
        for (const day of [6, 19]) {
          for (const hour of [5, 12, 22]) {
            const p = computePillarsFromDate({ year, month, day, hour });
            let n;
            try { n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, 'male', NOW.toISOString()); }
            catch { continue; }
            const rec = { id: `d-${year}${month}${day}${hour}`, name: 'd', gender: 'male', createdAt: NOW.toISOString(),
              birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord;
            const base = buildLocalAnalysis(rec, NOW);
            if (!base) continue;
            charts++;
            const xy = /故喜用定为([^，]+)，忌([^。]+)。/.exec(base.explanation);
            // 允许句里带括号补充（v4 起会写「（此即忌神之所在）」），只截到该句末的句号
            const ail = /命局病处在于([^。]*)。/.exec(base.explanation);
            if (!xy || !ail) { unparsed++; continue; }
            // 两句都用**组名**表达：病处短语→组名；喜忌那半句里忌/喜用的是五行字，
            // 但产品划侧别本就按组，故这里改用「忌神是否覆盖该组的两个五行」来还原组归属。
            const groups = ail[1].replace(/（[^）]*）/g, '').split('，兼有').map((s) => {
              const key = Object.keys(PHRASE_GROUP).find((k) => s.startsWith(k));
              return key ? PHRASE_GROUP[key] : `?${s}`;
            });
            if (groups.some((g) => g.startsWith('?'))) { unparsed++; continue; }
            const label = n.strengthScore?.label ?? '?';
            const dayIdx = stemElementIndex(p.dayPillar[0]);
            const avoidEls = xy[2].split('、');
            const usefulEls = xy[1].split('、');
            /** 某组是否被划进给定的五行字集合。必须与 deriveUsefulAvoid 同口径：它按整组只取
             *  rel(dayIdx, offset) 的**首字**入表，第二字未必在表里——拿两字求交(旧实现)会得出
             *  相反结论，把「忌印」误判成「不忌印」。 */
            const groupIn = (g: string, els: string[]) => {
              const f: Record<string, number> = { 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 };
              return els.includes(ELEMENTS[(dayIdx + f[g]) % 5]);
            };
            const inAvoid = groups.filter((g) => groupIn(g, avoidEls));
            const inUseful = groups.filter((g) => groupIn(g, usefulEls));
            if (inAvoid.length === groups.length) subsetOfAvoid++;
            else if (inAvoid.length) partlyInAvoid++;
            else disjointFromAvoid++;
            if (inUseful.length) {
              namedAsUseful++;
              if (samplesHard.length < 6) samplesHard.push(`${p.dayPillar} ${label} 病处=${groups.join(',')} 喜用=${usefulEls.join('/')} 忌=${avoidEls.join('/')}`);
            }
            byLabel[label] = (byLabel[label] ?? 0) + 1;
          }
        }
      }
    }
    out.push(`CHARTS=${charts} 未能解析=${unparsed}`);
    out.push(`病处全部组都在忌神内=${subsetOfAvoid} ${((subsetOfAvoid / charts) * 100).toFixed(1)}%`);
    out.push(`病处部分组在忌神内=${partlyInAvoid} ${((partlyInAvoid / charts) * 100).toFixed(1)}%`);
    out.push(`病处完全不在忌神内=${disjointFromAvoid} ${((disjointFromAvoid / charts) * 100).toFixed(1)}%`);
    out.push(`★病处点名的组同时被列为喜用(硬矛盾)=${namedAsUseful} ${((namedAsUseful / charts) * 100).toFixed(1)}%`);
    out.push('档位分布=' + JSON.stringify(byLabel));
    for (const s of samplesHard) out.push('  硬矛盾样本 ' + s);
    writeFileSync(DIR + 'ailment-conflict.txt', out.join('\n') + '\n', 'utf8');
    expect(charts).toBeGreaterThan(100);
  });
});
