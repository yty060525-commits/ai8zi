import { invoke } from '@tauri-apps/api/core';

export type AiProvider = 'deepseek' | 'kimi' | 'qwen';
export type ServiceId = 'serviceOne' | 'serviceTwo' | 'serviceThree';
export type CredentialStatus = 'configured' | 'not_configured';
export interface AiProviderStatus {
  selectedProvider: AiProvider;
  deepseek: CredentialStatus;
  kimi: CredentialStatus;
  qwen: CredentialStatus;
}


const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const credKey = (provider: AiProvider) => 'mingli.cred.' + provider;
const isProdBrowser = () => !inTauri() && import.meta.env.MODE !== 'test';
export function getBrowserCredential(provider: AiProvider): string | undefined {
  try { return localStorage.getItem(credKey(provider)) ?? undefined; } catch { return undefined; }
}
export async function saveAiCredential(provider: AiProvider, secret: string): Promise<CredentialStatus> {
  if (isProdBrowser()) { localStorage.setItem(credKey(provider), secret); return 'configured'; }
  return invoke<CredentialStatus>('save_ai_credential', { provider, secret });
}

export async function clearAiCredential(provider: AiProvider): Promise<CredentialStatus> {
  if (isProdBrowser()) { localStorage.removeItem(credKey(provider)); return 'not_configured'; }
  return invoke<CredentialStatus>('clear_ai_credential', { provider });
}

export async function getAiProviderStatus(): Promise<AiProviderStatus> {
  if (isProdBrowser()) {
    return { selectedProvider: (localStorage.getItem('mingli.provider') as AiProvider) ?? 'qwen', deepseek: getBrowserCredential('deepseek') ? 'configured' : 'not_configured', kimi: getBrowserCredential('kimi') ? 'configured' : 'not_configured', qwen: getBrowserCredential('qwen') ? 'configured' : 'not_configured' };
  }
  return invoke<AiProviderStatus>('get_ai_provider_status');
}

export async function setAiProvider(provider: AiProvider): Promise<AiProvider> {
  if (isProdBrowser()) { localStorage.setItem('mingli.provider', provider); return provider; }
  return invoke<AiProvider>('set_ai_provider', { provider });
}

export const serviceProvider = (service: ServiceId): AiProvider => service === 'serviceOne' ? 'deepseek' : service === 'serviceTwo' ? 'kimi' : 'qwen';
export const serviceOf = (provider: AiProvider): ServiceId => provider === 'deepseek' ? 'serviceOne' : provider === 'kimi' ? 'serviceTwo' : 'serviceThree';

export async function getServiceStatus(): Promise<{ selectedService: ServiceId; serviceOne: CredentialStatus; serviceTwo: CredentialStatus; serviceThree: CredentialStatus }> {
  const status = await getAiProviderStatus();
  return { selectedService: serviceOf(status.selectedProvider), serviceOne: status.deepseek, serviceTwo: status.kimi, serviceThree: status.qwen };
}

export async function saveServiceCredential(service: ServiceId, secret: string): Promise<CredentialStatus> {
  return saveAiCredential(serviceProvider(service), secret);
}

export async function clearServiceCredential(service: ServiceId): Promise<CredentialStatus> {
  return clearAiCredential(serviceProvider(service));
}

export async function setSelectedService(service: ServiceId): Promise<ServiceId> {
  await setAiProvider(serviceProvider(service));
  return service;
}

/** 通道显示名（与服务器/桌面端一致）。 */
export const PROVIDER_LABEL: Record<AiProvider, string> = { deepseek: 'DeepSeek', kimi: 'Kimi', qwen: 'Qwen3.8-Flash' };

/** 测试专用：清空本机(浏览器)凭据与通道选择，避免用例之间互相污染。 */
export function resetAiSettingsForTests(): void {
  try {
    localStorage.removeItem('mingli.provider');
    for (const p of ['deepseek', 'kimi', 'qwen'] as AiProvider[]) localStorage.removeItem('mingli.cred.' + p);
  } catch { /* 非浏览器环境忽略 */ }
}

