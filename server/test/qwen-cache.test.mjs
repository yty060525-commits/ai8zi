import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import './netGuard.mjs'; // 上闸：这条用例本就不该发请求，但一旦有人改成真调用要当场炸
import { withQwenCacheMark, QWEN_CACHE_MIN_CHARS, PROVIDERS } from '../ai.mjs';

/* Qwen 显式缓存标签的行为契约(纯函数，不发请求)：
 * 命中条件是「从 messages 开头到标记位置逐字节相同」，且前缀要够长才建得起缓存；
 * 新建按输入价 1.25 倍计费 —— 所以「不该打的时候别打」和「该打的时候打上」同等重要。 */
const providerOf = (id) => PROVIDERS.find((p) => p.id === id);
const longText = '命'.repeat(QWEN_CACHE_MIN_CHARS + 10);

describe('withQwenCacheMark', () => {
  test('qwen + 够长的 user 正文 → 打成 ephemeral 数组段，system 原样在前', () => {
    const msgs = [{ role: 'system', content: '系统语' }, { role: 'user', content: longText }];
    const out = withQwenCacheMark(providerOf('qwen'), msgs);
    assert.equal(out[0].content, '系统语');
    assert.ok(Array.isArray(out[1].content));
    assert.equal(out[1].content[0].type, 'text');
    assert.equal(out[1].content[0].text, longText, '正文必须一字不动地搬进 text 字段');
    assert.deepEqual(out[1].content[0].cache_control, { type: 'ephemeral' });
  });

  test('deepseek / kimi 一律原样返回(它们不认这个字段)', () => {
    for (const id of ['deepseek', 'kimi']) {
      const msgs = [{ role: 'user', content: longText }];
      assert.equal(withQwenCacheMark(providerOf(id), msgs), msgs);
    }
  });

  test('短正文不打标：那种请求建不起缓存，打标等于白付 1.25 倍建缓存费', () => {
    const msgs = [{ role: 'user', content: '只回复两个字母：ok' }];
    const out = withQwenCacheMark(providerOf('qwen'), msgs);
    assert.equal(out, msgs);
  });

  test('多轮聊天只在最后一条打标，前面的历史保持原样(最长前缀才可复用)', () => {
    const msgs = [
      { role: 'system', content: '聊天系统语' },
      { role: 'user', content: '上一问' },
      { role: 'assistant', content: '上一答' },
      { role: 'user', content: longText },
    ];
    const out = withQwenCacheMark(providerOf('qwen'), msgs);
    assert.equal(out[1].content, '上一问');
    assert.equal(out[2].content, '上一答');
    assert.ok(Array.isArray(out[3].content));
    assert.notEqual(out, msgs, '应返回新数组而不是就地改动');
  });
});
