import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemUnlocked, resetLocalSystemForTests, unlockLocalSystem } from '../data/localSystem';
import { invoke } from '@tauri-apps/api/core';
import { vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

/** 用户手里的解锁码明文，源码里已改成取反表（见 localSystem.ts）。 */
const LOCAL_SYSTEM_KEY = 'mingli-local-2026';

const notConfigured = { selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured', qwen: 'not_configured' };
vi.mocked(invoke).mockImplementation(async (command) => command === 'get_ai_provider_status' ? notConfigured
  : command === 'save_ai_credential' ? 'configured'
  : command === 'set_ai_provider' ? 'deepseek'
  : 'not_configured');

const happyPath = async (command: string) => command === 'get_ai_provider_status' ? notConfigured
  : command === 'save_ai_credential' ? 'configured'
  : command === 'set_ai_provider' ? 'deepseek'
  : 'not_configured';

// 每个用例后恢复默认桩：否则某个用例改过的 invoke 实现会污染后续用例(曾导致覆盖测试误判)
afterEach(() => { cleanup(); resetAiSettingsForTests(); resetLocalSystemForTests(); vi.mocked(invoke).mockImplementation(happyPath); vi.clearAllTimers?.(); });

describe('SettingsPage', () => {
  /** 走一遍暗门：在标题上连点 5 下，让本地系统那块现身。 */
  const openSecret = () => {
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(heading);
  };

  it('lists all three model channels at once and never shows secret/limit wording', async () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();
    // 三条通道同屏可见（不再需要先选一条）
    expect(screen.getByLabelText('DeepSeek 访问凭据')).toBeTruthy();
    expect(screen.getByLabelText('Kimi 访问凭据')).toBeTruthy();
    expect(screen.getByLabelText('Qwen3.8-Flash 访问凭据')).toBeTruthy();
    // 「密钥」二字是本地系统解锁块的必然用词（用户 2026-09-25 指定「输入密钥开通」），
    // 故只放行这一处；其余措辞仍禁止出现在云端三条通道周围。
    // 「密钥」是本地系统解锁块的用词，但那一块默认藏起来了（要走暗门），
    // 所以刚进设置页时它一个字都不该出现；其余措辞也仍禁止出现在云端三条通道周围。
    expect(screen.queryByText(/密钥/)).toBeNull();
    expect(screen.queryByText(/模型|API|额度|费用/)).toBeNull();
  });

  it('注释不许漏到页面上：源码里的 // 写在 JSX 子节点位置会被当文字渲染', async () => {
    // 曾有一段解释「使用中」措辞的 `//` 注释直接放在 JSX 子节点里 —— 那不是注释，
    // 是会被渲染成页面正文的两行中文，用户在设置页顶部能看见。
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/当前使用：/)).toBeTruthy());
    // 用 textContent 不用 innerText：jsdom 不实现 innerText，读到 undefined 会让
    // not.toContain 变成「undefined 不含某串」——恒真的空断言。
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('曾被理解成');
    expect(text).not.toContain('这里说清楚它是被选中的那条');
    // 更一般的一道网：整页不该出现以 // 开头的裸注释文本
    expect(text).not.toMatch(/^\s*\/\//m);
  });

  it('saves each channel independently without switching modes', async () => {
    render(<SettingsPage />);
    const ds = screen.getByLabelText('DeepSeek 访问凭据') as HTMLInputElement;
    const qw = screen.getByLabelText('Qwen3.8-Flash 访问凭据') as HTMLInputElement;
    fireEvent.change(ds, { target: { value: 'ds-secret' } });
    fireEvent.change(qw, { target: { value: 'qw-secret' } });
    // 两个通道各自保存
    const saveButtons = screen.getAllByRole('button', { name: '保存' });
    fireEvent.click(saveButtons[0]);
    await waitFor(() => expect(screen.getAllByText('已配置').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[2]);
    await waitFor(() => expect(screen.getAllByText('已配置').length).toBe(2));
    // 保存后清空输入，且页面不泄漏凭据内容
    expect(ds.value).toBe('');
    expect(document.body.textContent).not.toContain('ds-secret');
    expect(document.body.textContent).not.toContain('qw-secret');
  });

  it('shows saving feedback and keeps the credential available when saving fails', async () => {
    let rejectSave!: (error: Error) => void;
    vi.mocked(invoke).mockImplementation((command) => command === 'get_ai_provider_status'
      ? Promise.resolve(notConfigured)
      : command === 'save_ai_credential' ? new Promise((_, reject) => { rejectSave = reject; }) : Promise.resolve('not_configured'));
    render(<SettingsPage />);
    const secret = screen.getByLabelText('DeepSeek 访问凭据') as HTMLInputElement;
    fireEvent.change(secret, { target: { value: 'retryable-secret' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);
    expect(screen.getAllByText('保存中').length).toBeGreaterThan(0);
    rejectSave(new Error('keyring unavailable'));
    await waitFor(() => expect(screen.getAllByText('保存失败').length).toBeGreaterThan(0));
    expect(secret.value).toBe('retryable-secret');
  });

  it('shows which channel is currently in use and lets you switch it', async () => {
    render(<SettingsPage />);
    // 「当前使用」必须跟随配置里选中的通道(mock: deepseek)，而不是写死的默认值 ——
    // 曾同步读 render() 后的初始 state(默认 deepseek)蒙对，改成默认 qwen 后就露馅了：
    // 说明该断言根本没验证「跟随配置」。这里等异步加载后再断言配置的那条。
    await waitFor(() => expect(screen.getByText(/当前使用：/).textContent).toContain('DeepSeek'));
    // 它还没填凭据，所以角标是「选中·未填凭据」而不是「使用中」。
    expect(screen.getByText('选中·未填凭据')).toBeTruthy();
    // 切换到 Qwen
    const useButtons = screen.getAllByRole('button', { name: '设为使用' });
    fireEvent.click(useButtons[useButtons.length - 1]);
    await waitFor(() => expect(screen.getByText(/当前使用：/).textContent).toContain('Qwen3.8-Flash'));
  });

  it('一条凭据都没填时，不许同时摆出「使用中」和「已配置 0 / 3 条」两句矛盾的话', async () => {
    // 「使用中」原意是「这条被选中、优先调用」，但用户读成「这条能用、正在跑」。
    // 全空状态下它必须改口说「选中·未填凭据」，并补一句下一步做什么。
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/当前使用：/).textContent).toContain('已配置 0 /'));
    expect(screen.queryByText('使用中'), '没填凭据的通道不该顶着「使用中」').toBeNull();
    expect(screen.getByText('选中·未填凭据')).toBeTruthy();
    expect(screen.getByText(/当前使用：/).textContent).toContain('都还没填凭据');
  });

  it('填好凭据后，选中的那条才恢复显示「使用中」', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'get_ai_provider_status'
      ? { selectedProvider: 'deepseek', deepseek: 'configured', kimi: 'not_configured', qwen: 'not_configured' }
      : happyPath(command as string));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/已配置 1 \//)).toBeTruthy());
    expect(screen.getByText('使用中')).toBeTruthy();
    expect(screen.queryByText('选中·未填凭据')).toBeNull();
  });

  it('overwrites an existing credential and confirms it', async () => {
    render(<SettingsPage />);
    const input = screen.getByLabelText('Qwen3.8-Flash 访问凭据') as HTMLInputElement;
    const qwenSave = () => screen.getAllByRole('button', { name: '保存' })[2];
    fireEvent.change(input, { target: { value: 'first-key' } });
    fireEvent.click(qwenSave());
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy(), { timeout: 3000 });
    // 再次输入新凭据 → 覆盖提示
    await waitFor(() => expect(input.value).toBe(''));
    fireEvent.change(input, { target: { value: 'second-key' } });
    fireEvent.click(qwenSave());
    await waitFor(() => expect(screen.getByText('已用新凭据覆盖原有配置')).toBeTruthy(), { timeout: 3000 });
    expect(document.body.textContent).not.toContain('first-key');
    expect(document.body.textContent).not.toContain('second-key');
  });

  it('本地系统的入口默认完全不可见：没走暗门前，页面上没有「本地系统」字样', () => {
    render(<SettingsPage />);
    // 这是「藏入口」的核心断言：不只是勾选框，连密钥输入框和整块说明都不该存在
    expect(screen.queryByLabelText('本地系统密钥')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(document.body.textContent).not.toContain('本地系统');
  });

  it('暗门：在标题上连点 5 下才放出解锁块，只点 4 下不放出', () => {
    render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 4; i += 1) fireEvent.click(heading);
    expect(screen.queryByLabelText('本地系统密钥'), '才点 4 下不该现身').toBeNull();
    fireEvent.click(heading);
    expect(screen.getByLabelText('本地系统密钥')).toBeTruthy();
    expect(screen.getByText('未开通')).toBeTruthy();
    // 走完暗门也仍然锁着：没输密钥，就不该出现能直接接管 AI 分析的勾选框
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
  });

  it('暗门不记忆：重新进设置页又藏回去（除非本机已开通）', () => {
    const first = render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(heading);
    expect(screen.getByLabelText('本地系统密钥')).toBeTruthy();
    first.unmount();
    render(<SettingsPage />);
    expect(screen.queryByLabelText('本地系统密钥')).toBeNull();
  });

  it('已开通的设备直接显示解锁块：否则开着本地引擎的人既看不到状态也关不掉', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    render(<SettingsPage />);
    expect(screen.getByText('已开通')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /使用本地系统/ })).toBeTruthy();
  });

  it('密钥输错：如实报错、不开通、也不出现勾选框', async () => {
    render(<SettingsPage />);
    openSecret();
    const key = screen.getByLabelText('本地系统密钥') as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'not-the-key' } });
    fireEvent.click(screen.getByRole('button', { name: '开通' }));
    await waitFor(() => expect(screen.getByText(/密钥不正确/)).toBeTruthy());
    expect(screen.getByText('未开通')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(isLocalSystemUnlocked()).toBe(false);
  });

  it('密钥正确才开通，开通后出现勾选框且默认不勾（不自动接管）', async () => {
    render(<SettingsPage />);
    openSecret();
    const key = screen.getByLabelText('本地系统密钥') as HTMLInputElement;
    fireEvent.change(key, { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '开通' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    const box = screen.getByRole('checkbox', { name: /使用本地系统/ }) as HTMLInputElement;
    expect(box.checked, '刚开通时不该自动启用').toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    // 勾选后才真的接管
    fireEvent.click(box);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    expect(isOfflineMode()).toBe(true);
  });

  it('撤销开通会连带把本地系统关掉，回去只剩密钥输入框', async () => {
    render(<SettingsPage />);
    openSecret();
    const key = screen.getByLabelText('本地系统密钥') as HTMLInputElement;
    fireEvent.change(key, { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '开通' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: /使用本地系统/ }));
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /撤销开通/ }));
    await waitFor(() => expect(screen.getByText('未开通')).toBeTruthy());
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(isLocalSystemEnabled()).toBe(false);
    // 关键：底层开关也关掉了，不留「引擎还在跑、界面关不掉」的残留
    expect(isOfflineMode()).toBe(false);
  });

  it('渲染时不泄漏密钥明文', async () => {
    render(<SettingsPage />);
    openSecret();
    fireEvent.change(screen.getByLabelText('本地系统密钥'), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '开通' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    expect(document.body.textContent).not.toContain(LOCAL_SYSTEM_KEY);
  });
});