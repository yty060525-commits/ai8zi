import { describe, expect, it } from 'vitest';
import { hydrateRecord } from '../data/clientRepository';
import type { BaziRecord } from '../types/domain';

/** 去年 3 月建的盘：当年窗口是 [去年, 去年+9]，与今年窗口 [今年, 今年+9] 重叠但错位一年。 */
const year = new Date().getFullYear();
const lastYear = new Date(Date.UTC(year - 1, 2, 8, 12, 34, 56)).toISOString();
/** 大运段按十年整数边界排定的旧记录(现在引擎按起运排定，起点不再是整十年)。 */
const decadeStart = Math.floor((year - 1) / 10) * 10;
/** 真正「整段走完」的旧运：终点还差着一年才够到窗口起点。
 *  decadeStart+9 在 year 是 0/1 结尾时会自己够到今年(如 2020-2029 之于 2026)，那不算走完。 */
const finishedEnd = year - 2;
/** 去年建盘时正在走的那一运：今年仍没交出去(endYear 够到窗口起点)，属「未来十年这段路」→ 该留。 */
const runningStart = year - 1;
const lastYearTasks: Array<[string, Record<string, unknown>]> = [
  ['task-01', { type: 'baseline' }],
  ['task-02', { type: 'annual', year: year - 1 }],        // 新窗口不再含这一年
  ['task-03', { type: 'annual', year }],                  // taskId 相同、时段仍有效 → 保留待重跑
  ['task-12', { type: 'monthly', year: year - 1, month: 3 }],
  ['task-24', { type: 'decade', year: decadeStart, decade: { ganZhi: '乙酉', startYear: decadeStart, endYear: finishedEnd } }],
  // 与窗口有交集的当前运(起点在今年之前、终点还在今年之后)属于「未来十年这段路」→ 保留
  ['task-25', { type: 'decade', year: runningStart, decade: { ganZhi: '丙戌', startYear: runningStart, endYear: runningStart + 9 } }],
  // 起点压在窗口末尾的那一运同样相交 → 保留待重跑
  ['task-26', { type: 'decade', year: year + 9, decade: { ganZhi: '丁亥', startYear: year + 9, endYear: year + 18 } }],
];

/** 存量盘：去年建的，任务里带着旧窗口的大运/流年/流月。 */
function staleRecord(): BaziRecord {
  const mk = (id: string, task: Record<string, unknown>): [string, never] => [id, { task: { taskId: id, ...task }, status: 'not_configured' } as never];
  return {
    id: 'stale', name: '旧盘', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: lastYear,
    yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未',
    aiStatus: 'not_configured',
    // 存储是瘦身过的：派生数组为空，读取时才会重算出完整排盘数据
    nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } as unknown as BaziRecord['nonAiResult'],
    aiTasks: Object.fromEntries(lastYearTasks.map(([id, task]) => mk(id, task))),
  } as unknown as BaziRecord;
}

describe('存量盘的过期时段任务不再显示(标题承诺「从今天起」)', () => {
  it('旧窗口的流年/流月/大运条目被剔除，本命与仍在窗口内的保留', async () => {
    const before = Object.keys(staleRecord().aiTasks ?? {});
    expect(before).toContain('task-02');
    const after = Object.keys((await hydrateRecord(staleRecord())).aiTasks ?? {});
    expect(after).toContain('task-01');       // 本命永远保留
    expect(after).toContain('task-03');       // 同一任务号仍是有效时段
    expect(after).not.toContain('task-02');   // 上一年的流年
    expect(after).not.toContain('task-12');   // 去年 3 月的流月
    expect(after).not.toContain('task-24');   // 整段走完的旧大运段(endYear = year-2，够不到窗口起点)
    expect(after).toContain('task-25');       // 今年仍在走的那一运：与窗口有交集，属「未来十年这段路」
    expect(after).toContain('task-26');       // 还没轮到的下一运：该留在「未来大运」里
  });

  it('没有排盘数据可重算时不报错，原样返回', async () => {
    const r = { ...staleRecord(), birthYear: undefined } as unknown as BaziRecord;
    const out = await hydrateRecord(r);
    expect(Object.keys(out.aiTasks ?? {})).toEqual(expect.arrayContaining(['task-02', 'task-24']));
  });
});
