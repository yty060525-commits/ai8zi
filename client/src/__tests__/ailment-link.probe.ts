import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis } from '../data/localAnalysis';
import { ELEMENTS, stemElementIndex, STEMS } from '../features/chart/elements';

/* 取证扫描 6：本命段里「命局病处在于X」与「喜用定为…忌…」两句是否互相指认。
 * 现状（读 localAnalysis.ts:298 与 :305 两处 push）：两句各自独立发射，正文从不说明
 *   「病处所在的那一组，正是忌神」或「正是喜用」。对身弱档而言病处取克泄耗方、
 *   而忌神也是克泄耗方 —— 两者恒等；对身强档病处取助身方、忌神也是助身方 —— 亦恒等。
 * 若恒等成立，则「病处」这句其实可以直接将忌神点名，读者能对上号；现在没写，等于
 *   把一条现成的因果链丢了。本探针量的是**这个缺口有多大**，不改判据。
 * 读数口径：从引擎 explanation 抠出两组五行/十神组名，按产品同一张表(GROUP→其两个五行)
 *   比较集合关系；不复制措辞逻辑。 */
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
const GROUP_OF_TEN_GOD: Record<string, string> = {
  比肩: '比劫', 劫财: '比劫', 食神: '食伤', 伤官: '食伤', 偏财: '财', 正财: '财',
  七杀: '官杀', 正官: '官杀', 偏印: '印', 正印: '印',
};
void GROUP_OF_TEN_GOD; void STEMS; void stemElementIndex; void ELEMENTS;

describe('病处句与喜忌句的互指缺口（取证）', () => {
  it('枚举真实盘，统计两句集合关系', () => {
    const out: string[] = [];
    let charts = 0;
    let ailInAvoidAll = 0, ailPartial = 0, ailDisjoint = 0, unparsed = 0;
    const sampleBad: string[] = [];
    const unparsedSamples: string[] = [];
    for (let year = 1964; year <= 2004; year += 4) {
      for (let month = 2; month <= 11; month += 3) {
        for (const day of [6, 19]) {
          for (const hour of [5, 12, 22]) {
            const p = computePillarsFromDate({ year, month, day, hour });
            let n;
            try { n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, 'male', NOW.toISOString()); }
            catch { continue; }
            const rec = { id: `c-${year}${month}${day}${hour}`, name: 'c', gender: 'male', createdAt: NOW.toISOString(),
              birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord;
            const base = buildLocalAnalysis(rec, NOW);
            if (!base) continue;
            charts++;
            // 喜忌那句：故喜用定为A、B、C，忌D、E。
            const xy = /故喜用定为([^，]+)，忌([^。]+)。/.exec(base.explanation);
            const ail = /命局病处在于([^。]+)。/.exec(base.explanation);
            if (!xy || !ail) { unparsed++; continue; }
            const avoid = xy[2].split('、');
            // 病处短语里的组名 → 该组五行集合，看它是否整组落在忌神五行里
            const namedGroups = [...ail[1].matchAll(/(食伤太旺|财星耗身|官杀攻身|比劫结党|印绶太过)/g)].map((x) => x[1]);
            if (!namedGroups.length || namedGroups.length !== ail[1].split('，兼有').length) {
              unparsed++;
              if (unparsedSamples.length < 4) unparsedSamples.push(`${p.dayPillar} ${n.strengthScore?.label ?? ''} 原句=${ail[1]}`);
              continue;
            }
            const groups = namedGroups.map((g) => ({ 食伤太旺: '食伤', 财星耗身: '财', 官杀攻身: '官杀', 比劫结党: '比劫', 印绶太过: '印' }[g] as string));
            /* 判据按**组**对齐产品的侧别来源，但必须只比该组的**首字**：deriveUsefulAvoid 整组入表时
               只写 rel(dayIdx, offset) 的首字，第二字未必在 avoid 里。旧实现要求两字都在(els.every)，
               与产品口径不符、会把「忌印」误判成不忌，虚报缺口——已改成只取首字。 */
            const dayIdx = stemElementIndex(p.dayPillar[0]);
            const avoidGroups = new Set<string>();
            for (const [g, f] of Object.entries({ 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 })) {
              if (avoid.includes(ELEMENTS[(dayIdx + f) % 5])) avoidGroups.add(g);
            }
            const all = groups.every((g) => avoidGroups.has(g));
            const any = groups.some((g) => avoidGroups.has(g));
            if (all) ailInAvoidAll++; else if (any) ailPartial++; else ailDisjoint++;
            if (!all && sampleBad.length < 5) sampleBad.push(`${p.dayPillar} ${n.strengthScore?.label} 忌组=${[...avoidGroups].join(',')} 病处组=${groups.join(',')}`);
          }
        }
      }
    }
    out.push(`CHARTS=${charts} 未能解析=${unparsed}`);
    out.push(`病处整组都在忌神内=${ailInAvoidAll} ${((ailInAvoidAll / charts) * 100).toFixed(1)}%`);
    out.push(`病处部分在忌神内=${ailPartial} ${((ailPartial / charts) * 100).toFixed(1)}%`);
    out.push(`病处完全不在忌神内=${ailDisjoint} ${((ailDisjoint / charts) * 100).toFixed(1)}%`);
    out.push('解析失败(句里出现表外短语或组数异常)=' + unparsed);
    for (const s of unparsedSamples) out.push('  未解析 ' + s);
    for (const s of sampleBad) out.push('  样本 ' + s);
    writeFileSync(DIR + 'ailment-link.txt', out.join('\n') + '\n', 'utf8');
    expect(charts).toBeGreaterThan(50);
  });
});
