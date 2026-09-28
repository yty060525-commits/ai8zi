import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail, decadeSegment } from '../features/person/PersonDetail';
import { buildBaziTasks, collectFindings } from '../data/baziOrchestrator';
import { hydrateRecord, initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: () => {} }));

/** 用户要的形态(2026-09-28)：今天算，窗口 2026-2035 要被连续两步大运完整盖住 ——
 *  「当前运裁到交出那一年」(丁未 2026-2033) 与「下一运裁到窗口末尾」(戊申 2033-2035) **两段都要**。
 *  只排后一段会让未来十年的前七年没有大运分析；把前一段的终点抬到 +9 又会盖住正文没谈过的年份。
 *  夹具用真实引擎(按起运排定)，出生数据取实测钉住的 1984-02-06 生男 → 首柱丁卯自 1993 起、每步十年。 */

/** 1984-02-06 生男(非 AI 用例里实测钉住的夹具)：大运起点 1993/2003/…，每步十年且首尾相接。 */
function realChart(): BaziRecord {
  return {
    id: 'two-seg', name: '两段钉子', gender: 'male', birthYear: 1984, birthMonth: 2,
    createdAt: new Date().toISOString(),
    yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    aiStatus: 'not_started',
    // 存储里派生数组是瘦身的：hydrate 重算后才拿得到真实大运。
    nonAiResult: { greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } as never,
  } as unknown as BaziRecord;
}

const done = (task: BaziTaskResult['task']): BaziTaskResult =>
  ({ task, status: 'completed', analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation: '【事业】顺遂。' } } as unknown as BaziTaskResult);

describe('未来十年被连续两运盖住(当前运 + 下一运都在④栏)', () => {
  let full: BaziRecord;
  let current: { ganZhi: string; startYear: number; endYear: number };
  let next: { ganZhi: string; startYear: number; endYear: number };

  beforeEach(async () => {
    full = await hydrateRecord(structuredClone(realChart()));
    const list = full.nonAiResult?.greatFortunes ?? [];
    const y = new Date().getFullYear();
    current = list.find((g) => g.startYear <= y && g.endYear >= y)!;
    next = list.find((g) => g.startYear > y)!;
    expect(current, '这盘今年不在任何大运段内，换出生数据才能复现').toBeTruthy();
    expect(next, '这盘没有下一步大运').toBeTruthy();
    // 夹具钉子：两运必须连续(下一运起点 = 本运终点 + 1)，否则「两段拼起来盖住窗口」不成立。
    expect(next.startYear).toBe(current.endYear + 1);
  });

  it('槽位判据：相交的两运都排任务，整段走完的旧运不排', () => {
    const decades = buildBaziTasks(full, new Date()).filter((t) => t.type === 'decade');
    expect(decades.map((t) => t.year)).toEqual(expect.arrayContaining([current.startYear, next.startYear]));
    const finished = (full.nonAiResult?.greatFortunes ?? []).find((g) => g.endYear < new Date().getFullYear());
    if (finished) expect(decades.map((t) => t.year)).not.toContain(finished.startYear);
  });

  it('展示层：当前运显 今年→交接年，下一运显 交接年→窗口末尾', () => {
    const y = new Date().getFullYear();
    expect(decadeSegment({ year: current.startYear, decade: current }, full)).toEqual({ start: y, end: current.endYear });
    expect(decadeSegment({ year: next.startYear, decade: next }, full)).toEqual({ start: next.startYear, end: y + 9 });
  });

  it('全盘总结要点标题与详情页同口径(交集，不是整段)', () => {
    const y = new Date().getFullYear();
    const tasks = buildBaziTasks(full, new Date()).filter((t) => t.type === 'decade');
    const aiTasks: Record<string, BaziTaskResult> = {};
    for (const t of tasks) aiTasks[t.taskId] = done(t);
    const headings = collectFindings(full, aiTasks, tasks).decades.map((d) => d.heading);
    expect(headings).toContain(`${current.ganZhi} 大运段(${y}-${current.endYear})`);
    expect(headings).toContain(`${next.ganZhi} 大运段(${next.startYear}-${y + 9})`);
  });

  it('界面④栏真的摆出这两段(空手而归即视为未渲染)', async () => {
    const tasks = buildBaziTasks(full, new Date());
    const aiTasks: Record<string, BaziTaskResult> = {};
    for (const t of tasks) aiTasks[t.taskId] = done(t);
    const mounted = { ...full, aiTasks, aiStatus: 'completed' } as BaziRecord;
    initializeMockSession(
      [{ id: 'two-seg', name: '两段钉子', nameInitial: 'T', gender: 'male', birthSummary: 'x' }],
      [{ person: { id: 'two-seg', name: '两段钉子', nameInitial: 'T', gender: 'male', birthSummary: 'x' }, record: structuredClone(mounted), aiAnalysis: { status: 'completed' } }],
    );
    render(<PersonDetail personId="two-seg" onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    const y = new Date().getFullYear();
    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text).toContain(`${current.ganZhi} 大运段(${y}-${current.endYear})`);
      expect(text).toContain(`${next.ganZhi} 大运段(${next.startYear}-${y + 9})`);
    });
  });

  /** 终点必须取这一运**自己的 endYear**。曾按「起点+9」抬高：本盘当前运丁卯(2023-2032)的
   *  startYear+9 恰好等于真实终点，所以界面用例杀不掉那个变异 —— 真正暴露它的是「endYear 比
   *  startYear+9 小」的存量短段：抬高后标题会盖住正文根本没分析的年份。这里直接构造这种行钉判据。 */
  it('终点取本运行自己的 endYear，不按「起点+9」编造(存量短段的反向钉子)', () => {
    const y = new Date().getFullYear();
    const shortNext = { ganZhi: '壬子', startYear: y + 3, endYear: y + 4 };   // 旧口径下少排了五年
    const r = { createdAt: new Date().toISOString(), nonAiResult: { greatFortunes: [shortNext] } } as unknown as BaziRecord;
    // 交集应为 y+3..y+4；若把终点抬到 startYear+9(=y+12)，会被窗口截成 y+3..y+9 —— 多出来的六年正文里没有。
    expect(decadeSegment({ year: shortNext.startYear, decade: shortNext }, r)).toEqual({ start: y + 3, end: y + 4 });
  });
});
