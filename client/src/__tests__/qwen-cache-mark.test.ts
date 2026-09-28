import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Qwen(阿里云百炼)的显式缓存标签：从 messages 开头到标记位置的前缀会被做成缓存块，
 * 命中按输入价一折、新建那次按 1.25 倍。所以两件事必须钉住：
 * ① 只有 Qwen 带这个字段 —— DeepSeek/Kimi 不认，带上可能被拒；
 * ② 短于最小可缓存前缀(~1024 token)时不打标 —— 那种请求建不起缓存，打标就是白付 1.25 倍。
 * 同时它只包装请求体，不许改动提示词正文(三通道逐字节一致由 prompt-parity.test.ts 把关)。 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../') + '/';
const adapter = readFileSync(root + 'client/src/data/deepseekAdapter.ts', 'utf8').replace(/\r\n/g, '\n');
const serverAi = readFileSync(root + 'server/ai.mjs', 'utf8').replace(/\r\n/g, '\n');

describe('Qwen 显式缓存标签', () => {
  it('浏览器直连与服务器两侧都有这套包装', () => {
    expect(adapter).toContain("cache_control: { type: 'ephemeral' }");
    expect(serverAi).toContain("cache_control: { type: 'ephemeral' }");
  });

  it('只对 qwen 生效，且短内容不打标', () => {
    for (const [label, src] of [['adapter', adapter], ['server', serverAi]] as const) {
      expect(src, label + ' 少了「非 qwen 原样返回」的守卫').toMatch(/id !== 'qwen'/);
      expect(src, label + ' 没有最短前缀门槛，会给小请求白付建缓存费').toMatch(/QWEN_CACHE_MIN_CHARS|MIN_CHARS/);
    }
  });

  it('标签打在最后一条 user 消息上，system 仍在数组开头(前缀才含系统语)', () => {
    const i = adapter.indexOf("{ role: 'system', content: SYSTEM_SCOPE }");
    const j = adapter.indexOf('qwenCacheableContent(channel, content)');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    // 聊天通道同样要打上：多轮追问的前缀正是「同一系统语」。
    expect(adapter).toContain("m.role === 'user' ? { ...m, content: qwenCacheableContent(channel, String(m.content ?? '')) } : m");
  });

  it('不改提示词正文：包装发生在请求体层，正文仍是同一个字符串变量', () => {
    expect(serverAi).toMatch(/withQwenCacheMark\(provider, messages\)/);
    // 若哪天有人把 cache_control 拼进提示词文本里，三通道一致性立刻会红 —— 这里提前挡住另一种走偏：
    expect(serverAi).not.toMatch(/content \+ .*cache_control/);
    expect(adapter).not.toMatch(/content \+ .*cache_control/);
  });
});
