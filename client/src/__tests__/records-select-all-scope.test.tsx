/* 「全选当前N条」判据：搜索框里留着关键字时，这个按钮只勾得到当前可见的几条，
   产品为此把范围写进了文案(RecordsPage)，注释也说明「免得用户以为选中了全部记录」。

   缺陷 #91 已修：toggleAll 与满态判断都改为按 visibleRecords(过滤后可见集)增删。
   修复前的实测读数(留档，别再改回去)：旧实现是
     `current.size === records.length ? 清空 : new Set(records.map(...))`
   勾的是 records(全部)，于是过滤态点「全选当前一条」会把没显示的两个人也选进导出名单，
   且 selectedIds.size 永远等不到 records.length ⇒ 按钮一直停在「全选当前一条」上，
   点第二下才清空。下面第 2、3 用例钉的就是**承诺**：可见的那条被勾上、不可见的两条不勾。

   变异验证(逐条打断言本身，实测记录)：
     M9 把 toggleAll 改回按 records 增删(修复前形态)⇒ 第 2、3 用例红；
     M11 把范围文案分支删成光秃秃「全选」⇒ 第 2、3 用例红；
     M12 整块删掉「满态清空」那条分支 ⇒ 第 1、3 用例红；
     ⚠ M10 只把**标签里的**满态判据改回 selectedIds.size === records.length ⇒ 三条全绿(存活)。
        原因是夹具只有三人：过滤态勾一条后 size=1≠3 ⇒ 仍显示「全选」，与 allVisibleSelected=false
        给出同一个读数。这一处靠 RecordsPage 里两处表达式同源来约束，不补永真断言。 */

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

  it('搜索只剩一人时按钮说「全选当前一条」，点下去只勾那一条', async () => {
    await ready();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索姓名' }), { target: { value: '芳' } });
    await waitFor(() => expect(listBoxes()).toHaveLength(1));

    const toggle = button(/全选|取消全选/);
    /* ⚠ 核心钉子：文案必须自带范围，不能光秃秃说「全选」。 */
    expect(toggle.textContent, '过滤态下按钮仍声称全选，会误导用户导出漏人').toBe('全选当前一条');

    fireEvent.click(toggle);
    /* 承诺读数：只勾可见的那一位。修复前这里是「已选三人，共三人」(实测)，
       即按 records 全量增删把没显示的两人也选了进去。 */
    await waitFor(() => expect(screen.getByText(/已选一人，共三人/)).toBeTruthy());
    /* 面板名单(selectedRecords)只列勾上的人 ⇒ 被过滤掉的两人根本不该出现在确认面板里。
       修复前的实测读数是三条，等于用户以为只导搜索命中的那人、文件里却多两条。 */
    fireEvent.click(button(/导出勾选/));
    await screen.findByRole('dialog', { name: '导出勾选的人物' });
    expect(screen.getAllByRole('checkbox', { name: /^包含/ }), '过滤态全选后面板仍列全部三人').toHaveLength(1);
    expect((screen.getByRole('checkbox', { name: '包含王芳' }) as HTMLInputElement).checked, '可见的那位应被勾上').toBe(true);
    expect(screen.queryByRole('checkbox', { name: '包含张伟' }), '未显示的张伟进了导出名单').toBeNull();
  });

  it('过滤态全选后清空搜索：只有当时可见的那条被勾，且按钮改口「取消全选」', async () => {
    await ready();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索姓名' }), { target: { value: '李' } });
    await waitFor(() => expect(listBoxes()).toHaveLength(1));
    expect(button(/全选|取消全选/).textContent).toBe('全选当前一条');
    fireEvent.click(button(/全选|取消全选/));
    await waitFor(() => expect(screen.getByText(/已选一人，共三人/)).toBeTruthy());

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索姓名' }), { target: { value: '' } });
    await waitFor(() => expect(listBoxes()).toHaveLength(3));
    expect(listBoxes().filter((b) => b.checked), '按文案预期应只有一条被勾').toHaveLength(1);
    /* 反证：勾上的必须是当时可见的李明，另两条是「看不见的记录」，不该被顺带选走。
       ⚠ 判据取集合归属，不取顺序也不做心算排序：localeCompare 的结果依赖 Node 的 ICU 数据
       (本机实测排出「张伟,王芳,李明」)，把期望列表按某种顺序写死会让用例跟着运行环境变红。 */
    const checkedNames = new Set(listBoxes().filter((b) => b.checked).map((b) => b.getAttribute('aria-label')));
    expect([...checkedNames], '勾选集应恰为当时可见的那一条').toEqual(['选择李明']);
    /* 满态按可见集判断：此时只勾了三人里的一条 ⇒ 按钮仍是正向动作，不能提前说「取消全选」。
       (第一版我把这句写成期待「取消全选」，红在实测读到「全选」——那是我的期望错：
        清空搜索后可见集变成三人，而勾选集只有一人，本来就不该是满态。) */
    expect(button(/全选|取消全选/).textContent).toBe('全选');
    /* 再点一次补齐可见集 ⇒ 此刻才是满态，按钮必须换成反义动作，点下去清空。
       修复前这里比的是 selectedIds.size === records.length，过滤态永远等不到「取消全选」。 */
    fireEvent.click(button(/全选|取消全选/));
    await waitFor(() => expect(button(/全选|取消全选/).textContent).toBe('取消全选'));
    fireEvent.click(button(/全选|取消全选/));
    await waitFor(() => expect(listBoxes().filter((b) => b.checked)).toHaveLength(0));
  });
});
