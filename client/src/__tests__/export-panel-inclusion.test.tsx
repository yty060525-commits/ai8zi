/* 导出面板判据：文案承诺「取消某人的勾选则不带入文件」，实测此前**没有任何用例打开过这个面板**
   (records-page.test.tsx 只覆盖了搜索/排序/空态)，所以这条承诺一直是无人验证的状态。

   为什么值得单独钉：面板的包含名单(includedIds)与列表勾选(selectedIds)是两个 state，
   openPanel 用后者重建前者；若哪天有人把按钮计数改回读 selectedIds，
   「取消勾选就不带入」会静默失效 —— 用户少导了人却看不出差别，属于会把数据带错的那类缺陷。 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecordsPage } from '../features/records/RecordsPage';
import { readableName } from '../data/chatEngine';
import { configureBaziRepository, initializeMockSession, memoryBaziRepository, resetMockSession } from '../data/clientRepository';
import { mockPeople, mockPersonDetails } from './fixtures/mockData';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');

/** 打开面板：先渲染并等列表出现，在列表勾满三人，再点「导出勾选」。 */
async function openExportPanel() {
  render(<RecordsPage onOpenPerson={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /查看/ })).toHaveLength(3));
  const boxes = screen.getAllByRole('checkbox', { name: /^选择/ }) as HTMLInputElement[];
  expect(boxes, '夹具前提：列表应有三个人可勾').toHaveLength(3);
  for (const box of boxes) if (!box.checked) fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: /导出勾选/ }));
  await screen.findByRole('dialog', { name: '导出勾选的人物' });
}

/** 面板名单的真实顺序。
 *  ⚠ 名单来自 selectedRecords = records.filter(...)，保留的是**记录读取序**（这里即 mockPeople 声明序），
 *     而不是屏幕上 visibleRecords 的 localeCompare 排序序；第一版按屏幕序猜「李→王→张」取元素，
 *     结果取消的人和断言的人不是同一个，直接红。故钉在 mockPeople 声明序上。 */
function panelOrder(): string[] {
  const order = mockPeople.map((p) => readableName(p.name));
  expect(order, '夹具前提：应有三个人').toHaveLength(3);
  return order;
}

/** RTL 的 getByRole 返回 HTMLElement，读 .disabled / .checked 要收窄类型。 */
const box = (name: RegExp | string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const button = (name: RegExp | string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;

function includeBox(index: number): HTMLInputElement {
  return box('包含' + panelOrder()[index]);
}

describe('导出面板：取消勾选真的不带入文件', () => {
  beforeEach(() => initializeMockSession(mockPeople, mockPersonDetails));
  afterEach(() => { cleanup(); configureBaziRepository(memoryBaziRepository); resetMockSession(); });

  it('逐个取消时按钮人数跟着减；全部取消后三个导出按钮一起禁用', async () => {
    await openExportPanel();

    /* ⚠ 人数走 cnCount(整体读法)：CN_NUMERALS[3]='三'、[2]='二'，
       而列表行的「两人」是另一处措辞 —— 别照着「两人」写断言(实测红过一次)。 */
    const primary = button(/导出数据库文件/);
    expect(primary.textContent, '全选时按钮人数不对').toContain('共三人');

    /* 逐个取消要按姓名取元素：React 重排后 getAllByRole(...)[0] 可能还是同一个人，
       第一版就是这么误勾误退，测出「三人↔二人」来回跳，看起来像产品 bug 其实是夹具错。 */
    fireEvent.click(includeBox(0));
    await waitFor(() => expect(primary.textContent, '取消一人后按钮人数没跟着减').toContain('共二人'));
    expect(primary.disabled, '仍有两人时不该禁用').toBe(false);

    fireEvent.click(includeBox(1));
    await waitFor(() => expect(primary.textContent).toContain('共一人'));

    fireEvent.click(includeBox(2));
    /* 实测行为：全部取消 ⇒ chosenRecords 为空 ⇒ 三个按钮一起禁用，面板仍然开着。
       (第一版断言「面板自己关闭」是凭空猜的实现形态，实测红过一次 —— 这里钉的是读到的真实行为。)
       钉禁用态而不是钉面板存在性：承诺「不带入文件」的可观察保证就是「这时点不动」。 */
    await waitFor(() => expect(primary.disabled, '全部取消后主按钮仍可点击').toBe(true));
    expect(button('导出结构化文本').disabled).toBe(true);
    expect(button('导出备份文件').disabled).toBe(true);
    /* disabled 的按钮收不到 click，doExport 里那句「请先勾选至少一位人物」在界面上永远走不到。
       实测点它没有任何 role=status 提示 —— 这不是缺陷(灰按钮本身就是反馈)，
       但要把「没有额外话术」这个事实钉住：将来若有人去掉 disabled 却忘了话术，这里会红。 */
    fireEvent.click(primary);
    expect(screen.queryAllByRole('status').map((n) => n.textContent), '灰按钮不该被当成可点入口还不给话').toEqual([]);
  });

  it('取消勾选的人确实不进备份文件正文（按真实下载内容判定）', async () => {
    /* 光看按钮文案不够：真正要保证的是 payload 少一个人。
       ⚠ 不能用 blob.text() 取证再断言 —— 那是异步微任务，waitFor 抢在它之前会恒空(实测红过)。
       downloadBlob 同步调 createObjectURL，所以在这里当场解析 Blob 内容即可。 */
    let parsed: { records: Array<{ name: string }> } | undefined;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = ((blob: Blob) => {
      const reader = new FileReader();
      reader.onload = () => { parsed = JSON.parse(String(reader.result)); };
      reader.readAsText(blob);
      return 'blob:stub';
    }) as typeof URL.createObjectURL;
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;

    try {
      await openExportPanel();
      const dropped = panelOrder()[0];
      expect(includeBox(0).checked, '夹具前提：被取消那人本来在名单里').toBe(true);
      fireEvent.click(includeBox(0));
      await waitFor(() => expect(button(/导出数据库文件/).textContent).toContain('共二人'));

      fireEvent.click(button('导出备份文件'));
      /* FileReader.onload 是异步的，等它落进 parsed；同时 doExport 前面有 await。 */
      await waitFor(() => expect(parsed, '没解析到下载内容').toBeTruthy(), { timeout: 4000 });

      const exported = parsed!.records.map((r) => r.name);
      expect(exported.length, '导出人数应与按钮一致(少一人)').toBe(2);
      expect(exported, '被取消勾选的人仍进了文件').not.toContain(dropped);
      /* 正例钉子：剩下两人必须真在里面，否则上面的 not.toContain 在空数组上也成立(永真判据)。 */
      expect(exported).toContain(panelOrder()[1]);
    } finally {
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = realCreate;
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = realRevoke;
    }
  });

  it('工具栏提示的方位词必须与 .records-check 的对齐方式一致', async () => {
    /* 文案与实现不符的一类缺陷(本仓库已第三次)：提示让用户去方框「左上角」点，
       而 .records-check 用的是 justify-content: center —— 复选框在格子中间。
       jsdom 不做布局(getComputedStyle 拿不到项目 CSS，实测全空)，所以这里读 styles.css 原文，
       并把「改成别的对齐方式」也判红，而不是只钉一个字符串。 */
    const css = readFileSync(resolve(repo, 'client', 'src', 'styles.css'), 'utf8');
    /* 判据必须碰渲染出来的那句提示，否则改文案不会让它红(见「断言必须碰被测组件」)。 */
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /查看/ })).toHaveLength(3));
    const rule = /\.records-check\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, '找不到 .records-check 规则，判据前提失效').toBeTruthy();
    const declared = /\bjustify-content\s*:\s*([a-z-]+)/.exec(rule!)?.[1] ?? 'normal';
    expect(['center', 'flex-start'], `.records-check 现在是 ${declared}，与提示语不符`).toContain(declared);

    const hint = screen.getByText(/点小方格/);
    if (declared === 'center') {
      expect(hint.textContent, '复选框居中时提示不应说左上角').not.toContain('左上角');
      expect(hint.textContent).toContain('左侧');
    } else {
      expect(hint.textContent, '复选框靠左时提示不应再说左上角').not.toContain('左上角');
    }
  });
});
