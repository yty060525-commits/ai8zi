import { afterEach, describe, expect, it } from 'vitest';
import { configureBaziRepository, getBaziRecord, initializeMockSession, listBaziRecords, memoryBaziRepository, resetMockSession, saveBaziRecord } from '../data/clientRepository';
import { DECADE_WINDOW_YEARS, analysisHorizon, buildBaziTasks, plannedTaskIds } from '../data/baziOrchestrator';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziRecord } from '../types/domain';

/* 进度分母要跨「完整盘 / 瘦身后存储」两种数据厚度同源，靠的是落库时记下的 decadeSlots。
   实测抓到过三种失败，各有一条用例钉着：① 保存时压根没记这个数；② 存量盘从没再保存过 ⇒ 只有读
   列表这条路能补上它；③ 补齐只发生在读取那一刻、没写回存储 ⇒ 换台设备又是空的。

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

  /* 保存只能补「数量」这一格，不许把完整派生数组带回去。曾经这里图省事把 hydrate 出来的整份
     完整盘当返回值交出去，于是同一次保存出现三种厚度(存储 gf=0、详情 gf=9、返回值自身 gf=9) ——
     任何比较两次读取的调用方都会判成数据不一致。 */
  it('保存时补槽位数不能把完整派生数组带回存储或返回值里', async () => {
    initializeMockSession([{ id: 'p1', name: '槽位盘', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }],
      [{ person: { id: 'p1', name: '槽位盘', nameInitial: 'C', gender: 'male', birthSummary: '甲子年' }, record: mk(), aiAnalysis: { status: 'pending', result: '' } }]);
    const returned = await saveBaziRecord(mk());   // mk() 带完整排盘，正是最容易漏出数组的那种入参
    expect(returned.nonAiResult?.decadeSlots, '前提：这次保存确实算出了槽位数').toBe(windowedCount(mk()));
    expect(returned.nonAiResult?.greatFortunes ?? [], '返回值漏出了完整大运数组').toHaveLength(0);
    // 走存储这条路，不走带补齐逻辑的列表读取：否则这条钉子会被另一条路补上，看不出保存本身有没有落。
    const stored = (await memoryBaziRepository.getBaziRecord('p1'));
    expect(stored?.nonAiResult?.decadeSlots, '存储里没落上槽位数').toBe(windowedCount(mk()));
    expect(stored?.nonAiResult?.annualFortunes ?? [], 'hydrate 的完整数组被顺手写回了存储').toHaveLength(0);
    expect(stored).toEqual(returned);
  });

  /* 线上实测抓到的那一种：改动之前建的盘再没被保存过，槽位数一直是空的，而它只有重算排盘才数得出来。
     旧实现只在保存那条路回写，所以这种盘要等用户下一次保存才修好 —— 在此之前列表分母永远比详情少
     一段(界面读到 2/24、状态栏 2/25)。下面三条各钉这条路上的一个环节，缺一环都会红在哪一环上。 */

  /** 造一条「这次改动之前」的存量盘：数组是空的、槽位数也没钉上，且**没有**再经保存函数写过。 */
  const legacyInStore = async (): Promise<BaziRecord> => {
    configureBaziRepository(memoryBaziRepository);
    await saveBaziRecord(mk());
    const stamped = (await listBaziRecords()).find((r) => r.id === 'p1')!;
    expect(stamped.nonAiResult?.decadeSlots, '前提：新建的盘本来就该带着槽位数').toBe(windowedCount(mk()));
    // 绕过带补齐逻辑的导出函数，直接写成改动之前的样子。
    const legacy: BaziRecord = { ...stamped, nonAiResult: { ...stamped.nonAiResult!, decadeSlots: undefined } };
    await memoryBaziRepository.saveBaziRecord(legacy);
    return legacy;
  };

  it('存量盘：读一次列表就把槽位数算出来(哪怕这条盘从没再保存过)', async () => {
    await legacyInStore();
    const first = (await listBaziRecords()).find((r) => r.id === 'p1');
    expect(first?.nonAiResult?.decadeSlots, '读列表没把存量盘的槽位数补上').toBe(windowedCount(mk()));
    const detail = await getBaziRecord('p1');
    expect(plannedTaskIds(first!).length, '补齐后的列表分母 ≠ 详情页分母').toBe(plannedTaskIds(detail!).length);
  });

  it('存量盘：补上的槽位数要真落库，不能只活在当次读取里', async () => {
    await legacyInStore();
    await listBaziRecords();          // 这一次负责补齐(顺带把值算进返回值)
    const again = (await listBaziRecords()).find((r) => r.id === 'p1');
    expect(again?.nonAiResult?.decadeSlots, '补齐只活在当次读取里 ⇒ 没有写回存储').toBe(windowedCount(mk()));
  });

  it('存量盘：补齐只许多带这一个数，不许把重算出的完整数组写回存储', async () => {
    await legacyInStore();
    await listBaziRecords();
    const rawNonAi = (await memoryBaziRepository.listBaziRecords()).find((r) => r.id === 'p1')?.nonAiResult!;
    expect(rawNonAi.decadeSlots, '前提：这一次补齐确实落了数').toBe(windowedCount(mk()));
    // 判据取三个数组而不是只看大运：漏回流年/流月同样违反存储约定，只查一个照样绿。
    expect([rawNonAi.greatFortunes.length, rawNonAi.annualFortunes.length, rawNonAi.monthlyFortunes.length],
      '补齐时把完整派生数组写回了存储').toEqual([0, 0, 0]);
  });
});
