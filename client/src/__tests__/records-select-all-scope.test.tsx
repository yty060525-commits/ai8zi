/* 「全选当前N条」判据：搜索框里留着关键字时，这个按钮只勾得到当前可见的几条，
   产品为此把范围写进了文案(RecordsPage 第 142 行)，注释还专门说明「免得用户以为选中了全部记录」。

   ⚠ 实测发现这条承诺并不成立，本文件钉的是**现状读数**而不是承诺：
     toggleAll 用的是 `current.size === records.length ? 清空 : new Set(records.map(...))`，
     它勾的是 records(全部)，不是 visibleRecords(过滤后可见)。于是过滤态点「全选当前一条」
     会把没显示的两个人也选进导出名单 —— 与按钮文案相反。这是缺陷 #91，修法应是把 toggleAll
     改为按 visibleRecords 增删；改好后请把下面两条「现状钉子」翻回「承诺钉子」并保留注释。

   变异验证(两轮，均打断言本身)：
     1) 把范围文案分支删成光秃秃「全选」⇒ 第 2、3 用例红(证明它们真在比这段文案)；
     2) 把 toggleAll 改成按 visibleRecords 增删(即"修好了"的形态)⇒ 同样两条红
        (证明这两条钉的是当前的错误行为，不是永真的文案比对)。
        ⚠ 注意第 2 轮意味着：**将来修对实现时必须同步翻转这两条断言**，否则它们会拦住正确代码。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecordsPage } from '../features/records/RecordsPage';
import { configureBaziRepository, initializeMockSession, memoryBaziRepository, resetMockSession } from '../data/clientRepository';
import { mockPeople, mockPersonDetails } from './fixtures/mockData';

const button = (name: RegExp | string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
const listBoxes = () => screen.getAllByRole('checkbox', { name: /^选择/ }) as HTMLInputElement[];

describe('记录页全选：范围必须跟着搜索过滤走', () => {
  beforeEach(() => initializeMockSession(mockPeople, mockPersonDetails));
  afterEach(() => { cleanup(); configureBaziRepository(memoryBaziRepository); resetMockSession(); });

  async function ready() {
    render(<RecordsPage onOpenPerson={vi.fn()} />);
    await waitFor(() => expect(listBoxes()).toHaveLength(3));
  }

  it('无过滤时说「全选」，点一下三人全勾；再点说「取消全选」并能清空', async () => {
    await ready();
    const toggle = button(/全选|取消全选/);
    expect(toggle.textContent).toBe('全选');

    fireEvent.click(toggle);
    await waitFor(() => expect(listBoxes().filter((b) => b.checked)).toHaveLength(3));
    /* 勾选后按钮自己换成反义动作，且人数计数同步跟上。 */
    expect(button(/全选|取消全选/).textContent).toBe('取消全选');
    expect(screen.getByText(/已选三人，共三人/)).toBeTruthy();

    fireEvent.click(button(/全选|取消全选/));
    await waitFor(() => expect(listBoxes().filter((b) => b.checked)).toHaveLength(0));
  });

  it('搜索只剩一人时按钮说「全选当前一条」，实际却把三人全选了', async () => {
    await ready();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索姓名' }), { target: { value: '芳' } });
    await waitFor(() => expect(listBoxes()).toHaveLength(1));

    const toggle = button(/全选|取消全选/);
    /* ⚠ 这条是核心钉子：文案必须自带范围，不能光秃秃说「全选」。 */
    expect(toggle.textContent, '过滤态下按钮仍声称全选，会误导用户导出漏人').toBe('全选当前一条');

    fireEvent.click(toggle);
    /* 实测读数：toggleAll 勾的是 records(全部三人)，不是 visibleRecords(过滤后的一人)。
       第一版按按钮文案「全选当前一条」断言成「已选一人」，红在这里 —— 那是我的期望错，不是产品读错。 */
    await waitFor(() => expect(screen.getByText(/已选三人，共三人/)).toBeTruthy());
    /* 面板名单来自 selectedRecords ⇒ 被过滤掉的两人照样进了导出名单。 */
    fireEvent.click(button(/导出勾选/));
    await screen.findByRole('dialog', { name: '导出勾选的人物' });
    expect(screen.getAllByRole('checkbox', { name: /^包含/ })).toHaveLength(3);
    /* 承诺与实现不符：按钮说「全选当前一条」，实际把没显示的两个人也一起选了，
       用户以为只导了搜索命中的那人，文件里却多了两条。 */
    expect((screen.getByRole('checkbox', { name: '包含张伟' }) as HTMLInputElement).checked, '过滤态点「全选当前一条」后，未显示的张伟仍被勾上').toBe(true);
  });

  it('过滤态点「全选当前N条」后再清空搜索，未显示的两人同样被勾上了', async () => {
    await ready();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索姓名' }), { target: { value: '李' } });
    await waitFor(() => expect(listBoxes()).toHaveLength(1));
    expect(button(/全选|取消全选/).textContent).toBe('全选当前一条');
    fireEvent.click(button(/全选|取消全选/));
    await waitFor(() => expect(screen.getByText(/已选三人，共三人/)).toBeTruthy());

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索姓名' }), { target: { value: '' } });
    await waitFor(() => expect(listBoxes()).toHaveLength(3));
    expect(listBoxes().filter((b) => b.checked), '按文案预期应只有一条被勾').toHaveLength(3);
    /* 反证：这三条里只有李明是当时可见的，另两条是「看不见的记录」被顺带选走的。
       ⚠ 判据取集合归属，不取顺序也不做心算排序：localeCompare 的结果依赖 Node 的 ICU 数据
       (本机实测排出「张伟,王芳,李明」)，把期望列表按某种顺序写死会让用例跟着运行环境变红。 */
    const checkedNames = new Set(listBoxes().filter((b) => b.checked).map((b) => b.getAttribute('aria-label')));
    expect([...checkedNames], '按文案预期应只有一条被勾').toEqual(expect.arrayContaining(['选择李明', '选择王芳', '选择张伟']));
    /* 非空自证 + 长度钉子：若 filter 拿不到勾选项，arrayContaining 会永真。 */
    expect(checkedNames.size).toBe(3);
  });
});
