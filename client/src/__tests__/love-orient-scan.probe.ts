import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import { STEMS, ELEMENTS, HIDDEN_STEMS } from '../features/chart/elements';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis, buildLocalTaskAnalysis } from '../data/localAnalysis';

/* 取证扫描 3（不改产品码，只读机器自己的正文）：
 * v3 第二轮把爱情句的取向改成「只看认出配偶星那条途径的字落在哪一侧」。这里在一大片真实盘上
 * 量三件事，用来决定下一步该不该继续动判据：
 *   A 侧别构成占比：偏喜 / 偏忌 / 两侧同现 / 只有宫位被引动（星未现）/ 未引动 —— 看有没有哪档空转。
 *   B 自相矛盾检测：取向词与依据是否冲突。判据不复用产品的 core.useful，而是从正文里那行
 *     「喜：… 忌：…」自己解析（独立于被测代码），再核对该句点名的那些字是否真在对应侧。
 *   C 「临忌」句里被点名的十神称谓是否仍是配偶星（防止又出现拿七杀当妻星说话）。 */
const DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const NOW = new Date('2026-09-26T06:00:00Z');
const EL_OF = (gan: string) => (STEMS.includes(gan) ? ELEMENTS[STEMS.indexOf(gan) >> 1] : '');
const MAIN_EL = (zhi: string) => EL_OF((HIDDEN_STEMS[zhi] ?? [])[0] ?? '');

describe('爱情取向句的全空间取证（v3 第二轮之后）', () => {
  it('统计侧别档位、检出取向与依据矛盾的句子并落盘', () => {
    const out: string[] = [];
    const tally: Record<string, number> = { 向喜用: 0, 临忌: 0, 喜忌同临: 0, 星本身未现: 0, 未受特别引动: 0, 其他: 0 };
    let rows = 0, charts = 0;
    const bad: string[] = [];
    for (let year = 1970; year <= 1998; year += 3) {
      for (let month = 2; month <= 11; month += 3) {
        for (const day of [6, 19]) {
          for (const [hour, gender] of [[3, 'male'], [14, 'female']] as const) {
            const p = computePillarsFromDate({ year, month, day, hour });
            let n;
            try {
              n = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, gender, NOW.toISOString());
            } catch { continue; }
            const rec = { id: `s-${year}${month}${day}${hour}`, name: 's', gender, createdAt: NOW.toISOString(),
              birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult: n, aiStatus: 'completed' } as unknown as BaziRecord;
            const base = buildLocalAnalysis(rec, NOW);
            if (!base) continue;
            charts++;
            // 独立取喜忌：读产品**自己印出来的那句**「故喜用定为X、Y，忌A、B。」，不 import 内部常量表
            const lead = /故喜用定为([^，。]+)，忌([^。]+)。/.exec(base.explanation)!;
            expect(lead, `本命正文里没有「故喜用定为…忌…」这句`).not.toBeNull();
            const useful = lead[1].split("、").filter((e) => ELEMENTS.includes(e as never));
            const avoid = lead[2].split("、").filter((e) => ELEMENTS.includes(e as never));
            for (const a of n.annualFortunes ?? []) {
              const task = { taskId: 'scan', type: 'annual' as const, year: a.year, annual: a };
              const one = buildLocalTaskAnalysis(rec, task as never, NOW);
              if (!one) continue;
              rows++;
              const line = (/【爱情】\n([\s\S]*?)(?:\n【|$)/.exec(one.explanation)?.[1] ?? '').trim();
              const key = ['向喜用', '临忌', '喜忌同临', '星本身未现', '未受特别引动'].find((k) => line.includes(k)) ?? '其他';
              tally[key]++;
              // 该句点名的字（「天干X为…」／「地支Y所藏本气Z」）——取向必须与这些字的侧别一致。
              //   ⚠ 只从**【爱情】那一句**里取，不能拿整篇正文去 matchAll：本命段那句
              //     「故喜用定为火、土，忌水、木、金。」会把「喜用定为火」误读成一个十神称谓，
              //     第一版就这么凭空造出过一批假矛盾（探针自己错，不是产品错）。
              const named: string[] = [];
              for (const m of line.matchAll(/天干(.)为/g)) named.push(EL_OF(m[1]));
              for (const m of line.matchAll(/本气(.)亦/g)) named.push(EL_OF(m[1]));
              const onHelp = named.filter((e) => e && useful.includes(e));
              const onHarm = named.filter((e) => e && avoid.includes(e));
              if (key === '向喜用' && onHarm.length > 0) bad.push(`${year}-${month}-${day} ${gender} ${a.ganZhi} 向喜用却点了忌侧字 ${JSON.stringify(named)} 喜${useful} 忌${avoid} :: ${line}`);
              if (key === '临忌' && onHelp.length > 0) bad.push(`${year}-${month}-${day} ${gender} ${a.ganZhi} 临忌却点了喜侧字 ${JSON.stringify(named)} 喜${useful} 忌${avoid} :: ${line}`);
              if ((key === '向喜用' || key === '临忌') && named.length === 0) bad.push(`${year}-${month}-${day} ${gender} ${a.ganZhi} 取向句没点名任何字 :: ${line}`);
              if (key === '临忌' && !/财之星|官杀之星/.test(line) && onHarm.length === 0) {
                bad.push(`${year}-${month}-${day} ${gender} ${a.ganZhi} 临忌句既没说配偶星依据、点名的字也不在忌侧 :: ${line}`);
              }
              // 硬断言：取向句点名的每一个字都必须真在该侧（不只是「存在一个对得上的」）。
              if (key === '向喜用') for (const e of named) if (!useful.includes(e)) bad.push(`${year}-${month}-${day} ${gender} ${a.ganZhi} 向喜用却点了非喜侧字「${e}」 喜${useful} :: ${line}`);
              if (key === '临忌') for (const e of named) if (!avoid.includes(e)) bad.push(`${year}-${month}-${day} ${gender} ${a.ganZhi} 临忌却点了非忌侧字「${e}」 忌${avoid} :: ${line}`);
            }
          }
        }
      }
    }
    const pct = (x: number) => `${((x / rows) * 100).toFixed(1)}%`;
    out.push(`CHARTS=${charts} ROWS=${rows}`);
    for (const k of Object.keys(tally)) out.push(`${k}=${tally[k]} ${pct(tally[k])}`);
    out.push(`矛盾数=${bad.length}`);
    out.push(...bad.slice(0, 40));
    writeFileSync(DIR + 'love-orient-scan.txt', out.join('\n') + '\n', 'utf8');
    expect(rows).toBeGreaterThan(500);
  });
});
