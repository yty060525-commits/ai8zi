/* 详情页复制面板的「全选 / 清空」小按钮：界面上有两对(范围行、维度行)，源码里是四段各自独立的
   setState —— 少写一行不会报错，只会让那一对按钮变成摆设。此前全仓没有任何用例点过它们：
   person-detail-actions.test.tsx:63 与 copy-receipt-count.test.tsx 都只按「第一个/第二个清空」取元素，
   走的是范围那条支路，维度行的「全选」从未被触发。这个文件把四段状态转移全部钉住，
   并顺带钉住按钮上那句实时读数(已选 N 项 / 维度为 M 类)跟着勾选走 —— 它承诺的是
   「点一下就把这一整排恢复默认」，用户看不到内部集合，只能靠这句话确认生效。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

const task = (taskId: string, type: BaziTaskResult['task']['type'], explanation: string): BaziTaskResult => ({
  task: { taskId, type },
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation },
});

const record: BaziRecord = {
  id: 'chip-person', name: '芯片测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed',
  aiTasks: {
    'task-01': task('task-01', 'baseline', '【健康】注意睡眠。\n【爱情】长久相合。'),
    'task-02': task('task-02', 'annual', '【事业】宜守成。\n【财运】稳中进财。'),
  },
};
const person = [{ id: 'chip-person', name: '芯片测试', nameInitial: 'J', gender: 'male', birthSummary: '甲子年' }];

/** 两行各有「全选」「清空」，按 DOM 顺序取：第 0 组是范围行，第 1 组是维度行。
 *  顺序判据先自证(见第一个用例的夹具前提)，之后才敢用它取按钮。 */
const allButton = (row: 0 | 1) => screen.getAllByRole('button', { name: '全选' })[row];
const clearButton = (row: 0 | 1) => screen.getAllByRole('button', { name: '清空' })[row];

/** 范围芯片与维度芯片共用 .filter-chip；按标签文字区分。 */
const DIM_LABELS = ['刑冲破害', '健康', '爱情', '事业', '财运'];
const SCOPE_LABELS = ['本命命局', '未来第一年'];
function chip(label: string): HTMLButtonElement {
  const el = screen.getByRole('button', { name: label }) as HTMLButtonElement;
  expect(el.classList.contains('filter-chip'), `「${label}」不是筛选芯片，取错了元素`).toBe(true);
  return el;
}
const pressed = (el: HTMLButtonElement) => el.getAttribute('aria-pressed');

/** 主按钮上那句实时读数：「复制勾选内容，已选X项，共Y项，维度为Z」。 */
function readout(): string {
  return (screen.getByRole('button', { name: /复制勾选内容/ }) as HTMLButtonElement).textContent ?? '';
}

async function openPage() {
  render(<PersonDetail personId="chip-person" onBack={vi.fn()} />);
  await screen.findByRole('button', { name: /复制勾选内容/ });
}

beforeEach(() => {
  initializeMockSession(person, [{ person: person[0], record: structuredClone(record), aiAnalysis: { status: 'completed', result: 'x' } }]);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); resetMockSession(); });

describe('详情页复制面板：全选/清空要把整排恢复到默认', () => {
  it('夹具前提：两行各有一对全选/清空，且默认全勾、读数说「已选二项／维度为全部」', async () => {
    await openPage();
    expect(screen.getAllByRole('button', { name: '全选' }), '应有范围、维度两对全选').toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '清空' }), '应有范围、维度两对清空').toHaveLength(2);
    for (const label of [...DIM_LABELS, ...SCOPE_LABELS]) {
      expect(pressed(chip(label)), `默认应为已选：${label}`).toBe('true');
    }
    expect(readout()).toContain('已选二项');
    expect(readout()).toContain('维度为全部');
  });

  it('范围行「清空」取消全部范围，「全选」再把它们放回来', async () => {
    await openPage();
    fireEvent.click(clearButton(0));
    for (const label of SCOPE_LABELS) {
      expect(pressed(chip(label)), `清空后范围应未选：${label}`).toBe('false');
    }
    /* 维度那一排不该被牵连：两对按钮共用同名文案，一旦 onClick 接错行，这里就会红。 */
    for (const label of DIM_LABELS) {
      expect(pressed(chip(label)), '范围清空却把维度也退了 ⇒ 两行按钮接错处理器').toBe('true');
    }
    expect(readout(), '清空范围后读数仍报已选二项 ⇒ 计数没跟着集合走').toContain('已选零项');

    fireEvent.click(allButton(0));
    for (const label of SCOPE_LABELS) {
      expect(pressed(chip(label)), `全选没把范围放回：${label}`).toBe('true');
    }
    expect(readout()).toContain('已选二项');
  });

  it('维度行「清空」取消全部维度，「全选」再把它们放回来', async () => {
    await openPage();
    fireEvent.click(clearButton(1));
    for (const label of DIM_LABELS) {
      expect(pressed(chip(label)), `清空后维度应未选：${label}`).toBe('false');
    }
    for (const label of SCOPE_LABELS) {
      expect(pressed(chip(label)), '维度清空却把范围也退了 ⇒ 两行按钮接错处理器').toBe('true');
    }
    /* 实测读数：五类维度全清后，按钮说「维度为零类」。 */
    expect(readout(), '清空维度后读数没报零类').toContain('维度为零类');

    fireEvent.click(allButton(1));
    for (const label of DIM_LABELS) {
      expect(pressed(chip(label)), `全选没把维度放回：${label}`).toBe('true');
    }
    expect(readout()).toContain('维度为全部');
  });

  it('单独退一类维度时，读数报出剩余类数；复制正文只含勾选的那些小节', async () => {
    await openPage();
    fireEvent.click(chip('健康'));
    fireEvent.click(chip('爱情'));
    expect(readout(), '五类里退两类应报三类').toContain('维度为三类');

    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const text = String((navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]);
    expect(text).toContain('事业');
    expect(text).toContain('财运');
    /* ⚠ 这条只钉到「小节级」为止：被退掉的「健康」「爱情」确实不在正文里。 */
    expect(text, '退掉维度却仍带出该小节').not.toContain('注意睡眠');
    expect(text).not.toContain('长久相合');
    /* 反向对照：没退掉的「事业」正文确实在，否则上面两句 not.toContain 会在空文本上永真。 */
    expect(text).toContain('宜守成');
  });
});
