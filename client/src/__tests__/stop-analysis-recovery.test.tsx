import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { configureBaziRepository, initializeMockSession, listBaziRecords, memoryBaziRepository, resetMockSession, saveBaziRecord } from '../data/clientRepository';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

/* 「立即停止」按下去之后，这条盘必须还能被用户接着用 —— 这是它唯一的承诺(按钮旁的文案就写着「已完成的任务已保存，可随时再点批断分析继续」)。
   此前全仓只在编排器层测过 abort(orchestration.test.ts 三条 rejects.toThrow(/已停止/))，
   界面这一侧一条都没有 ⇒ 停完之后整页锁死这种缺陷没人看得见。

   ⚠ 取证(jsdom，桩即时 resolve，2026-10-06)：stopAnalysis() 只 setProgress(null)+setHint(...)，
      既不 markBusy(false)，也不把落库的 aiStatus 从 pending 改走；而 requestAnalysis 的第一行是
      `if (busyRef.current) return;` —— 于是主按钮既 disabled、点了又直接返回，清除按钮同样 disabled，
      界面只剩一句「正在停止」。记录里躺着的仍是 pending，列表那行也永远显示「分析中」。 */

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: vi.fn() }));
import { analyzeBazi, cancelAiSession } from '../data/deepseekAdapter';

const ID = 'stop-person';
const record = (aiStatus: BaziRecord['aiStatus'], aiTasks?: Record<string, BaziTaskResult>): BaziRecord => ({
  id: ID, name: '停止盘', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-03-08T12:34:56.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus, toneUsed: 80, aiTasks,
} as unknown as BaziRecord);

const okAnalysis = { pattern: '正格', strength: '', usefulElements: ['木'], avoidElements: [], explanation: '【身强身弱与喜忌】旺\n【健康】可\n【事业】顺\n【财运】平\n【爱情】稳' };
const doneResult = { status: 'completed', analysis: okAnalysis };

beforeEach(() => { localStorage.removeItem('pref.' + ID); localStorage.removeItem('ran.' + ID); });
afterEach(() => {
  cleanup();
  resetMockSession();
  configureBaziRepository(memoryBaziRepository);   // 用例里换过存储桩的必须换回来，否则后面的套件串数据
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch { /* jsdom 可能禁用 storage */ }
});

async function seed(withTasks?: Record<string, BaziTaskResult>) {
  const person = [{ id: ID, name: '停止盘', nameInitial: 'J', gender: 'male' as const, birthSummary: 'x' }];
  initializeMockSession(person, [{ person: person[0], record: structuredClone(record('not_started', withTasks)), aiAnalysis: { status: 'not_started' } }]);
  render(<PersonDetail personId={ID} onBack={vi.fn()} />);
  await screen.findByRole('button', { name: '批断分析' });
}

const settle = async (ms = 1500) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

describe('详情页「立即停止」之后的收尾状态', () => {
  it('停止后请求确实交给通道取消(cancelAiSession)，而不是只 abort 本地控制器', async () => {
    vi.mocked(analyzeBazi).mockImplementation(async () => { await new Promise((r) => setTimeout(r, 200)); return doneResult as never; });
    await seed();
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    await settle(800);
    expect(vi.mocked(cancelAiSession).mock.calls.length, '起跑后不该已经取消').toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '立即停止' }));
    await settle(500);
    expect(vi.mocked(cancelAiSession).mock.calls.length, '点停止必须通知通道侧取消(会话级闸门)').toBeGreaterThanOrEqual(1);
  }, 30000);

  it('停止后界面回到可用态：主按钮不再 disabled、文案不再是「分析中」', async () => {
    vi.mocked(analyzeBazi).mockImplementation(async () => { await new Promise((r) => setTimeout(r, 200)); return doneResult as never; });
    await seed();
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    await settle(800);
    fireEvent.click(screen.getByRole('button', { name: '立即停止' }));
    // 停止句本身要出现(它是用户唯一的回执)。
    expect(await waitText(/正在停止/), '点停止应给出「正在停止」回执').toBe(true);
    const main = await waitForEnabled();
    expect(main.disabled, '停止后主按钮仍禁用 → 这页再也点不动了').toBe(false);
    expect(main.textContent, '停止后按钮文案该回到「批断分析」').toBe('批断分析');
    expect(document.body.textContent ?? '', '停止后状态行不该还挂着「分析中」').not.toContain('状态：分析中');
  }, 30000);

  it('停止后落库的记录不再是 pending：列表不会永远显示「分析中」', async () => {
    vi.mocked(analyzeBazi).mockImplementation(async () => { await new Promise((r) => setTimeout(r, 200)); return doneResult as never; });
    await seed();
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    await settle(800);
    fireEvent.click(screen.getByRole('button', { name: '立即停止' }));
    await settle(1500);
    const saved = (await listBaziRecords()).find((x) => x.id === ID);
    expect(saved?.aiStatus, '停止后仍写 pending ⇒ 记录列表那一行永远「分析中」，且下次进站直接被禁用判据锁住')
      .not.toBe('pending');
  }, 30000);

  it('停止后再点批断分析：接着跑剩余任务，不重复花钱', async () => {
    // 前两条任务成功、其余挂起：这样停止时确有「已完成」的任务落在库里，续跑应当复用它们。
    let n = 0;
    vi.mocked(analyzeBazi).mockImplementation(async (rec, task) => {
      n += 1;
      if (n <= 2) return { task, status: 'completed', analysis: okAnalysis } as never;
      await new Promise<void>(() => {});   // 永不返回：卡在飞行中，等 abort
      return { task, status: 'completed', analysis: okAnalysis } as never;
    });
    await seed();
    fireEvent.click(screen.getByRole('button', { name: '批断分析' }));
    await settle(600);
    fireEvent.click(screen.getByRole('button', { name: '立即停止' }));
    await settle(800);
    const afterStop = vi.mocked(analyzeBazi).mock.calls.length;
    const saved = (await listBaziRecords()).find((x) => x.id === ID);
    const completedCount = Object.values(saved?.aiTasks ?? {}).filter((t) => t.status === 'completed').length;
    expect(completedCount, '前提：停止前确实有已完成任务落库(否则续跑无从复用)').toBeGreaterThan(0);

    const main = await waitForEnabled();
    fireEvent.click(main);
    await settle(1200);
    const newCalls = vi.mocked(analyzeBazi).mock.calls.length - afterStop;
    expect(newCalls, '续跑把已完成的任务又发了一遍 → 白花钱').toBeLessThan(23);
  }, 45000);

  it('存量 pending 盘(上次崩在半路)重开这一页：不能一进来就把按钮锁死', async () => {
    // 这条钉的是读取路径：带着 pending 状态进来的盘(换设备/刷新/崩溃遗留)，界面要有出路。
    const stale = record('pending', { 'task-01': { task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis: okAnalysis } as never });
    await saveBaziRecord(stale);
    configureBaziRepository(memoryBaziRepository);
    const person = [{ id: ID, name: '停止盘', nameInitial: 'J', gender: 'male' as const, birthSummary: 'x' }];
    initializeMockSession(person, [{ person: person[0], record: structuredClone(stale), aiAnalysis: { status: 'not_started' } }]);
    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    const main = await screen.findByRole('button', { name: /批断分析|分析中，请稍候/ }) as HTMLButtonElement;
    // 本机没有任何在途请求(controllerRef 为空)，却按 record.aiStatus==='pending' 把按钮禁掉：
    // 期望是「可以点」—— 真在跑的判定要看有没有在途控制器，而不是只看这一列。
    expect(main.disabled, '只是打开了一页遗留 pending 的盘，本机并没有在跑 ⇒ 不该锁死').toBe(false);
  }, 20000);
});

/** 等 hint 文本出现。 */
async function waitText(re: RegExp, maxMs = 5000): Promise<boolean> {
  for (let t = 0; t <= maxMs; t += 200) {
    if (re.test(document.body.textContent ?? '')) return true;
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  }
  return re.test(document.body.textContent ?? '');
}

/** 等主按钮解禁；超时则把当前读数原样交出去，让断言去红，而不是先抛「找不到」。 */
async function waitForEnabled() {
  let btn = screen.getByRole('button', { name: /批断分析|分析中，请稍候/ }) as HTMLButtonElement;
  for (let t = 0; t < 5000 && btn.disabled; t += 250) {
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    btn = screen.getByRole('button', { name: /批断分析|分析中，请稍候/ }) as HTMLButtonElement;
  }
  return btn;
}
