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
  it('lists all three model channels at once and never shows secret/limit wording', async () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();
    // 三条通道同屏可见（不再需要先选一条）
    expect(screen.getByLabelText('DeepSeek 访问凭据')).toBeTruthy();
    expect(screen.getByLabelText('Kimi 访问凭据')).toBeTruthy();
    expect(screen.getByLabelText('Qwen3.8-Flash 访问凭据')).toBeTruthy();
    // 「密钥」二字是那行入口的必然用词（用户 2026-09-25：「输入正确的密钥就展开」），
    // 它默认就摆在页面上，所以这里只禁模型/额度那类措辞，不再为「密钥」开例外。
    expect(document.body.textContent).not.toContain('API 密钥');
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

  /* 这一组盯的是用户 2026-09-25 的第三次改口：「我要把本地功能藏起来。但是输入正确的密钥就展开，
     我还可以关起来，随时想还可以再输入打开。但我不要其他的隐藏方式。只要关闭了就默认走 qwen。」
     前几版要么整块藏在连点手势后面（人找不到输密钥的地方），要么整节常驻（人嫌它摆在那儿）。
     现在的折中：**整节默认不出现，但页面上留一行明说的提示 + 一个密钥框**；输对才铺开，
     「关起来」把它收回云端，再要用得再输一次。判据都问具体控件，不拿整节标题当恒真断言。 */
  it('默认只有一行密钥入口：整节不铺开、能接管「AI 分析」的勾选框也不给', () => {
    render(<SettingsPage />);
    expect(screen.getByLabelText('本地系统密钥')).toBeTruthy();
    expect(screen.getByText(/粘贴密钥即可展开这一节/), '不知道口令的人也要找得到入口').toBeTruthy();
    expect(screen.queryByText('本地系统（本机规则引擎）'), '未展开时整节标题不该出现').toBeNull();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /关起来/ })).toBeNull();
  });

  it('点标题没有任何手势效果：藏与开只认密钥这一条路', () => {
    render(<SettingsPage />);
    const heading = screen.getByRole('heading', { name: '设置' });
    for (let i = 0; i < 8; i += 1) fireEvent.click(heading);
    expect(isLocalSystemUnlocked(), '连点不该顺手开通任何东西').toBe(false);
    expect(screen.getByLabelText('本地系统密钥'), '入口仍只是那一行，没被手势展开').toBeTruthy();
    expect(screen.queryByText('本地系统（本机规则引擎）')).toBeNull();
    expect(localStorage.getItem('mingli.local.hidden'), '那个持久化的收起标记已经废掉了').toBe(null);
  });

  it('已开通的设备直接是展开态：开着本地引擎的人看得见状态、也关得掉', async () => {
    unlockLocalSystem(LOCAL_SYSTEM_KEY);
    render(<SettingsPage />);
    expect(screen.getByText('已开通')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /使用本地系统/ })).toBeTruthy();
  });

  it('填 sk- 开头：按云端凭据保存，绝不当解锁码用', async () => {
    render(<SettingsPage />);
    fireEvent.change(qwenInput(), { target: { value: 'sk-qwen-secret' } });
    fireEvent.click(qwenSave());
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy(), { timeout: 3000 });
    // 走的是凭据分支：状态变已配置，但本地系统**不该**被顺手开通
    expect(isLocalSystemUnlocked()).toBe(false);
    expect(screen.queryByText('本地系统（本机规则引擎）'), '存凭据不该顺手展开本地那一节').toBeNull();
    expect(document.body.textContent).not.toContain('sk-qwen-secret');
  });

  it('解锁码只进自己的框：开通本地系统，且不写云端凭据', async () => {
    render(<SettingsPage />);
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
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
    fireEvent.change(localKeyInput(), { target: { value: 'not-the-key' } });
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await waitFor(() => expect(screen.getByText(/密钥不正确/)).toBeTruthy());
    expect(screen.queryByText('本地系统（本机规则引擎）'), '输错了整节仍不铺开').toBeNull();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(isLocalSystemUnlocked()).toBe(false);
    // 失败要留在框里让人改，且不动云端凭据
    expect(localKeyInput().value).toBe('not-the-key');
  });

  it('关起来会连带把本地系统关掉，页面退回只有一行密钥入口', async () => {
    render(<SettingsPage />);
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: /使用本地系统/ }));
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /关起来/ }));
    await waitFor(() => expect(screen.queryByText('本地系统（本机规则引擎）'), '关起来后整节收回').toBeNull());
    expect(screen.getByLabelText('本地系统密钥'), '收回后只剩那一行密钥入口').toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(isLocalSystemEnabled()).toBe(false);
    // 关键：底层开关也关掉了，不留「引擎还在跑、界面关不掉」的残留
    expect(isOfflineMode()).toBe(false);
  });

  it('渲染时不泄漏密钥明文', async () => {
    render(<SettingsPage />);
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    expect(document.body.textContent).not.toContain(LOCAL_SYSTEM_KEY);
  });

  it('关起来就是唯一的收起手段：整节收回，重进也不残留勾选态', async () => {
    render(<SettingsPage />);
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: /使用本地系统/ }));
    await waitFor(() => expect(isLocalSystemEnabled()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /关起来/ }));
    await waitFor(() => expect(screen.queryByText('本地系统（本机规则引擎）'), '关起来后整节收回').toBeNull());
    // 收起之后只剩密钥框：勾选框和「关起来」都不在，也没有「还在跑却没地方关」的底层开关
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
    expect(isOfflineMode(), '关起来必须把底层开关一起关掉').toBe(false);
    cleanup();
    render(<SettingsPage />);
    expect(screen.getByLabelText('本地系统密钥'), '重进设置页仍只有那一行密钥入口').toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ })).toBeNull();
  });

  /* 正例钉子（防止上一条变成恒假）：关起来只清本机标记，同一个码再输一次就该回来。
     没有这条，"撤销后什么都不显示" 的实现也能骗过上面那组判据 —— 因为它连带会把
     「输入即永久失效」这类缺陷一起藏掉。 */
  it('关起来后重新输入密钥还能展开：收起不是把这条路走死', async () => {
    render(<SettingsPage />);
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /关起来/ }));
    await waitFor(() => expect(screen.queryByText('本地系统（本机规则引擎）'), '关起来后整节收回').toBeNull());
    fireEvent.change(localKeyInput(), { target: { value: LOCAL_SYSTEM_KEY } });
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await waitFor(() => expect(screen.getByText('已开通')).toBeTruthy());
    expect(screen.getByRole('checkbox', { name: /使用本地系统/ })).toBeTruthy();
  });

  /* 入口与功能**分家**后的新代价，钉在这里别被哪天当成 bug 改掉：
     那一行密钥入口人人都看得见；但看得见不等于用得上，没输对密钥就没有勾选框、
     `isLocalSystemEnabled()` 也永远为 false。反过来，只要本机存过开通标记（且设备没被
     重置），这块就会一直摆着 —— 这是"常驻"换来的必然结果，不再另设隐藏开关。 */
  it('看得见 ≠ 用得上：一行密钥入口不给没口令的人任何接管 AI 分析的机会', () => {
    render(<SettingsPage />);
    expect(screen.getByLabelText('本地系统密钥'), '入口是公开的').toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /使用本地系统/ }), '但没有密钥就没有开关').toBeNull();
    expect(isLocalSystemEnabled()).toBe(false);
    // 手改本机标记也不能绕过：开通标记是唯一门槛，界面上的勾选框由它派生
    localStorage.setItem('mingli.local.on', '1');
    expect(isLocalSystemEnabled(), '只有 on 标记、没有开通标记时不该接管').toBe(false);
  });

});