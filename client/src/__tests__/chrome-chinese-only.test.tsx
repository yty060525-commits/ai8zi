import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { App } from '../App';
import { BUILD_ID } from '../utils/buildInfo';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import { mockPeople, mockPersonDetails } from './fixtures/mockData';
import { analyzeBazi } from '../data/deepseekAdapter';
import { readableName } from '../data/chatEngine';
import '../features/chart/nonAiCalculator'; // 预载引擎(缓存)，让页面内的按需加载立即命中

vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: vi.fn() }));

/* 正式版口径：界面上看得见、或读屏能听到的正文只许汉字与中文句读 —— 拉丁字母、阿拉伯数字、
 * 以及「·」「」」这类特殊符号都不许出现。逐处修字面量只能保证「当下干净」，加一句新文案就可能
 * 再漏一个，所以这里对整棵渲染树做穷举扫描：可见文本 + aria-label + placeholder 三样一起查。
 * title 属性不查：那是给机主核对用的机器标识(构建号/版本号原串)，属于协议层，见 buildInfo 注释。 */
const FORBIDDEN = /[A-Za-z0-9·@#%&*+=~^_|／＼（）()「」“”…—＿]/;

/** 收集节点上「用户看得见或读屏能听到」的文本，并带上出处便于定位。 */
function visibleStrings(container: HTMLElement): Array<{ where: string; text: string }> {
  const found: Array<{ where: string; text: string }> = [];
  const doc = container.ownerDocument;
  const walker = doc.createTreeWalker(container, doc.defaultView!.NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const t = (node.textContent ?? '').trim();
    if (t) found.push({ where: '正文 @' + ((node.parentElement as HTMLElement)?.className || node.parentElement?.tagName || '?'), text: t });
    node = walker.nextNode();
  }
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('[aria-label],[placeholder]'))) {
    for (const attr of ['aria-label', 'placeholder'] as const) {
      const v = el.getAttribute(attr);
      if (v) found.push({ where: attr + ' @' + (el.className || el.tagName), text: v });
    }
  }
  return found;
}

const dirtyOf = (container: HTMLElement) =>
  visibleStrings(container).filter((s) => FORBIDDEN.test(s.text)).map((d) => `${d.where} → ${d.text}`);

describe('界面正文纯中文(整树穷举)', () => {
  beforeEach(() => { initializeMockSession(mockPeople, mockPersonDetails); vi.mocked(analyzeBazi).mockResolvedValue({ status: 'not_configured' }); });
  afterEach(() => { cleanup(); resetMockSession(); });

  it('排盘页：可见正文与无障碍标签都不含拉丁字母、数字或特殊符号', () => {
    const { container } = render(<App />);
    expect(dirtyOf(container)).toEqual([]);
  });

  it('记录页 / 人物详情页：同样穷举', async () => {
    const { container } = render(<App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.bottom-nav .nav-item:nth-child(2)')!);
    // 列表走 listBaziRecords()(内含 await pullAndMergeLocal)，首帧还没拿到数据。
    // 上一版这里写的是 if (first) click —— 条目没渲染出来就整段跳过，详情页等于没扫还全绿。
    const open = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>('button.person-open');
      expect(el, '记录页始终没有人物条目，详情页那一路没被扫到').toBeTruthy();
      return el!;
    });
    expect(dirtyOf(container)).toEqual([]);
    fireEvent.click(open);
    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('人物详情'));
    expect(dirtyOf(container)).toEqual([]);
  });

  it('存量脏姓名：测试期建的拉丁/数字名(如 T_SOL_01)也必须读成中文，不得原样上屏', async () => {
    // 记录页/详情页/聊天建议过去直读 record.name，本机库里若存着带字母数字的旧名就会违反纯中文口径。
    // 这里用真实脏形态重建会话，扫整树 —— readableName 兜底若不生效，判据当场红。
    initializeMockSession(
      [{ id: 'dirty-1', name: 'T_SOL_01', nameInitial: 'T', gender: 'male', birthSummary: '甲子年' } as never],
      [{ person: { id: 'dirty-1', name: 'T_SOL_01' } as never, record: { id: 'dirty-1', name: 'T_SOL_01', gender: 'male', birthYear: 1990, birthMonth: 1, createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', aiStatus: 'not_started' } as never, aiAnalysis: { status: 'not_started' } as never }],
    );
    const { container } = render(<App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.bottom-nav .nav-item:nth-child(2)')!);
    await waitFor(() => expect(container.querySelector('button.person-open')).toBeTruthy());
    expect(dirtyOf(container)).toEqual([]);
    // 反向钉子：确认真渲染了这条盘(而不是列表空导致「没东西可脏」的假绿)，且用的是共享读法。
    const open = container.querySelector<HTMLButtonElement>('button.person-open')!;
    expect(open.getAttribute('aria-label')).toBe('查看' + readableName('T_SOL_01'));
    expect(readableName('T_SOL_01')).not.toBe('T_SOL_01'); // 兜底确实改写了原串
    fireEvent.click(open);
    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('人物详情'));
    expect(dirtyOf(container)).toEqual([]);
  });

  it('设置页：通道名、凭据框标签、版本信息一并扫', () => {
    const { container } = render(<App />);
    // 走 App 真实监听的入口事件(子组件也用它)，而不是按文案找按钮 —— 页面上有
    // 「设置」和「去设置」两个按钮，getByRole(name:'设置') 会因多个命中而抛错。
    fireEvent.click(container.querySelector<HTMLButtonElement>('.settings-entry')!);
    expect(dirtyOf(container)).toEqual([]);
  });

  /* 上面的三条只覆盖「默认落地的那一屏」。弹层、确认态、按需加载的聊天面板都不在初始树里，
     它们的文案同样会上屏，所以逐个驱动到真实可见后再各扫一遍 —— 不驱动就等于没测。 */
  it('排盘弹层(手录四柱)：打开后整棵弹窗扫', () => {
    const { container } = render(<App />);
    // 入口文案是「手录四柱」(切到手录模式)再点「录入四柱八字」才开弹窗；按实际按钮名找，
    // 别按脑子里的「手工填表」找 —— 上一版就是猜了个不存在的词，判据直接空转。
    fireEvent.click([...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '手录四柱')!);
    fireEvent.click([...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '录入四柱八字')!);
    const modal = document.querySelector<HTMLElement>('.modal');
    expect(modal, '点了录入四柱八字弹窗没出来，扫的是空树').toBeTruthy();
    expect(dirtyOf(modal!)).toEqual([]);
  });

  it('人物详情页：删除确认态展开后的提示句一并扫', async () => {
    const { container } = render(<App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.bottom-nav .nav-item:nth-child(2)')!);
    // 记录项的打开按钮类名是 person-open(aria-label 为「查看+姓名」)，不是猜的 record-item。
    const open = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>('button.person-open');
      expect(el, '记录页没有可点开的人物条目，判据前提已失效').toBeTruthy();
      return el!;
    });
    fireEvent.click(open);
    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('人物详情'));
    const del = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '删除数据');
    expect(del, '详情页没有删除入口，判据前提已失效').toBeTruthy();
    fireEvent.click(del!);
    // 确认态与正文同属 app-shell，整树扫才连 danger-hint 那句话一起查到。
    expect(dirtyOf(container)).toEqual([]);
  });

  it('聊天面板：懒加载挂载后把问 AI 的区域扫一遍', async () => {
    // jsdom 没实现 scrollIntoView，而 scrollToChat 点了就调它 —— 不桩一下会以未捕获异常收场，
    // 面板压根挂不上。(chart-chat.test.tsx 是自己临时替换 prototype，这里同理。)
    Element.prototype.scrollIntoView = () => {};
    const { container } = render(<App />);
    fireEvent.click([...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '问问批断')!);
    await waitFor(() => expect(document.querySelector('.chat-panel')).toBeTruthy());
    expect(dirtyOf(document.querySelector<HTMLElement>('.chat-panel')!)).toEqual([]);
  });

  it('反向钉子：判据真的会响，不是恒绿的空壳', () => {
    // 中点、拉丁、数字各塞一个进真实 DOM，必须都被抓到。
    const { container } = render(<div><p id="a">通道一·深思</p><input aria-label="AI 通道" /><p id="b">如 1990</p></div>);
    const dirty = dirtyOf(container);
    expect(dirty.length).toBe(3);
    // 对照：合规写法一条都不该报。
    cleanup();
    const clean = render(<div><p>通道一深思</p><p>二零二六年九月二十二日九时五分</p><input aria-label="姓名" /></div>);
    expect(dirtyOf(clean.container)).toEqual([]);
  });

  it('前提钉子：测试环境的构建号已被 vite 注入成时间戳，正文里的版本行才是纯汉字', () => {
    // 若哪天 define 失效退回 'unknown'，版本行会把拉丁字母带进正文 —— 上面几条会红，
    // 但这条先红并说明原因，免得误以为是谁改了文案。
    expect(/^\d{10,}$/.test(BUILD_ID)).toBe(true);
  });
});
