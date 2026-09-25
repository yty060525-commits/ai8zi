import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { isOfflineMode, resetAiSettingsForTests } from '../data/aiSettings';
import { isLocalSystemEnabled, isLocalSystemUnlocked, resetLocalSystemForTests, setLocalSystemEnabled, unlockLocalSystem } from '../data/localSystem';
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

// Qwen 那格只管云端凭据；本地系统连输入框都不摆（展开走地址栏 ?local=<解锁码>，见 localSystem.ts）。
const qwenInput = () => screen.getByLabelText('Qwen3.8-Flash 访问凭据') as HTMLInputElement;
const qwenSave = () => screen.getAllByRole('button', { name: '保存' })[2];

describe('SettingsPage', () => {
  it('lists all three model channels at once and never shows secret/limit wording', async () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();
    // 三条通道同屏可见（不再需要先选一条）
    expect(screen.getByLabelText('DeepSeek 访问凭据')).toBeTruthy();
    expect(screen.getByLabelText('Kimi 访问凭据')).toBeTruthy();
    expect(screen.getByLabelText('Qwen3.8-Flash 访问凭据')).toBeTruthy();
    // 本地系统在界面上已无任何痕迹，所以这些措辞一个字都不该出现（下面另有判据钉住）。
    expect(document.body.textContent).not.toContain('API 密钥');
    expect(screen.queryByText(/模型|API|额度|费用|密钥/)).toBeNull();
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

  /* 这一组盯的是用户 2026-09-25 的第四次改口（定稿）：「我要看不出来的隐藏起来。只有我自己知道
     怎么展开，不要让任何人看得出来有展开方式。」
     前几版留过：连点手势、Qwen 框分流、独立密钥框常驻、密钥框配一行提示 —— 全都算「看得出来」。
     现在界面上**一个字都不许出现**：没有提示句、没有输入框、没有按钮；展开走地址栏
     `?local=<解锁码>`（见 localSystem.ts / main.tsx）。开通之后这一节才摆出来，且必须关得掉。 */
  it('未开通时设置页上找不到任何本地系统的痕迹（连「本地系统」三个字都不该出现）', () => {
    const { container } = render(<SettingsPage />);
    expect(container.textContent).not.toContain('本地系统');
    expect(screen.queryByLabelText('本地系统密钥'), '不该再有密钥框').toBeNull();
    expect(screen.queryByText(/粘贴密钥/)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /展开|关起来/ })).toBeNull();
  });

  it('点标题没有任何手势效果：界面上不存在第二条展开路', () => {
    const { container } = render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 8; i += 1) fireEvent.click(heading);
    expect(isLocalSystemUnlocked(), '连点不该顺手开通任何东西').toBe(false);
    expect(container.textContent).not.toContain('本地系统');
    expect(localStorage.getItem('mingli.local.hidden'), '那个持久化的收起标记已经废掉了').toBe(null);
  });

  it('填 sk- 开头：按云端凭据保存，绝不当解锁码用', async () => {
    const { container } = render(<SettingsPage />);
    fireEvent.change(qwenInput(), { target: { value: 'sk-qwen-secret' } });
    fireEvent.click(qwenSave());
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy(), { timeout: 3000 });
    // 走的是凭据分支：状态变已配置，但本地系统**不该**被顺手开通
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(container.textContent).not.toContain('本地系统');
    expect(document.body.textContent).not.toContain('sk-qwen-secret');
  });

  it('本机已开通的设备才有这一节：勾选框默认不勾，开着引擎的人看得见也关得掉', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    render(<SettingsPage />);
    expect(screen.getByText('已开通')).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: /使用本地系统/ }) as HTMLInputElement;
    expect(box.checked, '刚开通时不该自动启用').toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
    // 勾选后才真的接管
    fireEvent.click(box);
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    expect(isOfflineMode()).toBe(true);
  });

  it('渲染时不泄漏解锁码明文', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    expect(document.body.textContent).not.toContain(LOCAL_SYSTEM_KEY);
  });

  it('关起来＝整节消失并交还云端：不留「引擎还在跑、界面却关不掉」的残留', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    setLocalSystemEnabled(true);
    const { container } = render(<SettingsPage />);
    expect(screen.getByRole('checkbox', { name: /使用本地系统/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /关起来/ }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull());
    expect(container.textContent).not.toContain('本地系统');
    expect(isLocalSystemUnlocked(), '开通标记该清掉').toBe(false);
    // 关键：底层开关也关掉了 —— 「只要关闭了就默认走 qwen」
    expect(isOfflineMode()).toBe(false);
    expect(isLocalSystemEnabled()).toBe(false);
  });

  /* 正例钉子（防止上一条变成恒假）：关起来只清本机标记，同一串地址再走一次就该回来。
     没有这条，「把路走死」的实现也能骗过上面那组判据。 */
  it('关起来后同一串地址还能再展开：收起不是把这条路走死', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /关起来/ }));
    await waitFor(() => expect(isLocalSystemUnlocked()).toBe(false));
    // 第二次展开：这一节又回来了（证明上一条的「消失」不是把路走死）
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    cleanup();
    render(<SettingsPage />);
    expect(screen.getByRole('checkbox', { name: /使用本地系统/ })).toBeTruthy();
  });

  /* 门槛与代价钉在这里：界面上没入口 = 谁都不会误开；代价是没口令的人无从开启（这正是要求）。
     反过来只要本机存过开通标记（设备没重置），这一节就会一直摆着 —— 所以「关起来」必须真的清干净。 */
  it('手改本机标记不能绕过开通门槛：勾选框由开通标记派生', () => {
    localStorage.setItem('mingli.local.on', '1');
    expect(isLocalSystemEnabled(), '只有 on 标记、没有开通标记时不该接管').toBe(false);
    const { container } = render(<SettingsPage />);
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(container.textContent).not.toContain('本地系统');
  });

});