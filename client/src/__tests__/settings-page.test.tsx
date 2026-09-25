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

// Qwen 那格只管云端凭据；本地系统走解锁块里**自己的密钥框**（用户否掉了「一个框按内容分流」）。
const qwenInput = () => screen.getByLabelText('Qwen3.8-Flash 访问凭据') as HTMLInputElement;
const localKeyInput = () => screen.getByLabelText('本地系统密钥') as HTMLInputElement;
const qwenSave = () => screen.getAllByRole('button', { name: '保存' })[2];

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
    // Qwen 那格现在按内容分流，故用 sk- 开头的值才走凭据分支（见「填 sk- 开头」用例）
    fireEvent.change(qw, { target: { value: 'sk-qw-secret' } });
    // 两个通道各自保存
    const saveButtons = screen.getAllByRole('button', { name: '保存' });
    fireEvent.click(saveButtons[0]);
    await waitFor(() => expect(screen.getAllByText('已配置').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[2]);
    await waitFor(() => expect(screen.getAllByText('已配置').length).toBe(2));
    // 保存后清空输入，且页面不泄漏凭据内容
    expect(ds.value).toBe('');
    expect(document.body.textContent).not.toContain('ds-secret');
    expect(document.body.textContent).not.toContain('sk-qw-secret');
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
    fireEvent.change(input, { target: { value: 'sk-first-key' } });
    fireEvent.click(qwenSave());
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy(), { timeout: 3000 });
    // 再次输入新凭据 → 覆盖提示
    await waitFor(() => expect(input.value).toBe(''));
    fireEvent.change(input, { target: { value: 'sk-second-key' } });
    fireEvent.click(qwenSave());
    await waitFor(() => expect(screen.getByText('已用新凭据覆盖原有配置')).toBeTruthy(), { timeout: 3000 });
    expect(document.body.textContent).not.toContain('sk-first-key');
    expect(document.body.textContent).not.toContain('sk-second-key');
  });

  it('本地系统的入口默认完全不可见：没走暗门前，页面上没有「本地系统」字样', () => {
    render(<SettingsPage />);
    // 这是「藏入口」的核心断言：密钥框、勾选框、整块说明都不该存在
    expect(screen.queryByLabelText('本地系统密钥')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(document.body.textContent).not.toContain('本地系统');
  });

  it('暗门：在标题上连点 5 下才放出解锁块，只点 4 下不放出', () => {
    render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 4; i += 1) fireEvent.click(heading);
    expect(screen.queryByText('未开通'), '才点 4 下不该现身').toBeNull();
    fireEvent.click(heading);
    expect(screen.getByText('未开通')).toBeTruthy();
    // 走完暗门也仍然锁着：没输密钥，就不该出现能直接接管 AI 分析的勾选框
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
  });

  it('暗门不记忆：重新进设置页又藏回去（除非本机已开通）', () => {
    const first = render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(heading);
    expect(screen.getByText('未开通')).toBeTruthy();
    first.unmount();
    render(<SettingsPage />);
    expect(screen.queryByText('未开通')).toBeNull();
  });

  it('已开通的设备直接显示解锁块：否则开着本地引擎的人既看不到状态也关不掉', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    render(<SettingsPage />);
    expect(screen.getByText('已开通')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /使用本地系统/ })).toBeTruthy();
  });

  it('填 sk- 开头：按云端凭据保存，绝不当解锁码用', async () => {
    render(<SettingsPage />);
    openSecret();
    fireEvent.change(qwenInput(), { target: { value: 'sk-qwen-secret' } });
    fireEvent.click(qwenSave());
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy(), { timeout: 3000 });
    // 走的是凭据分支：状态变已配置，但本地系统**不该**被顺手开通
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(screen.getByText('未开通')).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-qwen-secret');
  });

  it('解锁码只进自己的框：开通本地系统，且不写云端凭据', async () => {
    render(<SettingsPage />);
    openSecret();
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '开通' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    // 关键反向断言：解锁码不是凭据，不该把 Qwen 标成已配置
    expect(screen.getAllByText('未配置').length).toBeGreaterThan(0);
    const box = screen.getByRole('checkbox', { name: /使用本地系统/ }) as HTMLInputElement;
    expect(box.checked, '刚开通时不该自动启用').toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    // 勾选后才真的接管
    fireEvent.click(box);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    expect(isOfflineMode()).toBe(true);
  });

  it('密钥输错：如实报错、不开通、也不出现勾选框', async () => {
    render(<SettingsPage />);
    openSecret();
    fireEvent.change(localKeyInput(), { target: { value: 'not-the-key' } });
    fireEvent.click(screen.getByRole('button', { name: '开通' }));
    await waitFor(() => expect(screen.getByText(/密钥不正确/)).toBeTruthy());
    expect(screen.getByText('未开通')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(isLocalSystemUnlocked()).toBe(false);
    // 失败要留在框里让人改，且不动云端凭据
    expect(localKeyInput().value).toBe('not-the-key');
  });

  it('撤销开通会连带把本地系统关掉，回去只剩未开通状态', async () => {
    render(<SettingsPage />);
    openSecret();
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
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
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '开通' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    expect(document.body.textContent).not.toContain(LOCAL_SYSTEM_KEY);
  });

  it('隐藏按钮：放出来之后再连点 5 下，整块收回、恢复原貌', () => {
    render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(heading);
    expect(screen.getByLabelText('本地系统密钥')).toBeTruthy();
    for (let i = 0; i < 5; i += 1) fireEvent.click(heading);
    expect(screen.queryByLabelText('本地系统密钥'), '第二次连点该把整块收回去').toBeNull();
    expect(document.body.textContent).not.toContain('本地系统');
  });

  it('隐藏是持久的：重进设置页仍藏着，而且再连点 5 下能点回来', () => {
    const first = render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 10; i += 1) fireEvent.click(heading);
    first.unmount();
    render(<SettingsPage />);
    expect(screen.queryByText('未开通'), '藏起来后重进不该自己冒出来').toBeNull();
    const again = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(again);
    expect(screen.getByText('未开通'), '再点一次要能恢复可见').toBeTruthy();
    expect(localStorage.getItem('mingli.local.hidden'), '恢复可见后隐藏标记该清掉').toBe(null);
  });

  it('已开通的设备若被藏起来也不显示解锁块：否则「恢复原貌」形同虚设', () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    const first = render(<SettingsPage />);
    // 默认例外规则：已开通就直接显示（让人看得见状态、关得掉）
    expect(screen.getByLabelText('本地系统')).toBeTruthy();
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(heading);
    first.unmount();
    // unmount 之后必须**重新挂载**再读：testing-library 的 cleanup 只在 afterEach 跑，
    // 少了这一行就是在断言那棵已经拆掉的旧树——它对任何实现都恒真，是个空断言。
    render(<SettingsPage />);
    // 判据要钉在**整块不存在**上。这里曾误用 queryByText('已开通')，结果是个假失败：
    // Qwen 凭据保存成功后的提示里也含「已开通」三个字，跟这块 UI 毫无关系。
    expect(screen.queryByLabelText('本地系统'), '显式藏起来之后，已开通也不该顶开这层').toBeNull();
    expect(document.body.textContent).not.toContain('本地系统');
  });
});