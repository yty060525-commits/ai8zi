import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartChat, clearChatThread } from '../features/chart/ChartChat';
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
