import { afterEach, describe, expect, it } from 'vitest';
import { getBaziRecord, initializeMockSession, listBaziRecords, resetMockSession, saveBaziRecord } from '../data/clientRepository';
import { DECADE_WINDOW_YEARS, analysisHorizon, buildBaziTasks, plannedTaskIds } from '../data/baziOrchestrator';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziRecord } from '../types/domain';

/* 进度分母要跨「完整盘 / 瘦身后存储」两种数据厚度同源，靠的是落库时记下的 decadeSlots。
   实测抓到过两种失败：① 槽位数压根没带进存储 ⇒ 列表比详情少一段大运；② 补齐只发生在读取那一刻、
   没写回存储 ⇒ 换台设备又是空的。这两条都能红，下面钉的就是它们。

   同时如实记下钉不住的那一类：引擎只排 GREAT(=9) 柱大运、起点恒为十年一格，实测扫 180 种四柱组合
   窗口内都恰好 1 段 —— 把上界挪 ±2 年不会改变任何输出。所以「排任务与记条数两处窗口脱钩」在现网
   是不可观测的，不拿一条恒真等式冒充钉子；两处的窗口年数改为共用 DECADE_WINDOW_YEARS。 */

const pillars = { birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
const chart = calculateNonAi(pillars, 'male', '2025-01-01T00:00:00.000Z');

const mk = (): BaziRecord => ({
  id: 'p1', name: '槽位盘', gender: 'male', birthYear: 1990, birthMonth: 5,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: chart, aiStatus: 'pending', aiTasks: {},
});

/** 前提钉子：这份 fixture 真的有一个落在窗口内的大运段，否则下面的相等断言是空转（0 === 0）。 */
const windowedCount = (record: BaziRecord): number => {
  const year = analysisHorizon(record).year;
  return (record.nonAiResult?.greatFortunes ?? []).filter((g) => g.startYear > year && g.startYear <= year + DECADE_WINDOW_YEARS).length;
};

afterEach(() => { resetMockSession(); });

describe('大运槽位数在完整盘与瘦身存储之间同源', () => {
  it('前提：fixture 至少有一段大运落在本轮窗口内', () => {
    expect(windowedCount(mk()), '换一份四柱或改年份，让窗口里真有一运').toBeGreaterThan(0);
  });

  it('存进库再读回来：列表那条的分母仍等于详情页那条', async () => {
    initializeMockSession([{ id: 'p1', name: '槽位盘', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }],
      [{ person: { id: 'p1', name: '槽位盘', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }, record: mk(), aiAnalysis: { status: 'pending', result: '' } }]);
    await saveBaziRecord(mk());

    const slim = (await listBaziRecords())[0];
    const full = await getBaziRecord('p1');
    /* 存储本就只该存瘦身后的派生数组：这条钉子防的是「为了带槽位数而把整份完整盘写回去」，
       那会让每条记录的存储体积翻几十倍(实测 domain.test 就是被这个打破的)。 */
    expect(slim.nonAiResult?.greatFortunes?.length ?? 0, '前提：列表这条路是大运数组为空的瘦身记录').toBe(0);
    expect(slim.nonAiResult?.annualFortunes?.length ?? 0, '补齐槽位数不许顺带把流年数组写回存储').toBe(0);
    expect(typeof slim.nonAiResult?.decadeSlots, '瘦身后必须带着槽位数').toBe('number');

    const slimSlots = buildBaziTasks(slim).filter((t) => t.type === 'decade').length;
    expect(slimSlots, '瘦身后按槽位数补出的大运任务数 ≠ 完整盘排出来的任务数 ⇒ 分母不同源')
      .toBe(buildBaziTasks(full!).filter((t) => t.type === 'decade').length);
    expect(plannedTaskIds(slim).length, '列表分母 ≠ 详情分母').toBe(plannedTaskIds(full!).length);
  });

  /* 补齐只该补「数量」这一格。曾经这里图省事把 hydrate 出来的整份完整盘当返回值交出去，
     于是同一次保存出现三种厚度(存储 gf=0、详情 gf=9、返回值自身 gf=9) —— 任何比较两次读取的
     调用方都会判成数据不一致。这条钉的就是：落库那份仍是瘦身存储，返回那份也是。 */
  it('补槽位数不能把完整派生数组带回存储或返回值里', async () => {
    initializeMockSession([{ id: 'p1', name: '槽位盘', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }],
      [{ person: { id: 'p1', name: '槽位盘', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }, record: mk(), aiAnalysis: { status: 'pending', result: '' } }]);
    const legacy: BaziRecord = { ...mk(), nonAiResult: { ...chart, greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } };
    expect(legacy.nonAiResult?.decadeSlots, '前提：这份就是没钉过槽位数的存量盘').toBeUndefined();
    const returned = await saveBaziRecord(legacy);
    expect(returned.nonAiResult?.decadeSlots, '存一次就把槽位数钉进返回值').toBe(windowedCount(mk()));
    expect(returned.nonAiResult?.greatFortunes ?? [], '返回值漏出了完整大运数组').toHaveLength(0);
    const stored = (await listBaziRecords()).find((r) => r.id === 'p1');
    expect(stored?.nonAiResult?.decadeSlots, '存储里没落上槽位数').toBe(windowedCount(mk()));
    expect(stored?.nonAiResult?.annualFortunes ?? [], 'hydrate 的完整数组被顺手写回了存储').toHaveLength(0);
    expect(stored).toEqual(returned);
  });

  it('存量记录（库里既无数组也无槽位数）：读一次列表就要把槽位数补上并回写', async () => {
    initializeMockSession([{ id: 'p1', name: '槽位盘', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }],
      [{ person: { id: 'p1', name: '槽位盘', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }, record: mk(), aiAnalysis: { status: 'pending', result: '' } }]);
    await saveBaziRecord(mk());
    // 模拟这次改动之前建的盘：抹掉槽位数，只剩空数组。
    const stamped = (await listBaziRecords())[0];
    const legacy: BaziRecord = { ...stamped, nonAiResult: { ...stamped.nonAiResult!, decadeSlots: undefined } };
    expect(legacy.nonAiResult?.decadeSlots, '前提：这条就是没有槽位数的存量盘').toBeUndefined();
    await saveBaziRecord(legacy);

    const reread = (await listBaziRecords()).find((r) => r.id === 'p1');
    expect(reread?.nonAiResult?.decadeSlots, '读一次列表就该把存量盘的槽位数补齐').toBe(windowedCount(mk()));
    // 上面那次读可能只是「边读边算」，第二次再读仍为空就说明没真落库 —— 上一版就栽在这里。
    const again = (await listBaziRecords()).find((r) => r.id === 'p1');
    expect(again?.nonAiResult?.decadeSlots, '补齐只活在当次读取里 ⇒ 没有写回存储').toBe(windowedCount(mk()));
  });
});
