/* 复制回执的人数/项数判据：详情页「复制勾选内容 / 复制全部」会给一句回执，
   回执里的数字必须与**真正进了剪贴板的内容**一致。

   为什么单独钉：此前只有一句 `已复制零项结果`(person-detail-actions.test.tsx 第 65 行)碰到过这个
   字符串，没有任何用例把「回执说几项」和「正文里实际有几项」对上 —— 于是把 selectedCount
   写成 allCompleted.length(即忽略用户取消勾选的范围)这类缺陷可以静默上线：
   用户明明去掉了两条，回执却说全复制了，只能靠肉眼看长文本才发现少了几节。
   同一条承诺在导出面板那边已经钉过(export-panel-inclusion)，这里补的是复制这条通道。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord, BaziTaskResult } from '../types/domain';

const task = (taskId: string, type: BaziTaskResult['task']['type'], explanation: string): BaziTaskResult => ({
  task: { taskId, type },
  status: 'completed',
  analysis: { pattern: '', strength: '', usefulElements: [], avoidElements: [], explanation, title: type === 'annual' ? '鸳鸯戏水' : undefined },
});

/** 四条已完成结果：本命 + 流年 + 大运 + 流月，正文各带一个可数的维度小节。 */
const record: BaziRecord = {
  id: 'count-person', name: '计数测试', gender: 'male', birthYear: 1990, birthMonth: 1,
  createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  aiStatus: 'completed',
  aiTasks: {
    'task-01': task('task-01', 'baseline', '【健康】注意睡眠。\n【爱情】长久相合。'),
    'task-02': task('task-02', 'annual', '【健康】作息规律。\n【事业】宜守成。'),
    'task-03': task('task-03', 'decade', '【财运】稳中进财。\n【健康】留意肠胃。'),
    'task-04': task('task-04', 'monthly', '【爱情】红鸾星动。'),
  },
};

const person = [{ id: 'count-person', name: '计数测试', nameInitial: 'J', gender: 'male', birthSummary: '甲子年' }];

let writeText: ReturnType<typeof vi.fn>;

/** 取最近一次回执(role=status 里那句「已复制…」)。 */
function note(): string {
  const notes = screen.getAllByRole('status').map((n) => n.textContent ?? '');
  return notes.find((t) => t.includes('已复制')) ?? '';
}

beforeEach(() => {
  initializeMockSession(person, [{ person: person[0], record: structuredClone(record), aiAnalysis: { status: 'completed', result: 'x' } }]);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => { cleanup(); resetMockSession(); });

async function openPage() {
  render(<PersonDetail personId="count-person" onBack={vi.fn()} />);
  await screen.findByRole('button', { name: /复制勾选内容/ });
}

describe('复制回执的项数必须等于正文里真的有几项', () => {
  it('默认全选：回执四项，正文确有四个范围', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const text = String(writeText.mock.calls.at(-1)?.[0]);
    /* 夹具前提自证：四个范围各自的小节名都在，否则下面的计数判据是在空文本上永真。 */
    for (const marker of ['健康', '爱情', '事业', '财运']) {
      expect(text, `夹具正文缺少维度 ${marker}`).toContain(marker);
    }
    expect(note(), '回执项数应与实际范围数一致').toContain('已复制四项结果');
  });

  it('取消两个范围后：回执两项，且被取消那两节的正文确实不在剪贴板里', async () => {
    await openPage();
    /* 芯片文案由 describeScope 生成，顺序实测为：本命命局 / 未来大运 / 未来第一年 / 未来第一月。
   判据一律按名字取元素，不按下标 —— 下标依赖展示顺序，改顺序就会把用例变成假红或假绿。 */
    expect(screen.getAllByRole('button', { name: /本命命局|未来大运|未来第一年|未来第一月/ }), '夹具前提：应有四个范围芯片').toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: '本命命局' }));
    fireEvent.click(screen.getByRole('button', { name: '未来大运' }));
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const text = String(writeText.mock.calls.at(-1)?.[0]);
    expect(note(), '取消两个范围后回执仍说四项 ⇒ 计数没跟着勾选走').toContain('已复制二项结果');
    /* 交叉验证：回执说二项，被取消的「本命」整节必须消失。
       ⚠ 只钉范围级独有串(「身强身弱」来自本命节的表头)，不钉「长久相合」——
       它属于【爱情】小节，维度未筛时任何一节的爱情小节都会留下，用它当判据会把正确代码也判红。 */
    expect(text).not.toContain('身强身弱');
  });

  it('缺陷：取消某范围后点「复制全部」，回执说共四项，正文里却没有那一节', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: '本命命局' }));
    fireEvent.click(screen.getByRole('button', { name: '复制全部' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const text = String(writeText.mock.calls.at(-1)?.[0]);
    /* 回执照报「共四项」(读 allCompleted.length，不看勾选)。 */
    expect(note()).toContain('已复制全部，共四项');
    /* 但 copyAll → buildCopyText(null) 里的 `!disabledTasks.has(taskId)` 与传 null 无关，
       被取消勾选的「本命」整节根本没进剪贴板 ⇒ 用户拿到三项内容却被告知四项全在里面。
       夹具前提自证：不取消勾选时这一节确实在正文里(见上一个用例的反向路径)。 */
    expect(text, '现状读数：勾掉的范围被「复制全部」静默漏掉').not.toContain('身强身弱');
    expect(text.split('\n\n\n'), '现状：只剩三个范围分组').toHaveLength(3);
    /* ⚠ 这条钉的是**当前缺陷行为**(缺陷 #92)，不是承诺。修法是给 buildCopyText 加 ignoreDisabled
       参数、copyAll 传 true；修好后请把本用例翻成 toContain('身强身弱')/toHaveLength(4) 并保留说明。 */
  });

  it('维度只留一类时，回执同时报项数与维度类数', async () => {
    await openPage();
    /* 清掉除「健康」以外的维度：先整列清空，再单独把健康放回来。 */
    const dimRow = screen.getAllByRole('button', { name: '清空' });
    fireEvent.click(dimRow[1]);
    fireEvent.click(screen.getByRole('button', { name: '健康' }));
    fireEvent.click(screen.getByRole('button', { name: /复制勾选内容/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const text = String(writeText.mock.calls.at(-1)?.[0]);
    expect(note()).toContain('维度为其中一类');
    expect(text).toContain('健康');
    for (const gone of ['爱情', '事业', '财运']) {
      expect(text, `只勾了健康，正文却仍有${gone}`).not.toContain(gone);
    }
  });
});
