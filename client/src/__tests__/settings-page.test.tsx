import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { resetAiSettingsForTests } from '../data/aiSettings';
import { invoke } from '@tauri-apps/api/core';
import { vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mocked(invoke).mockImplementation(async (command) => command === 'get_ai_provider_status' ? { selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured' } : command === 'save_ai_credential' ? 'configured' : command === 'set_ai_provider' ? 'kimi' : 'not_configured');

afterEach(() => { cleanup(); resetAiSettingsForTests(); });

describe('SettingsPage', () => {
  it('uses neutral service names and clears the secret input after saving', async () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '服务一' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '服务二' })).toBeTruthy();
    expect(screen.queryByText(/DeepSeek|Kimi|模型|API|额度|费用|密钥/)).toBeNull();

    const secret = screen.getByLabelText('访问凭据') as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(secret, { target: { value: 'not-a-real-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已配置'));
    expect(secret.value).toBe('');
    expect(document.body.textContent).not.toContain('not-a-real-secret');
  });

  it('can switch services and clear the selected credential', async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: '服务二' }));
    const secret = screen.getByLabelText('访问凭据');
    fireEvent.change(secret, { target: { value: 'another-not-real-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已配置'));
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('未配置'));
    expect((screen.getByLabelText('访问凭据') as HTMLInputElement).value).toBe('');
  });

  it('shows saving feedback and keeps the credential available when saving fails', async () => {
    let rejectSave!: (error: Error) => void;
    vi.mocked(invoke).mockImplementation((command) => command === 'get_ai_provider_status'
      ? Promise.resolve({ selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured' })
      : command === 'save_ai_credential' ? new Promise((_, reject) => { rejectSave = reject; }) : Promise.resolve('not_configured'));
    render(<SettingsPage />);
    const secret = screen.getByLabelText('访问凭据') as HTMLInputElement;
    fireEvent.change(secret, { target: { value: 'retryable-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('status').textContent).toContain('保存中');
    rejectSave(new Error('keyring unavailable'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('保存失败'));
    expect(secret.value).toBe('retryable-secret');
  });
});
