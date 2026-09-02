import { describe, expect, it } from 'vitest';
import config from '../../src-tauri/tauri.conf.json';

describe('Tauri desktop configuration', () => {
  it('uses the Vite dev server and packaged frontend', () => {
    expect(config.build.beforeDevCommand).toBe('npm run dev -- --host 127.0.0.1');
    expect(config.build.devUrl).toBe('http://127.0.0.1:5173');
    expect(config.build.frontendDist).toBe('../dist');
  });

  it('defines a usable titled desktop window without capabilities', () => {
    expect(config.app.windows).toEqual([
      expect.objectContaining({
        title: '命理客户端',
        width: 960,
        height: 720,
        minWidth: 720,
        minHeight: 560,
      }),
    ]);
    expect(config.app.security).toEqual(expect.objectContaining({ csp: null }));
    expect(config.app).not.toHaveProperty('capabilities');
  });
});
