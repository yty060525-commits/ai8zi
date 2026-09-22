import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 装了 PWA 的手机曾经永远拿不到新版：sw.js 的 CACHE 是写死的 'mingli-v2'，
   而静态资源走「缓存优先」，于是旧缓存永不失效、旧 index.html 一直指向旧 bundle。
   修法是构建时把 __BUILD_ID__ 换成当次时间戳，让 sw.js 逐字节变化。
   这里守住那条链：占位符必须在、构建产物里必须已被替换。 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../') + '/';
const read = (p: string) => readFileSync(root + p, 'utf8').replace(/\r\n/g, '\n');

describe('Service Worker 缓存版本', () => {
  it('public/sw.js 保留 __BUILD_ID__ 占位符(不能被写死成常量)', () => {
    const src = read('client/public/sw.js');
    expect(src).toContain('const CACHE = \'mingli-__BUILD_ID__\';');
    // 写死的版本号会让缓存在发版后依然存活。
    expect(src).not.toMatch(/const CACHE = 'mingli-v\d+'/);
  });

  it('构建配置会把占位符替换掉，且换了就报错', () => {
    const cfg = read('client/vite.config.ts');
    expect(cfg).toContain('__BUILD_ID__');
    expect(cfg).toContain('dist/sw.js');
    // 占位符丢了必须抛错，否则会静默产出永不失效的缓存。
    expect(cfg).toContain('throw new Error');
  });

  it('dist/sw.js 里不得残留未替换的占位符', () => {
    let dist = '';
    try { dist = read('client/dist/sw.js'); } catch { return; } // 未构建时跳过
    expect(dist).not.toContain('__BUILD_ID__');
    expect(dist).toMatch(/const CACHE = 'mingli-\d+';/);
  });
});
