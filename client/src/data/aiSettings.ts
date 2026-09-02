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

export async function saveAiCredential(provider: AiProvider, secret: string): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('save_ai_credential', { provider, secret });
}

export async function clearAiCredential(provider: AiProvider): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('clear_ai_credential', { provider });
}

export async function getAiProviderStatus(): Promise<AiProviderStatus> {
  return invoke<AiProviderStatus>('get_ai_provider_status');
}

export async function setAiProvider(provider: AiProvider): Promise<AiProvider> {
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
