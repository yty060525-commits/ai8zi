import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, resetMockSession, saveBaziRecord, getBaziRecord } from '../data/clientRepository';
import { setServerUrl, setServerSession } from '../data/serverClient';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziRecord } from '../types/domain';

/* 「分析中」这个状态是**会跟着 record 上行服务器**的。本机真在跑时它由组件自己的 busy 兜住；
   可另一台设备只是同步读到这一份 —— 那边根本没在跑，按钮却按 `aiStatus === 'pending'` 禁用，
   旁边那个「立即停止」又只对本机发起的请求有效(controllerRef 为空) ⇒ 点没反应、停也停不了，
   这条盘在那台设备上被永久锁死（手机才是准绳：出门在外用的是第二台设备）。 */

const person = { id: 'p1', name: '异地设备', nameInitial: 'Y', gender: 'male' as const, birthSummary: '甲子年' };

const remotePending = async (): Promise<BaziRecord> => {
  const chart = calculateNonAi({ birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-01-01T00:00:00.000Z');
  const record: BaziRecord = {
    id: 'p1', name: '异地设备', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    aiStatus: 'pending', aiTasks: {}, nonAiResult: chart,
  };
  initializeMockSession([person], [{ person, record, aiAnalysis: { status: 'pending', result: '' } }]);
  return record;
};

afterEach(() => { cleanup(); resetMockSession(); setServerUrl(''); setServerSession(null); });

/* 编排器换成可控桩：开跑后卡在轮内，让组件稳定停在 busy=true 这一帧。
   （照 local-system-design 的做法：静态 import 不能被 doMock 打掉，所以用 hoisted mock 转发。） */
type OrchStub = (rec: BaziRecord, runner?: unknown, onProgress?: unknown, options?: unknown) => Promise<BaziRecord>;
const ORCH_STUB: { holder: { fn?: OrchStub } } = { holder: {} };
let releaseGate: () => void = () => {};
const gate = new Promise<void>((r) => { releaseGate = r; });

vi.mock('../data/baziOrchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/baziOrchestrator')>();
  return { ...actual, orchestrateBaziAnalysis: (...args: unknown[]) => ((ORCH_STUB.holder.fn ?? actual.orchestrateBaziAnalysis) as OrchStub)(...args as [BaziRecord]) };
});

/** 一份「没跑过分析」的干净盘：点 AI 分析必然走到编排器，不会被缓存早退。 */
const seedClean = async (chart: Awaited<ReturnType<typeof calculateNonAi>>) => {
  const record: BaziRecord = {
    id: 'p1', name: '异地设备', gender: 'male', birthYear: 1990, birthMonth: 5,
    createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    aiStatus: 'not_started', aiTasks: {}, nonAiResult: chart,
  };
  initializeMockSession([person], [{ person, record, aiAnalysis: { status: 'not_started', result: '' } }]);
};

describe('同步来的「分析中」不许把这条盘永久锁死', () => {
  it('服务器模式下进详情页：这台设备没在跑，AI 分析就不许是禁用态', async () => {
    setServerUrl('http://127.0.0.1:9');           // 只为进入 isServerMode 分支，不发真实请求
    setServerSession({ token: 'test-token', username: 'tester', role: 'user' });
    await remotePending();
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    const button = (await screen.findByRole('button', { name: /AI 分析|分析中/ }, { timeout: 4000 })) as HTMLButtonElement;
    expect(button.disabled, '本机没在跑却禁用 ⇒ 用户在这台设备上什么都做不了').toBe(false);
  });

  it('点了之后不许静默无反应：要么真的开跑，要么给出可读的说法', async () => {
    await remotePending();
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    const button = await screen.findByRole('button', { name: /AI 分析|分析中/ }, { timeout: 4000 });
    fireEvent.click(button);
    // 判据取"界面有反馈"这个宽口径：开跑(按钮变分析中/进度条出现)或明确提示都算兑现承诺；
    // 只有"什么都没发生"才是要钉死的缺陷。
    await waitFor(() => {
      const b = screen.getByRole('button', { name: /AI 分析|分析中/ }) as HTMLButtonElement;
      const spoke = b.textContent === '分析中…' || !!document.querySelector('[aria-label="AI 分析进度"]') || !!screen.queryByRole('status');
      expect(spoke, '点击后既没开跑也没任何提示 ⇒ 静默失败').toBe(true);
    }, { timeout: 3000 });
  });

  it('本机自己保存一份 pending 之后：这条记录不该被当成异地残留而解锁（防反向过度修正）', async () => {
    await remotePending();
    const before = await getBaziRecord('p1');
    expect(before?.aiStatus, '前提：会话里这份就是 pending').toBe('pending');
    // 同机保存不应改变状态（saveBaziRecord 只在缺 id/aiStatus 时补默认值）。
    const after = await saveBaziRecord(before!);
    expect(after.aiStatus).toBe('pending');
  });

  /* 反向钉子：解锁不能把「本机真在跑」那一半也拆掉 —— 那时必须仍是「分析中…」，
     且「立即停止」要真的摆出来（它的判据也从 aiStatus 一起改成了 busy）。 */
  it('本机真在跑时仍是「分析中…」并给出可用的立即停止', async () => {
    ORCH_STUB.holder.fn = vi.fn(async (rec: BaziRecord, _r?: unknown, onProgress?: (s: { record: BaziRecord }) => Promise<void>) => {
      const running = { ...rec, aiStatus: 'pending' as const };
      await onProgress?.({ record: running });
      await gate;                       // 卡在轮内：此刻组件一定处于 busy
      return { ...running, aiStatus: 'completed' as const };
    }) as unknown as OrchStub;
    const chart = calculateNonAi({ birthYear: 1990, birthMonth: 5, birthDay: 15, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' }, 'male', '2025-01-01T00:00:00.000Z');
    await seedClean(chart);
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'AI 分析' }, { timeout: 4000 }));
    const running = (await screen.findByRole('button', { name: '分析中…' }, { timeout: 4000 })) as HTMLButtonElement;
    expect(running.disabled, '本机在跑时按钮该是禁用态').toBe(true);
    expect(screen.getByText(/进度即时保存/), '本机在跑：仍应讲进度与自动重试').toBeTruthy();
    const stop = screen.getByRole('button', { name: '立即停止' });
    releaseGate();
    await waitFor(async () => expect((await getBaziRecord('p1'))?.aiStatus).toBe('completed'), { timeout: 4000 });
    expect(stop).toBeTruthy();
  });

  it('异地 pending 的说明不许谎称在等：文案指向「直接点 AI 分析」', async () => {
    await remotePending();
    render(<PersonDetail personId="p1" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    expect(screen.getByText(/不是本设备发起的/)).toBeTruthy();
    expect(screen.queryByText(/进度即时保存/), '这台没在跑，不许说进度会即时保存').toBeNull();
    expect(screen.queryByRole('button', { name: '立即停止' }), '没有进行中的请求就不该给停止按钮').toBeNull();
  });
});
