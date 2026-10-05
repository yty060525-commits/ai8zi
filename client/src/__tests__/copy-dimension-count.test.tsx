/* 判据空白：「复制勾选内容」的回执说几项，从来没有和**正文里真的有几节**对上过 ——
   在带维度筛选的情形下。

   现有 copy-receipt-count.test.tsx 的四条里，只有「默认全选」那条同时钉了回执与正文，
   而且它的正文恰好不含任何【】小节标记(见下面第二个用例的夹具读数)，所以它测的是
   「整篇都带出」这条最平凡的路；一旦勾了维度，selectedCount 仍按**范围**统计
   (PersonDetail.tsx:437 `allCompleted.filter(item => !disabledTasks.has(...))`)，
   而 buildCopyText 会跳过「本节没有勾选维度的正文」的整个范围(:476 `if (!body.trim()) continue`)。
   两者口径不同 ⇒ 用户去掉一个维度、明明只拿到两节正文，按钮与回执都说「已选三项」。

   这里先按**当前缺陷行为**钉住可读到的数字(缺陷 #95)，并在注释里写清修法与翻转方向。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord, BaziTaskResult, Person } from '../types/domain';

const task = (taskId: string, type: BaziTaskResult['task']['type'], explanation: string): BaziTaskResult => ({
  task: { taskId, type },
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation },
});

/** 三个范围都有已完成结果；其中「流年」这一节只谈财运，勾掉财运它就一句不剩。 */
const record: BaziRecord = {
  id: 'dim-count-person', name: '维度计数', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed',
  aiTasks: {
    'task-01': task('task-01', 'baseline', '【健康】注意睡眠。\n【爱情】长久相合。'),
    'task-02': task('task-02', 'annual', '【财运】稳中进财。'),
    'task-03': task('task-03', 'decade', '【事业】宜守成。\n【健康】留意肠胃。'),
  },
};

const person: Person[] = [{ id: 'dim-count-person', name: '维度计数', nameInitial: 'J', gender: 'male', birthSummary: '甲子年' }];

let writeText: ReturnType<typeof vi.fn>;

/** 主按钮上那句实时读数 + role=status 里的回执，两处都报项数。 */
function readout(): string {
  return (screen.getByRole('button', { name: /复制勾选内容/ }) as HTMLButtonElement).textContent ?? '';
}
function note(): string {
  const notes = screen.getAllByRole('status').map((n) => n.textContent ?? '');
  return notes.find((t) => t.includes('已复制')) ?? '';
}
/** 剪贴板正文里实际有几个「范围分组」(分组之间用三个换行分隔)。 */
function groupCount(text: string): number {
  return text.split('\n\n\n').filter((g) => g.trim()).length;
}

beforeEach(() => {
  initializeMockSession(person, [{ person: person[0], record: structuredClone(record), aiAnalysis: { status: 'completed', result: 'x' } }]);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => { cleanup(); resetMockSession(); });

async function openPage() {
  render(<PersonDetail personId="dim-count-person" onBack={vi.fn()} />);
  await screen.findByRole('button', { name: /复制勾选内容/ });
}

describe('复制项数必须跟着维度筛选走', () => {
  it('夹具前提：默认全选时正文确实有三个范围分组，且「流年」那节只含财运小节', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls.at(-1)?.[0]);
    /* 三条承诺自证：分组数、被筛那节的存在、以及「本命」有两类维度小节。 */
    expect(groupCount(text), '夹具前提：应有三个范围分组').toBe(3);
    for (const marker of ['健康', '爱情', '财运', '事业']) {
      expect(text, `夹具正文缺少维度 ${marker}`).toContain(marker);
    }
    expect(readout()).toContain('已选三项');
  });

  it('取消「财运」后：正文只剩两个范围分组，被筛那节整节消失', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: '财运' }));
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const text = String(writeText.mock.calls.at(-1)?.[0]);
    expect(groupCount(text), '流年那一节没有勾选维度，本不该进剪贴板').toBe(2);
    expect(text).not.toContain('稳中进财');
    /* 保留下来的两节仍在：证明上面那条 not.toContain 不是因为整段正文空了。 */
    expect(text).toContain('注意睡眠');
    expect(text).toContain('宜守成');
  });

  it('缺陷：同一份正文只有两节，按钮读数与回执却都还说「已选三项」', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: '财运' }));
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const text = String(writeText.mock.calls.at(-1)?.[0]);
    /* 当场核对判据两端：正文两节 vs 读数三项。 */
    expect(groupCount(text)).toBe(2);
    expect(readout(), '现状读数：项数只看范围勾选，不看维度').toContain('已选三项');
    expect(note(), '现状读数：回执同样按范围计数').toContain('已复制三项结果');
    expect(note()).toContain('维度为其中四类');
    /* ⚠ 这条钉的是**当前缺陷行为**(缺陷 #95)，不是承诺。修法是让 selectedCount 与
       buildCopyText 同源(把「本节有没有勾选维度的正文」算进项数)；修好后请把上面两行
       翻成 toContain('已选二项')/toContain('已复制二项结果')，并保留这条说明。 */
  });

  it('反向钉子：只按范围取消一节时，项数确实跟着减(证明上面的读数不是恒三项)', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: '未来大运' }));
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const text = String(writeText.mock.calls.at(-1)?.[0]);
    expect(groupCount(text)).toBe(2);
    expect(readout()).toContain('已选二项');
    expect(note()).toContain('已复制二项结果');
  });
});
