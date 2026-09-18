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

afterEach(() => { cleanup(); resetAiSettingsForTests(); });

describe('SettingsPage', () => {
  it('lists all three model channels at once and never shows secret/limit wording', async () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();
    // 三条通道同屏可见（不再需要先选一条）
    expect(screen.getByLabelText('DeepSeek 访问凭据')).toBeTruthy();
    expect(screen.getByLabelText('Kimi 访问凭据')).toBeTruthy();
    expect(screen.getByLabelText('Qwen3.8-Flash 访问凭据')).toBeTruthy();
    expect(screen.queryByText(/模型|API|额度|费用|密钥/)).toBeNull();
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
});
