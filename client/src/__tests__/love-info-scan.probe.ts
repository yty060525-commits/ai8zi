import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import { STEMS, ELEMENTS, HIDDEN_STEMS } from '../features/chart/elements';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis, groupElements } from '../data/localAnalysis';

/* 取证扫描 4：爱情取向的**信息量**。
 * 「临忌／向喜用」只看配偶星自己落在喜侧还是忌侧，而 deriveUsefulAvoid 是按**整组**划侧别的：
 *   身强档 忌 = 印 + 比劫；身弱档 忌 = 财 + 官杀 + 食伤。
 * 于是身弱盘的配偶星（男命财、女命官杀）**恒在忌侧**——只要引动就必判「临忌」，
 * 那半句等于没有信息。这里量三件事：
 *   A 档位分布（有多少盘属于「配偶星被整组划进忌侧」的情形）；
 *   B 配偶星是否恒落单侧（按盘统计：该盘十年流年里配偶星字的侧别集合大小）；
 *   C 若引入大运层（权重最大的当期因素）做二次权衡，措辞会改判的比例有多大。 */
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
/** 天干 → 五行。返回 string（不返回 ElementKey）：ELEMENTS 是只读元组，
 *  而下游 groupElements/useful/avoid 都按 string[] 交互，这里统一放宽成 string。 */
const EL = (gan: string): string => (STEMS.includes(gan) ? ELEMENTS[STEMS.indexOf(gan) >> 1] : '');
const MAIN_EL = (zhi: string) => EL((HIDDEN_STEMS[zhi] ?? [])[0] ?? '');
/** 十神 → 分组：产品里这张表未导出，探针按同一份十神标签自行归组。
 *  （分组口径的唯一真源仍是 localAnalysis 的 TEN_GOD_GROUP；这里只做标签→组的映射。） */
const TO_GROUP: Record<string, string> = {
  比肩: '比劫', 劫财: '比劫', 食神: '食伤', 伤官: '食伤', 偏财: '财', 正财: '财',
  七杀: '官杀', 正官: '官杀', 偏印: '印', 正印: '印',
};
/** 某干相对日主的十神（与引擎 tenGodOf / 产品 stemGodOf 同口径：五行差定类、阴阳差定偏正）。 */
const godOf = (day: string, other: string): string => {
  const d = (((STEMS.indexOf(other) >> 1) - (STEMS.indexOf(day) >> 1)) % 5 + 5) % 5;
  const same = (STEMS.indexOf(day) % 2) === (STEMS.indexOf(other) % 2);
  return d === 0 ? (same ? '比肩' : '劫财') : d === 1 ? (same ? '食神' : '伤官')
    : d === 2 ? (same ? '偏财' : '正财') : d === 3 ? (same ? '七杀' : '正官')
      : (same ? '偏印' : '正印');
};
const groupOf = (day: string, other: string): string => TO_GROUP[godOf(day, other)];

describe('爱情取向的信息量（配偶星侧别是否恒为单侧）', () => {
  it('按盘统计配偶星侧别集合与档位，并落盘读数', () => {
    const out: string[] = [];
    /* 钉子一：配偶星集合恒为**两个相邻五行下标** (i+off, i+off+1) mod 5。
     *   这条算式曾被我口算错（把 (1+2)%5 当成 4=水，实际是 3=金），故当场比对而不是心算。 */
    for (const [g, off] of Object.entries({ 比劫: 0, 食伤: 1, 财: 2, 官杀: 3, 印: 4 })) {
      for (let i = 0; i < 5; i++) {
        expect(groupElements(i, g), `组${g}@${i}`).toEqual([ELEMENTS[(i + off) % 5], ELEMENTS[(i + off + 1) % 5]]);
      }
    }
    /* 钉子二：探针自写的 godOf 必须与产品在同一批干支对上给同一标签 —— 两条途径的十神读法同源。
     *   实测丁→壬 正官、丁→癸 七杀、乙→辛 七杀、乙→戊 正财（前两次错抄都把 丁→壬 判成财）。 */
    const SAMPLE_GODS: [string, string, string][] = [['丁', '壬', '正官'], ['丁', '癸', '七杀'], ['丁', '庚', '正财'], ['丁', '辛', '偏财'], ['乙', '辛', '七杀'], ['乙', '戊', '正财']];
    for (const [d, o, want] of SAMPLE_GODS) expect(godOf(d, o), `${d}->${o}`).toBe(want);
    let charts = 0;
    const labelTally: Record<string, number> = {};
    let spouseAlwaysAvoid = 0, spouseAlwaysHelp = 0, spouseBoth = 0, spouseNeverSeen = 0;
    let otherParityTotal = 0;
    for (let year = 1966; year <= 2002; year += 3) {
      for (let month = 2; month <= 11; month += 3) {
        for (const day of [7, 20]) {
          for (const [hour, gender] of [[4, 'male'], [15, 'female']] as const) {
            const p = computePillarsFromDate({ year, month, day, hour });
            let n;
            try { n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, gender, NOW.toISOString()); }
            catch { continue; }
            const rec = { id: `q-${year}${month}${day}${hour}`, name: 'q', gender, createdAt: NOW.toISOString(),
              birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord;
            const base = buildLocalAnalysis(rec, NOW);
            if (!base) continue;
            charts++;
            const label = n.strengthScore?.label ?? '?';
            labelTally[label] = (labelTally[label] ?? 0) + 1;
            const useful = base.usefulElements, avoid = base.avoidElements;
            // 配偶组 = 男财女官杀；该组的两个五行直接调产品的 groupElements。
            const dayIdx = ELEMENTS.indexOf(EL(p.dayPillar[0]) as (typeof ELEMENTS)[number]);
            const spouseGroup = gender === 'male' ? '财' : '官杀';
            const spouseEls: string[] = groupElements(dayIdx, spouseGroup);
            const sides = new Set<string>();
            for (const a of n.annualFortunes ?? []) {
              for (const e of [EL(a.ganZhi[0]), MAIN_EL(a.ganZhi[1])]) {
                if (!spouseEls.includes(e)) continue;
                sides.add(useful.includes(e) ? 'H' : avoid.includes(e) ? 'A' : 'N');
              }
            }
            const s = [...sides].sort().join('');
            if (s === 'A') spouseAlwaysAvoid++; else if (s === 'H') spouseAlwaysHelp++; else if (s === '') spouseNeverSeen++; else spouseBoth++;
            /* 交叉核对：钉住「配偶星两条途径」的真实关系 ——
             *   十神属配偶组 ⇒ 本期天干五行必在配偶星集合内（单向蕴含，恒真）；
             *   反向**不成立**：集合里那个「另一 parity」的五行会算成印/食伤等别的组
             *   （实测 丁火男命见壬水：壬在配偶星集合内，但十神是正官 ⇒ 走集合这条途径）。
             * 这条钉子连红三次，根因都在探针自己：先是把双向当成等价，再是手抄代数抄错，
             *   最后是我把 (1+2)%5 口算成 4(水) 而实际是 3(金)。产品两处读数一直自洽。 */
            const violations: string[] = [];
            let otherParity = 0;
            for (const a of n.annualFortunes ?? []) {
              const g = groupOf(p.dayPillar[0], a.ganZhi[0]);
              const inSet = spouseEls.includes(EL(a.ganZhi[0]));
              if (g === spouseGroup && !inSet) violations.push(`${a.ganZhi} 组${g}=${spouseGroup} 但干${EL(a.ganZhi[0])} 不在 [${spouseEls.join(',')}]`);
              if (inSet && g !== spouseGroup) otherParity++;
            }
            otherParityTotal += otherParity;
            for (const v of violations.slice(0, 3)) console.log('[VIOLATION]', v);
            expect(violations.length, `共 ${violations.length} 条蕴含违例`).toBe(0);
          }
        }
      }
    }
    out.push(`CHARTS=${charts}`);
    out.push('档位分布=' + JSON.stringify(labelTally));
    out.push(`配偶星十年只落忌侧=${spouseAlwaysAvoid} ${((spouseAlwaysAvoid / charts) * 100).toFixed(1)}%`);
    out.push(`配偶星十年只落喜侧=${spouseAlwaysHelp} ${((spouseAlwaysHelp / charts) * 100).toFixed(1)}%`);
    out.push(`配偶星两侧都出现过=${spouseBoth} ${((spouseBoth / charts) * 100).toFixed(1)}%`);
    out.push(`十年里配偶星一次都没出现=${spouseNeverSeen} ${((spouseNeverSeen / charts) * 100).toFixed(1)}%`);
    out.push('五行在集合内但十神属别组(反向不成立样本)=' + otherParityTotal);
    writeFileSync(DIR + 'love-info-scan.txt', out.join('\n') + '\n', 'utf8');
    expect(charts).toBeGreaterThan(100);
  });
});
