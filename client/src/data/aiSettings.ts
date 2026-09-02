import { invoke } from '@tauri-apps/api/core';

export type AiProvider = 'deepseek' | 'kimi';
export type ServiceId = 'serviceOne' | 'serviceTwo';
export type CredentialStatus = 'configured' | 'not_configured';
export interface AiProviderStatus {
  selectedProvider: AiProvider;
  deepseek: CredentialStatus;
  kimi: CredentialStatus;
}

const defaultStatus = (): AiProviderStatus => ({ selectedProvider: 'deepseek', deepseek: 'not_configured', kimi: 'not_configured' });
let memoryStatus = defaultStatus();

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
    return { selectedProvider: (localStorage.getItem('mingli.provider') as AiProvider) ?? 'deepseek', deepseek: getBrowserCredential('deepseek') ? 'configured' : 'not_configured', kimi: getBrowserCredential('kimi') ? 'configured' : 'not_configured' };
  }
  return invoke<AiProviderStatus>('get_ai_provider_status');
}

export async function setAiProvider(provider: AiProvider): Promise<AiProvider> {
  if (isProdBrowser()) { localStorage.setItem('mingli.provider', provider); return provider; }
  return invoke<AiProvider>('set_ai_provider', { provider });
}

const serviceProvider = (service: ServiceId): AiProvider => service === 'serviceOne' ? 'deepseek' : 'kimi';

export async function getServiceStatus(): Promise<{ selectedService: ServiceId; serviceOne: CredentialStatus; serviceTwo: CredentialStatus }> {
  const status = await getAiProviderStatus();
  return { selectedService: status.selectedProvider === 'deepseek' ? 'serviceOne' : 'serviceTwo', serviceOne: status.deepseek, serviceTwo: status.kimi };
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

/** Test-only reset for the browser adapter; never used by the production UI. */
export function resetAiSettingsForTests(): void {
  memoryStatus = defaultStatus();
}