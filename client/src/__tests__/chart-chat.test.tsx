import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartChat, clearChatThread, scrollToChat } from '../features/chart/ChartChat';
import { askChat } from '../data/chatEngine';
import { listBaziRecords } from '../data/clientRepository';

vi.mock('../data/chatEngine', () => ({ askChat: vi.fn() }));
vi.mock('../data/clientRepository', () => ({ listBaziRecords: vi.fn(async () => []) }));
vi.mock('../data/deepseekAdapter', () => ({ cancelAiSession: vi.fn() }));

afterEach(() => { cleanup(); clearChatThread(); vi.mocked(askChat).mockReset(); vi.clearAllMocks(); vi.mocked(listBaziRecords).mockResolvedValue([] as never); });

const flush = async () => { await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }); };

describe('排盘页「问问 AI」', () => {
  it('输入问题发送 → 展示 AI 回答，并把问题/历史传给 askChat', async () => {
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: '以金为日主，喜火土。' } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '我的五行喜用是什么？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByText('正在查库思考…')).toBeTruthy();
    await screen.findByText('以金为日主，喜火土。');
    expect(askChat).toHaveBeenCalledWith(expect.objectContaining({ question: '我的五行喜用是什么？' }));
  });

  it('Enter 键直接发送', async () => {
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: 'ok' } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '今年运势？' } });
    fireEvent.keyDown(screen.getByLabelText('命理问题'), { key: 'Enter' });
    await screen.findByText('ok');
    expect(askChat).toHaveBeenCalledTimes(1);
  });

  it('多命主未指明 → 渲染候选，点选后带 recordId 重问', async () => {
    vi.mocked(askChat)
      .mockResolvedValueOnce({ status: 'need_record', reason: '请告诉我问的是谁', evidence: { options: [{ id: 'a', name: '张三' }, { id: 'b', name: '李四' }] } } as never)
      .mockResolvedValueOnce({ status: 'completed', answer: '张三的答案' } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '事业运如何？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '张三' }));
    await screen.findByText('张三的答案');
    expect(askChat).toHaveBeenLastCalledWith(expect.objectContaining({ recordId: 'a' }));
  });

  it('失败时提示错误文案', async () => {
    vi.mocked(askChat).mockResolvedValue({ status: 'failed', error: '服务器未配置 AI 密钥' } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '财运？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('服务器未配置 AI 密钥')).toBeTruthy();
  });

  it('未配置密钥时给出友好引导(不泄漏通道原始错误串)', async () => {
    vi.mocked(askChat).mockResolvedValue({ status: 'not_configured', error: 'DeepSeek：未配置凭据；Kimi：未配置凭据' } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '财运？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(/尚未配置 AI 密钥/)).toBeTruthy();
    expect(screen.queryByText(/未配置凭据；/)).toBeNull();
  });

  it('未配置密钥时「去设置」按钮广播打开设置事件', async () => {
    vi.mocked(askChat).mockResolvedValue({ status: 'not_configured' } as never);
    const listener = vi.fn();
    window.addEventListener('mingli:open-settings', listener);
    render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '财运？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '去设置 ›' }));
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('mingli:open-settings', listener);
  });

  it('空会话且有已存命主 → 示例提问一键发送', async () => {
    vi.mocked(listBaziRecords).mockResolvedValue([{ id: 'a', name: '张三' }] as never);
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: '身弱喜土金' } as never);
    render(<ChartChat />);
    await flush();
    const chip = await screen.findByRole('button', { name: '张三的喜用五行是什么？' });
    fireEvent.click(chip);
    await screen.findByText('身弱喜土金');
    expect(askChat).toHaveBeenCalledWith(expect.objectContaining({ question: '张三的喜用五行是什么？' }));
    expect(screen.queryByRole('button', { name: '张三的喜用五行是什么？' })).toBeNull(); // 有对话后不再显示示例
  });

  it('回答标注依据的命主与所问时段', async () => {
    vi.mocked(askChat).mockResolvedValue({
      status: 'completed', answer: '2027 年事业有动象。',
      evidence: { recordId: 'a', personName: '张三', plan: { recordId: 'a', personName: '张三', matchedCount: 1, topics: ['事业'], year: 2027 } },
    } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '张三2027年事业？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('依据：张三 · 2027年')).toBeTruthy();
  });

  it('切页导致组件卸载后，对话仍在(会话常驻)', async () => {
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: '身弱喜土金' } as never);
    const first = render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '喜用五行？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('身弱喜土金');
    first.unmount();
    render(<ChartChat />);
    await flush();
    expect(screen.getByText('身弱喜土金')).toBeTruthy();
    expect(screen.getByText('喜用五行？')).toBeTruthy();
    // 追问把上一轮作为历史带上
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '那明年呢？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await flush();
    expect(vi.mocked(askChat).mock.lastCall?.[0]).toHaveProperty('history');
    expect((vi.mocked(askChat).mock.lastCall?.[0] as { history: unknown[] }).history).toHaveLength(2);
  });

  it('未配置密钥的提示与「去设置」入口在切页后仍在', async () => {
    vi.mocked(askChat).mockResolvedValue({ status: 'not_configured' } as never);
    const first = render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '财运？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '去设置 ›' });
    first.unmount();
    render(<ChartChat />);
    await flush();
    expect(screen.getByText(/尚未配置 AI 密钥/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '去设置 ›' })).toBeTruthy();
  });

  it('「清空对话」重新开始', async () => {
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: 'ok' } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '财运？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('ok');
    fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
    expect(screen.queryByText('ok')).toBeNull();
    expect(screen.getByLabelText('命理问题')).toBeTruthy();
  });
});

describe('切换命主(点名字)', () => {
  const twoPeople = [{ id: 'a', name: '张三' }, { id: 'b', name: '李四' }];

  it('选定命主后名字变成可点击的切换入口，列表收起', async () => {
    vi.mocked(listBaziRecords).mockResolvedValue(twoPeople as never);
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: '答' } as never);
    render(<ChartChat />);
    await flush();
    // 未指定时列表就开着，点张三设为主命主
    fireEvent.click(await screen.findByRole('button', { name: '张三' }));
    await flush();

    // 已选命主：名字变成可点击的切换入口，列表收起
    const switcher = screen.getByRole('button', { name: '切换当前命主' });
    expect(switcher.textContent).toBe('张三');
    expect(screen.queryByLabelText('已存命主')).toBeNull();
  });

  it('点「当前命主」的名字 → 展开列表，可改选另一人', async () => {
    vi.mocked(listBaziRecords).mockResolvedValue(twoPeople as never);
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: '答' } as never);
    render(<ChartChat />);
    await flush();

    // 未指定命主时列表本来就开着，先点张三
    fireEvent.click(await screen.findByRole('button', { name: '张三' }));
    await flush();
    expect(screen.queryByLabelText('已存命主')).toBeNull();

    // 点名字重新展开 → 改选李四
    fireEvent.click(screen.getByRole('button', { name: '切换当前命主' }));
    expect(screen.getByLabelText('已存命主')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '李四' }));
    await flush();
    expect(screen.queryByLabelText('已存命主')).toBeNull();
    expect(screen.getByRole('button', { name: '切换当前命主' }).textContent).toBe('李四');
  });

  it('改选后提问带的是新命主的 recordId', async () => {
    vi.mocked(listBaziRecords).mockResolvedValue(twoPeople as never);
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: '答' } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.click(await screen.findByRole('button', { name: '张三' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '切换当前命主' }));
    fireEvent.click(screen.getByRole('button', { name: '李四' }));
    await flush();

    fireEvent.change(screen.getByLabelText('命理问题'), { target: { value: '财运？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await flush();
    expect(vi.mocked(askChat).mock.lastCall?.[0]).toEqual(expect.objectContaining({ recordId: 'b' }));
  });

  it('「取消指定」回到未选状态，列表重新展开', async () => {
    vi.mocked(listBaziRecords).mockResolvedValue(twoPeople as never);
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: '答' } as never);
    render(<ChartChat />);
    await flush();
    fireEvent.click(await screen.findByRole('button', { name: '张三' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '切换当前命主' }));
    fireEvent.click(screen.getByRole('button', { name: '取消指定' }));
    await flush();

    expect(screen.queryByRole('button', { name: '切换当前命主' })).toBeNull();
    expect(screen.getByLabelText('已存命主')).toBeTruthy();
  });

  it('只有一个命主时不展示切换列表', async () => {
    vi.mocked(listBaziRecords).mockResolvedValue([{ id: 'a', name: '张三' }] as never);
    vi.mocked(askChat).mockResolvedValue({ status: 'completed', answer: '答' } as never);
    render(<ChartChat />);
    await flush();
    expect(screen.queryByLabelText('已存命主')).toBeNull();
  });
});

describe('排盘页顶部「问问 AI」锚点', () => {
  it('点击后把聊天区滚进视野，并把焦点落到输入框', async () => {
    const scrollIntoView = vi.fn();
    const scrollIntoViewInput = vi.fn();
    // jsdom 不实现滚动与焦点滚动控制，这里只验证「调用了正确的方法与目标」。
    Element.prototype.scrollIntoView = scrollIntoView;
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focus(options?: FocusOptions) { (this as HTMLElement & { __opts?: FocusOptions }).__opts = options; return original.call(this); };

    render(<ChartChat />);
    await flush();
    const input = screen.getByLabelText('命理问题') as HTMLInputElement & { __opts?: FocusOptions };
    input.scrollIntoView = scrollIntoViewInput;

    scrollToChat();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(document.querySelector('.chat-panel'));
    // 必须是 auto：smooth 依赖动画帧，被降频/后台时整段丢失，点了没反应。
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ behavior: 'auto', block: 'start' });
    expect(document.activeElement).toBe(input);
    // 滚动由 scrollIntoView 负责，聚焦时不能再让浏览器自己滚一遍，否则会跳走。
    expect(input.__opts).toEqual({ preventScroll: true });

    HTMLElement.prototype.focus = original;
  });

  it('聊天区不在页面上时不报错(直接调用也不抛)', () => {
    render(<div />);
    expect(() => scrollToChat()).not.toThrow();
  });
});
