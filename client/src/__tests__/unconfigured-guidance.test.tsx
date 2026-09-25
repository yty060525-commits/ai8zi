import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../App';
import '../features/chart/nonAiCalculator'; // 预载引擎(缓存)，让页面内的按需加载立即命中
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord, BaziTaskResult } from '../types/domain';
import { unlockLocalSystem, lockLocalSystem, resetLocalSystemForTests } from '../data/localSystem';

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: vi.fn() }));

/* 「一条都没配」这句话在界面上有三处出口：整条记录 not_configured、记录列表的 AI 状态、
   以及各范围条目里的「未配置密钥，本项未生成。」。前两处只报状态不给入口，第三处连一句解释都没有
   —— 用户在手机上看到的就是「未配置」三个字，点哪儿都没反应。这里把三处都钉住：
   凡是说「未配置」的地方，旁边必须有一个能打开设置页的按钮。 */

const done = (taskId: string, type: BaziTaskResult['task']['type'], year?: number): [string, BaziTaskResult] => [taskId, {
  task: { taskId, type, year } as BaziTaskResult['task'],
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【健康】早睡早起。' },
}];

const missing = (taskId: string, type: BaziTaskResult['task']['type'], year?: number): [string, BaziTaskResult] => [taskId, {
  task: { taskId, type, year } as BaziTaskResult['task'],
  status: 'not_configured',
  error: 'DeepSeek：未配置凭据；Kimi：未配置凭据；通义：未配置凭据',
}];

const record: BaziRecord = {
  id: 'unconfigured-person', name: '缺密钥测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_configured',
  aiTasks: Object.fromEntries([done('task-01', 'baseline'), missing('task-02', 'annual', 2030)]),
};

const person = [{ id: 'unconfigured-person', name: '缺密钥测试', nameInitial: 'Q', gender: 'male' as const, birthSummary: '甲子年 丙寅月 庚午日' }];

beforeEach(() => {
  initializeMockSession(person, [{ person: person[0], record: structuredClone(record), aiAnalysis: { status: 'failed' } }]);
});
afterEach(() => { cleanup(); resetMockSession(); resetLocalSystemForTests(); try { localStorage.clear(); } catch {} });

async function openDetail() {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '记录' }));
  fireEvent.click(await screen.findByRole('button', { name: '查看缺密钥测试' }));
  await screen.findByRole('heading', { name: '人物详情' });
}

describe('未配置态的每一处都要给出可点的出路', () => {
  it('详情页：提示「AI 尚未可用」并带「去设置」入口，点击真的打开设置页', async () => {
    await openDetail();
    const hint = await screen.findByText(/AI 尚未可用/);
    expect(hint.textContent).toContain('任一服务');
    // 「设置」按钮实际在页面右上角(.settings-entry 用 margin-left:auto 顶到行尾，窄屏同样靠右)。
    // 曾经三处文案都写「左上角」，让人在屏幕左边找一圈 —— 方位词必须跟界面一致。
    expect(hint.textContent, '把用户领向屏幕左边一个不存在的入口').not.toContain('左上角');
    expect(hint.textContent).toContain('右上角');
    // 通道名要跟设置页上印的一样：设置页第三条叫「Qwen3.8-Flash」，写「通义」用户找不到。
    expect(hint.textContent, '指向了设置页上不存在的通道名').not.toContain('通义');
    expect(screen.queryByText(/原因：未配置/), '重复一遍没有信息量的「原因：未配置 AI 服务」').toBeNull();
    const links = await screen.findAllByRole('button', { name: '去设置 ›' });
    expect(screen.queryByText(/未配置凭据；/), '通道原始报错串不该直接摆给用户').toBeNull();
    expect(screen.queryByText(/额度已用完/), '根本没配密钥时不该摆「余额不足」那串原因').toBeNull();
    expect(screen.queryByText('AI 通道（三条可同时配置）')).toBeNull();
    fireEvent.click(links[0]);
    expect(await screen.findByText('AI 通道（三条可同时配置）')).toBeTruthy();
  });

  it('结果列表里某一项未配置时，整条记录即便显示已完成也要给出去设置入口', async () => {
    // 其余任务成功、只有一条被跳过：aiStatus 会被编排器算成 completed，
    // 于是 not_configured 那段引导不出现，用户只剩一串「未配置」条目和满屏问号。
    initializeMockSession(person, [{
      person: person[0],
      record: { ...structuredClone(record), aiStatus: 'completed', aiTasks: Object.fromEntries([done('task-01', 'baseline'), missing('task-02', 'annual', 2030)]) },
      aiAnalysis: { status: 'completed' },
    }]);
    await openDetail();
    expect(await screen.findByText('状态：已完成')).toBeTruthy();
    expect(screen.getByText(/AI 尚未可用/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '去设置 ›' })[0]);
    expect(await screen.findByText('AI 通道（三条可同时配置）')).toBeTruthy();
  });

  it('未配置的那一条展开后也带着同一个入口，不再是一句没有下文的死话', async () => {
    await openDetail();
    await screen.findByRole('heading', { name: '人物详情' });
    const item = await screen.findByText(/^未配置密钥，本项未生成。/);
    expect(item.querySelector('button'), '条目正文里没有出口').toBeTruthy();
    const before = document.querySelectorAll('details.scope-item').length;
    expect(before).toBeGreaterThan(0);
    act(() => { window.dispatchEvent(new Event('mingli:open-settings')); });
    expect(await screen.findByText('AI 通道（三条可同时配置）')).toBeTruthy();
  });
  it('本机已开通本地系统时，引导语不许再教用户去填云端凭据', async () => {
    // 负例钉子：同一个「未配置」状态，没开通本机密钥时仍要说「去填凭据」。
    await openDetail();
    const cloudHint = await screen.findByText(/AI 尚未可用/);
    expect(cloudHint.textContent).toContain('填写访问凭据');
    expect(cloudHint.textContent, '本机根本没开通时不该提第四路').not.toContain('使用本地系统');
    // 正例：开通那把密钥（不勾选）之后，同样的记录、同样的 not_configured 状态，
    // 这句话必须改口指向第四路 —— 否则等于让一个本机早就备好的出路摆着，还催人花钱。
    // 开通码写错就会静默返回 false，那这条用例会在一个根本没开通的状态下通过
    // —— 反向钉子（撤销后退回云端口径）也就跟着假绿。所以先断言「确实开通了」。
    expect(unlockLocalSystem('mingli-local-2026'), '解锁码不对，这条用例的前提没成立').toBe(true);
    cleanup();
    await openDetail();
    const hint = await screen.findByText(/AI 尚未可用/);
    expect(hint.textContent, '本机已备好第四路却仍催人填云端凭据').toContain('使用本地系统');
    expect(hint.textContent).toContain('不需要任何通道凭据');
    expect(hint.textContent).not.toContain('左上角');
    // 反向钉子：撤销开通后引导语要退回云端口径（证明判据读的就是那把密钥，不是恒真）。
    lockLocalSystem();
    cleanup();
    await openDetail();
    const back = await screen.findByText(/AI 尚未可用/);
    expect(back.textContent).not.toContain('使用本地系统');
  });
});
