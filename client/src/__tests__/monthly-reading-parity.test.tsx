import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildBaziTasks, collectFindings, orchestrateBaziAnalysis } from '../data/baziOrchestrator';
import { cnCount } from '../shared/chineseReadAloud';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

/* 同一屏的流月读法必须一致：详情页任务卡用 cnCount(整体读法，「十月」)，
   编排器进度条/要点标题此前自己抄了一套逐位补零读法(「一零月」)，
   聊天「依据」行又拿年份读法去读月份(同样读出「一零月」)。
   今天(2026-10)正是分歧月——用户现在跑批断/问流月就会同屏看到两种念法。
   判据不写死月份：从窗口取当月，凡 ≥10 的月自动验证；并钉等式断言。 */

// ChartChat 用例：把 askChat 换成可控桩，其余走真实模块图(与被测渲染路径一致)
vi.mock('../data/chatEngine', async (importOriginal) => ({ ...(await importOriginal<typeof import('../data/chatEngine')>()), askChat: vi.fn() }));
vi.mock('../data/clientRepository', () => ({ listBaziRecords: vi.fn(async () => []), hydrateRecord: vi.fn(async (r) => r) }));
vi.mock('../data/deepseekAdapter', () => ({ cancelAiSession: vi.fn() }));

const record: BaziRecord = {
  id: 'parity', name: '读法一致', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-03-08T12:34:56.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'not_started',
};

/** 详情页 scopeLabel 的 monthly 分支(PersonDetail.tsx L35)：cnYear(年)+cnCount(月)。 */
const detailLabel = (year: number, month: number): string => {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const cnYear = String(year).split('').map((d) => digits[Number(d)]).join('');
  return `${cnYear}年${cnCount(month)}月`;
};

const okResult = (task: BaziTaskResult['task']): BaziTaskResult => ({
  task, status: 'completed',
  // 不带【】小节：missingOf 直接放行，不触发重试
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '顺遂。' },
});

describe('流月读法同屏一致(编排器 vs 详情页)', () => {
  it('夹具钉子：本月任务存在，且 10-12 月逐位读法与整体读法确实不同(否则本用例测不到东西)', () => {
    const tasks = buildBaziTasks(record);
    const monthly = tasks.filter((t) => t.type === 'monthly' && t.month !== undefined);
    expect(monthly.length).toBeGreaterThan(0);
    const diverging = monthly.filter((t) => {
      const padded = String(t.month).padStart(2, '0').split('').map((d) => ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'][Number(d)]).join('');
      return padded !== cnCount(t.month!);
    });
    // 十二个月里至少含一个 10/11/12 月(窗口从今天起连排 12 个月，必然跨过年底)
    expect(diverging.length).toBeGreaterThan(0);
  });

  it('进度条 label：流月任务念「十月」而不是「一零月」', async () => {
    const labels: string[] = [];
    await orchestrateBaziAnalysis(record, async (task) => okResult(task), (p) => { labels.push(p.label); }, { now: new Date(Date.UTC(2026, 9, 15)) });
    const monthLabels = labels.filter((l) => /月$/.test(l));
    expect(monthLabels.length).toBeGreaterThan(0);
    // 「二零二六年」里合法含「二零」，所以只查「月」前那一段的逐位念法，不扫全年串
    for (const l of monthLabels) expect(l.slice(0, l.indexOf('月'))).not.toMatch(/一零|一一|一二/);
    // 与详情页同式：label 必须等于 cnYear+cnCount 拼出来的那一串
    expect(monthLabels).toContain(detailLabel(2026, 10));
  });

  it('collectFindings 流月标题：与详情页 scopeLabel 逐字相等', () => {
    const tasks = buildBaziTasks(record).filter((t) => t.type === 'monthly');
    const aiTasks: Record<string, BaziTaskResult> = Object.fromEntries(tasks.map((t) => [t.taskId, okResult(t)]));
    const findings = collectFindings(record, aiTasks, tasks, new Date(Date.UTC(2026, 9, 15)));
    expect(findings.monthlies.length).toBe(tasks.length);
    for (const row of findings.monthlies) {
      const task = tasks.find((t) => t.taskId === row.key)!;
      expect(row.heading).toBe(detailLabel(task.year!, task.month!) + (task.monthly?.ganZhi ? '，干支' + task.monthly.ganZhi : ''));
    }
  });

  it('聊天「依据」行：问十月读到「十月」而不是「一零月」', async () => {
    const { askChat } = await import('../data/chatEngine');
    vi.mocked(askChat).mockResolvedValue({
      status: 'completed', answer: '今年十月有动象。',
      evidence: { recordId: 'a', personName: '张三', plan: { recordId: 'a', personName: '张三', matchedCount: 1, topics: [], year: 2026, month: 10 } },
    } as never);
    const { ChartChat, clearChatThread } = await import('../features/chart/ChartChat');
    render(<ChartChat />);
    await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '张三2026年10月事业？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('依据：张三，二零二六年十月')).toBeTruthy();
    clearChatThread();
    cleanup();
  });
});
