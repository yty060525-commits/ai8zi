import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { resetAiSettingsForTests } from '../data/aiSettings';
import { invoke } from '@tauri-apps/api/core';
import { vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

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
afterEach(() => { cleanup(); resetAiSettingsForTests(); vi.mocked(invoke).mockImplementation(happyPath); vi.clearAllTimers?.(); });

// 通道名一律中文读法(正式版口径：界面正文不许有拉丁字母，包括服务商自己的英文名)，
// 用例里的定位符跟着界面实物走，别再写 DeepSeek / Kimi / Qwen3.8-Flash。
const SECRET_LABELS = ['通道一深思访问凭据', '通道二克米访问凭据', '通道三千问访问凭据'];

describe('SettingsPage', () => {
  it('lists all three model channels at once and never shows secret/limit wording', async () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();
    // 三条通道同屏可见（不再需要先选一条）
    expect(screen.getByLabelText(SECRET_LABELS[0])).toBeTruthy();
    expect(screen.getByLabelText(SECRET_LABELS[1])).toBeTruthy();
    expect(screen.getByLabelText(SECRET_LABELS[2])).toBeTruthy();
    expect(screen.queryByText(/模型|API|额度|费用|密钥/)).toBeNull();
    // 界面上不留服务商英文名与机器串：曾经「DeepSeek 访问凭据」直接印在标签上、
    // 「版本号 6-caa86bd」「已缓存版本 mingli-17…」「192.168.1.20 冒号 8787」占位符同样漏字。
    const visible = document.body.textContent ?? '';
    expect(visible, '界面正文里仍有拉丁字母：' + (visible.match(/[A-Za-z]+/g) ?? []).join(',')).not.toMatch(/[A-Za-z]/);
    // 「已缓存版本」那一行是异步读 caches.keys() 才填的，jsdom 里没有 SW，此刻仍是「检测中」，
    // 所以机器号是否挪进 title 要在「版本信息」那条用例里单独测(见下)。
  });

  it('版本信息里的机器串挪进 title，正文只留中文读法', async () => {
    render(<SettingsPage />);
    await screen.findByText(/版本信息/);
    const all = document.body.textContent ?? '';
    // 「已缓存版本」这一行不再打印 mingli-<数字>，改说「与本页面同一版缓存 / 另一版缓存」
    expect(all).not.toMatch(/mingli-/);
    // 缓存号仍可从 title 取回核对(测试环境无注入 → BUILD_ID 为 unknown，title 拿到的是回退串)
    const titled = Array.from(document.querySelectorAll('.ai-status[title]'));
    expect(titled.length, '手机装的是哪一版要能核对：原串得留在 title 里').toBeGreaterThan(0);
    expect(titled.some((el) => (el.getAttribute('title') ?? '').includes('缓存号'))).toBe(true);
  });

  it('已登录时账号名读成中文，原始账号仍留在悬浮说明里', async () => {
    // 回归钉子：这一行曾经直接把 session.username 印进正文，英文账号让整页出现拉丁字母；
    // 而「顺手删掉账号名」也会让正文变干净 —— 所以两条都要钉：正文无字母 + 原串可从 title 取回。
    localStorage.setItem('mingli.server.session', JSON.stringify({ token: 't', username: 'zhang_san01', role: 'admin' }));
    render(<SettingsPage />);
    const row = await screen.findByText(/已连接：/);
    expect(row.textContent, '账号读法里仍有拉丁字母：' + row.textContent).not.toMatch(/[A-Za-z0-9]/);
    expect(row.getAttribute('title')).toContain('zhang_san01');
    localStorage.removeItem('mingli.server.session');
  });

  it('saves each channel independently without switching modes', async () => {
    render(<SettingsPage />);
    const ds = screen.getByLabelText(SECRET_LABELS[0]) as HTMLInputElement;
    const qw = screen.getByLabelText(SECRET_LABELS[2]) as HTMLInputElement;
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
    const secret = screen.getByLabelText(SECRET_LABELS[0]) as HTMLInputElement;
    fireEvent.change(secret, { target: { value: 'retryable-secret' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);
    expect(screen.getAllByText('保存中').length).toBeGreaterThan(0);
    rejectSave(new Error('keyring unavailable'));
    await waitFor(() => expect(screen.getAllByText('保存失败').length).toBeGreaterThan(0));
    expect(secret.value).toBe('retryable-secret');
  });

  it('shows which channel is currently in use and lets you switch it', async () => {
    render(<SettingsPage />);
    // 「当前使用」必须跟随配置里选中的通道(mock: deepseek → 通道一)，而不是写死的默认值 ——
    // 曾同步读 render() 后的初始 state(默认 deepseek)蒙对，改成默认 qwen 后就露馅了：
    // 说明该断言根本没验证「跟随配置」。这里等异步加载后再断言配置的那条。
    await waitFor(() => expect(screen.getByText(/当前使用：/).textContent).toContain('通道一'));
    // 它还没填凭据，所以角标是「已选中，未填凭据」而不是「使用中」。
    expect(screen.getByText('已选中，未填凭据')).toBeTruthy();
    // 切换到第三条通道
    const useButtons = screen.getAllByRole('button', { name: '设为使用' });
    fireEvent.click(useButtons[useButtons.length - 1]);
    await waitFor(() => expect(screen.getByText(/当前使用：/).textContent).toContain('通道三'));
  });

  it('一条凭据都没填时，不许同时摆出「使用中」和「已配置零条」两句矛盾的话', async () => {
    // 「使用中」原意是「这条被选中、优先调用」，但用户读成「这条能用、正在跑」。
    // 全空状态下它必须改口说「已选中，未填凭据」，并补一句下一步做什么。
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/当前使用：/).textContent).toContain('已配置零条'));
    expect(screen.queryByText('使用中'), '没填凭据的通道不该顶着「使用中」').toBeNull();
    expect(screen.getByText('已选中，未填凭据')).toBeTruthy();
    expect(screen.getByText(/当前使用：/).textContent).toContain('都还没填凭据');
    // 这段解释性注释早先写在 JSX children 里(// 而非 {/* */})，会被 React 当正文渲染出去；
    // 界面只许有面向用户的话，实现细节不许漏进可见文案。
    expect(document.body.textContent).not.toContain('曾被理解成');
  });

  it('填好凭据后，选中的那条才恢复显示「使用中」', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'get_ai_provider_status'
      ? { selectedProvider: 'deepseek', deepseek: 'configured', kimi: 'not_configured', qwen: 'not_configured' }
      : happyPath(command as string));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/已配置一条/)).toBeTruthy());
    expect(screen.getByText('使用中')).toBeTruthy();
    expect(screen.queryByText('已选中，未填凭据')).toBeNull();
  });

  it('overwrites an existing credential and confirms it', async () => {
    render(<SettingsPage />);
    const input = screen.getByLabelText(SECRET_LABELS[2]) as HTMLInputElement;
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
});