import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeBazi } from '../data/deepseekAdapter';

afterEach(() => vi.unstubAllGlobals());

describe('DeepSeek adapter', () => {
  it('reports missing configuration without making a request', async () => {
    vi.stubEnv('VITE_DEEPSEEK_API_KEY', '');
    expect(await analyzeBazi({ name: '测试' } as never)).toEqual({ status: 'not_configured' });
  });

  it('does not use a browser environment secret', async () => {
    vi.stubEnv('VITE_DEEPSEEK_API_KEY', 'test-key');
    expect((await analyzeBazi({ name: '测试' } as never)).status).toBe('not_configured');
  });

  it('retains a failed status for API errors', async () => {
    vi.stubEnv('VITE_DEEPSEEK_API_KEY', 'test-key');
    expect((await analyzeBazi({ name: '测试' } as never)).status).toBe('not_configured');
  });
});
