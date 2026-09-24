import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { FIRST_DECADE_TASK_INDEX, OVERVIEW_TASK_ID, buildBaziTasks, expectedTaskIds } from '../data/baziOrchestrator';
import { chinaYearMonth } from '../utils/date';
import { hydrateRecord, initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziAnalysisTask, BaziRecord, BaziTaskResult } from '../types/domain';

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: () => {} }));
import { analyzeBazi } from '../data/deepseekAdapter';

const year = new Date().getFullYear();

/** 起运落在「今年之前」的盘：十年窗口里含**当前正在走的那一运**(它 endYear 还够得到窗口末尾)，
 *  而界面分组④按 pruneStaleTasks 的口径只摆还没走到的运。两边口径不一致时，那一运就成了永远
 *  填不满的必填槽位 —— 23/23 都已完成的盘每次点「AI 分析」都会整轮重算(花的是真钱)。 */
const record: BaziRecord = {
  id: 'decade-gate', name: '大运槽位', gender: 'male', birthYear: 1990, birthMonth: 5,
  createdAt: new Date(Date.UTC(year - 1, 2, 8, 12, 34, 56)).toISOString(),
  yearPillar: '庚午', monthPillar: '辛巳', dayPillar: '乙酉', hourPillar: '癸未',
  aiStatus: 'completed', toneUsed: 80,
  // 存储里的派生数组是瘦身的：读取时由 hydrate 重算，再按重算结果清洗过期任务。
  nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } as never,
} as unknown as BaziRecord;

/** 「全盘总结」那条：界面有②段落，完整性判定必须连它一起看。 */
const overviewDone: BaziTaskResult = {
  task: { taskId: OVERVIEW_TASK_ID, type: 'overview' } as BaziTaskResult['task'],
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【核心结论】1. 主线。\n【值得关注的时间节点】1. 2027年(丙午)机会窗口。\n【行动建议】1. 抓上半年。' },
};

/** 按预期清单逐条造「已完成」结果。 */
function tasksFor(expected: Array<Pick<BaziAnalysisTask, 'taskId' | 'type' | 'year' | 'month'>>): Record<string, BaziTaskResult> {
  const out: Record<string, BaziTaskResult> = {};
  for (const t of expected) {
    out[t.taskId] = {
      task: { taskId: t.taskId, type: t.type, year: t.year, month: t.month } as BaziTaskResult['task'],
      status: 'completed',
      analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【健康】早睡早起。\n【事业】稳。\n【财运】平。\n【爱情】顺。\n【刑冲克害批注】无。' },
    } as BaziTaskResult;
  }
  return out;
}

function mount(withTasks: Record<string, BaziTaskResult>) {
  initializeMockSession(
    [{ id: record.id, name: record.name, nameInitial: 'D', gender: 'male', birthSummary: 'x' }],
    [{ person: { id: record.id, name: record.name, nameInitial: 'D', gender: 'male', birthSummary: 'x' }, record: structuredClone({ ...record, aiTasks: withTasks }), aiAnalysis: { status: 'completed' } }],
  );
  render(<PersonDetail personId={record.id} onBack={vi.fn()} />);
}

beforeEach(() => { vi.mocked(analyzeBazi).mockResolvedValue({ status: 'completed', analysis: { pattern: '身弱', strength: '弱', usefulElements: ['水'], avoidElements: ['火'], explanation: '重新生成的一段正文。' } } as never); });
afterEach(() => { cleanup(); resetMockSession(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* jsdom 可能禁用 storage */ } });

describe('已跑完的盘再点「AI 分析」不得整轮重算(大运槽位口径)', () => {
  /** 独立算一遍「该必填的任务清单」：本命 1 + 未来十年流年 10 + 滚动十二个月 + **起点晚于今年、
   *  且仍在十年窗口内**的大运(判据与 pruneStaleTasks/界面分组④逐字一致)。故意不复用 buildBaziTasks
   *  —— 两边各算各的对得上才叫契约，测试跟着实现改就测不出回归。 */
  function expectedTasks(full: BaziRecord): Array<Pick<BaziAnalysisTask, 'taskId' | 'type' | 'year' | 'month'>> {
    const out: Array<Pick<BaziAnalysisTask, 'taskId' | 'type' | 'year' | 'month'>> = [{ taskId: 'task-01', type: 'baseline' }];
    for (let i = 0; i < 10; i += 1) out.push({ taskId: `task-${String(i + 2).padStart(2, '0')}`, type: 'annual', year: year + i });
    // 滚动十二个月：起点与窗口同源(analysisHorizon)，跨年按月序推。
    const start = chinaYearMonth(new Date());
    for (let i = 0; i < 12; i += 1) {
      const off = start.month - 1 + i;
      out.push({ taskId: `task-${String(i + 12).padStart(2, '0')}`, type: 'monthly', year: start.year + Math.floor(off / 12), month: (off % 12) + 1 });
    }
    (full.nonAiResult?.greatFortunes ?? [])
      .filter((g) => g.startYear > year && g.startYear <= year + 9)
      .forEach((g, i) => out.push({ taskId: `task-${String(i + FIRST_DECADE_TASK_INDEX).padStart(2, '0')}`, type: 'decade', year: g.startYear }));
    return out;
  }

  it('任务窗口与界面分组④同一条判据：正在走的那一运两边都不算', async () => {
    const full = await hydrateRecord(structuredClone(record));
    const decades = buildBaziTasks(full, new Date()).filter((t) => t.type === 'decade');
    const running = (full.nonAiResult?.greatFortunes ?? []).find((g) => g.startYear <= year && g.endYear >= year);
    expect(running, '这盘今年不在任何大运段内，换出生数据才能复现').toBeTruthy();
    expect(decades.some((t) => t.year === running?.startYear), '当前运被当成必填槽位 → 永远填不满').toBe(false);
    // 窗口里排到的大运，必须与「未来大运」分组会摆出来的那几运完全一致(起点晚于今年、且落在十年窗口内)：
    // 界面摆了却没槽位、或有槽位界面看不到，都会让「结果完整」永远判不出来。
    const shown = (full.nonAiResult?.greatFortunes ?? []).filter((g) => g.startYear > year && g.startYear <= year + 9).map((g) => g.startYear);
    expect(decades.map((t) => t.year), '任务槽位与分组④不同源').toEqual(shown);
    expect(shown.length, '这盘十年内没有未来大运，用例需换出生数据').toBeGreaterThan(0);
  });

  it('按窗口逐条填满 → 命中缓存、一次 AI 都不调用', async () => {
    const full = await hydrateRecord(structuredClone(record));
    const expected = expectedTasks(full);
    expect(expected.length, '这盘十年内没有未来大运，用例需换出生数据').toBeGreaterThan(23);
    // 时段(月份跨年换算)归实现说了算，编号清单必须与独立推算逐条一致。
    const impl = buildBaziTasks(full, new Date());
    expect(impl.map((t) => t.taskId), '实现排出的编号清单与独立推算不一致').toEqual(expected.map((t) => t.taskId));
    const withOverview = { ...full, aiOverview: overviewDone.analysis } as BaziRecord;
    expect(expectedTaskIds(withOverview, new Date()), '界面必填清单与独立推算不一致').toEqual(expect.arrayContaining(expected.map((t) => t.taskId).concat(OVERVIEW_TASK_ID)));
    mount({ ...tasksFor(impl), [OVERVIEW_TASK_ID]: overviewDone });
    // 挂进视图的这条必须带着总结正文，否则界面上的「② 全盘总结」与判定用的清单对不上。
    expect((await hydrateRecord(withOverview)).aiOverview?.explanation, '读取路径丢了总结正文').toBeTruthy();
    await screen.findByRole('button', { name: 'AI 分析' });
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }));
    await waitFor(() => expect(screen.getByText(/已存在该语气下的完整分析结果/)).toBeTruthy(), { timeout: 5000 });
    expect(analyzeBazi, '本机结果被当成不完整而整轮重算').not.toHaveBeenCalled();
  });

  it('真的缺一条流年时也绝不静默复用：必须开跑补齐', async () => {
    const full = await hydrateRecord(structuredClone(record));
    const tasks = buildBaziTasks(full, new Date());
    const missing = tasks.find((t) => t.type === 'annual')!;
    mount(tasksFor(tasks.filter((t) => t.taskId !== missing.taskId)));
    await screen.findByRole('button', { name: 'AI 分析' });
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析' }));
    await waitFor(() => expect(analyzeBazi).toHaveBeenCalled(), { timeout: 8000 });
  });
});
