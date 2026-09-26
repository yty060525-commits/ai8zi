import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { deleteBaziRecord, getBaziRecord, initializeMockSession, resetMockSession, saveBaziRecord } from '../data/clientRepository';
import { resetAiSettingsForTests } from '../data/aiSettings';
import { resetLocalSystemForTests } from '../data/localSystem';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { OVERVIEW_TASK_ID } from '../data/baziOrchestrator';
import { getScopeNote, resetScopeNotesForTests, saveScopeNote } from '../data/scopeNotes';
import type { BaziRecord, BaziTaskResult } from '../types/domain';
import '../features/chart/nonAiCalculator'; // 预载引擎(缓存)，让页面内的按需加载立即命中

import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const notConfigured = { selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured', qwen: 'not_configured' };
vi.mocked(invoke).mockImplementation(async (command) => command === 'get_ai_provider_status' ? notConfigured : 'not_configured');

/* 「点评」是挂在每条批断旁边的私房留言：本机存、不上行、不混进正文与复制。
   这一组盯的就是这三条边界 —— 它们一旦破，用户在手机上写的批注会冒到别人设备上，
   或者被「复制全部」当成正文粘进报告里。 */

const person = { id: 'p1', name: '设计测试', nameInitial: 'S', gender: 'male' as const, birthSummary: '甲子年' };

const bodyText = (taskId: string) => `【健康】${taskId} 的正文`;
const task = (taskId: string, type: BaziTaskResult['task']['type'], extra: Partial<BaziTaskResult['task']> = {}): BaziTaskResult => ({
  task: { taskId, type, ...extra },
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: bodyText(taskId) },
});

/** 一条时段齐全、跑过分析的盘：本命 + 全盘总结 + 两个流年 + 一个流月 = 5 个格子。 */
const mk = (): BaziRecord => ({
  id: 'p1', name: '设计测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed',
  aiTasks: {
    'task-01': task('task-01', 'baseline'),
    [OVERVIEW_TASK_ID]: task(OVERVIEW_TASK_ID, 'overview'),
    'task-02': task('task-02', 'annual', { year: 2026 }),
    'task-03': task('task-03', 'annual', { year: 2027 }),
    'task-12': task('task-12', 'monthly', { year: 2026, month: 9 }),
  },
} as unknown as BaziRecord);

const seed = async () => {
  initializeMockSession([person], [{ person, record: mk(), aiAnalysis: { status: 'completed', result: 'x' } }]);
};

const openDetail = async () => {
  render(<PersonDetail personId="p1" onBack={vi.fn()} />);
  await screen.findByRole('heading', { name: '人物详情' });
};

beforeEach(() => { resetAiSettingsForTests(); resetLocalSystemForTests(); resetScopeNotesForTests(); });
afterEach(() => { cleanup(); resetMockSession(); resetAiSettingsForTests(); resetLocalSystemForTests(); resetScopeNotesForTests(); localStorage.clear(); });

describe('详情页逐条「点评」留言', () => {
  it('每一条已完成的批断旁边都有一个点评入口（含全盘总结那一格）', async () => {
    await seed();
    await openDetail();
    // 5 个已完成格子 ⇒ 5 个入口。少挂一处就是那一条内容没法记话（用户要的是"每个旁边"）。
    await waitFor(() => expect(screen.getAllByRole('button', { name: '点评' })).toHaveLength(5));
    expect(screen.queryByText(/我的点评/)).toBeNull();
  });

  it('点开→写→保存后收起，点评显示在那一条下面；重开详情页还在', async () => {
    await seed();
    await openDetail();
    const buttons = await screen.findAllByRole('button', { name: '点评' });
    fireEvent.click(buttons[0]);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: '这句我自己加的批注' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 收起：输入框没了，取而代之是那条例言
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(baseTextHas('这句我自己加的批注')).toBe(true);
    expect(getScopeNote('p1', 'task-01')?.text).toBe('这句我自己加的批注');
    // 换一次挂载（等同用户离开再回来）：必须现读回来
    cleanup();
    await openDetail();
    expect(baseTextHas('这句我自己加的批注')).toBe(true);
  });

  it('取消不该写入；已有点评可以再点进去改', async () => {
    await seed();
    await openDetail();
    fireEvent.click((await screen.findAllByRole('button', { name: '点评' }))[0]);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '随手打的字' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(getScopeNote('p1', 'task-01')).toBeUndefined();
    expect(baseTextHas('随手打的字')).toBe(false);
  });

  it('点评不进 record：保存记录后上行内容里没有它', async () => {
    await seed();
    await openDetail();
    fireEvent.click((await screen.findAllByRole('button', { name: '点评' }))[0]);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '私房话不许同步' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    const stored = await getBaziRecord('p1');
    expect(stored, '前提没成立：读不到这条盘，下面那条否定式断言就是空转').toBeTruthy();
    const before = JSON.stringify(stored);
    const saved = await saveBaziRecord(stored!);
    expect(JSON.stringify(saved).includes('私房话不许同步'), '点评写进了同步对象').toBe(false);
    /* 反向钉子：往**同一个对象**上挂一个真字段，这条判据必须转红。
       否则「上行内容里没有它」可能只是因为保存时压根没带上任何额外键 —— 那是恒真的空断言。 */
    (stored as unknown as Record<string, unknown>).nonAiResult = { ...(stored!.nonAiResult ?? {}), probeNote: '私房话不许同步' };
    const polluted = await saveBaziRecord(stored!);
    expect(JSON.stringify(polluted).includes('私房话不许同步'), '判据失效：这个位置根本装不下东西').toBe(true);
    expect(before.includes('私房话不许同步')).toBe(false);
  });

  it('删掉这条盘的点评一并清掉，别的盘不受影响', async () => {
    await seed();
    saveScopeNote('p1', 'task-01', '要跟着盘一起走');
    saveScopeNote('other', 'task-01', '另一条盘的点评');
    await deleteBaziRecord('p1');
    expect(getScopeNote('p1', 'task-01')).toBeUndefined();
    expect(getScopeNote('other', 'task-01')?.text).toBe('另一条盘的点评');
  });

  it('没解锁本地系统也照样能写点评（它是公开功能，不受第四路闸门约束）', async () => {
    await seed();
    await openDetail();
    fireEvent.click((await screen.findAllByRole('button', { name: '点评' }))[0]);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '陌生人也能写' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(getScopeNote('p1', 'task-01')?.text).toBe('陌生人也能写');
  });
});

/** 页面上摆出来的全部文字。⚠ 别用 `document.body.innerText`：jsdom 没实现它，读回来是 undefined。 */
const baseText = () => document.body.textContent ?? '';
const baseTextHas = (s: string) => baseText().includes(s);
