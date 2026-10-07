import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* natal 键序跨端判据(#132)。
   三端都把「本命事实」整段 JSON 放在任务指令**之前**，四类任务因此共享同一段公共前缀 ——
   前缀一断，Qwen 显式缓存当场失效(重新花钱)。所以三端注释都写着「与另两端同序」：
     - server/ai.mjs        「dayMaster→zodiac→solarDate 与客户端 natal 同序」
     - deepseekAdapter.ts   「与服务器 natal 同序」
     - lib.rs               「与另两端 natal 同序：紧随 strengthScore、先于 luckStart」
   而这三句话从来没有校验器：prompt-parity 只比四个提示词常量，server 侧 parity 只在两份 JS 之间比。
   ⇒ 桌面端的顺序漂移是静默的。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 从源码里取一段对象字面量的顶层键顺序。
 *  ⚠ 【测量缺陷 · 实测】第一版只认 `"key":` —— 服务端与适配器写的是**不带引号**的
 *     `gender: record.gender`，于是整块读出 0 个键，红在「锚点或扫描失效」上。
 *     Rust 的 json! 宏必须带引号、JS 两种都合法 ⇒ 这里同时认裸标识符键和字符串键。 */
const keysOf = (text: string, startRe: RegExp, where: string): string[] => {
  const m = startRe.exec(text);
  expect(m, `${where} 的起点锚没命中 ⇒ 写法变了或整块没了`).toBeTruthy();
  const body = text.slice((m?.index ?? 0) + (m?.[0].length ?? 0));
  const keys: string[] = [];
  let depth = 1;
  for (let i = 0; i < body.length && depth > 0; i++) {
    const c = body[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"' || c === "'") {
      const q = c;
      const j = i + 1 + body.slice(i + 1).indexOf(q);
      if (j < 0) break;
      const token = body.slice(i + 1, j);
      let k = j + 1;
      while (k < body.length && /\s/.test(body[k])) k++;
      if (body[k] === ':') keys.push(token);
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++;
      const token = body.slice(i, j);
      let k = j;
      while (k < body.length && /\s/.test(body[k])) k++;
      /* 只收「后面紧跟冒号」的键；值里的 a.b 成员访问、`case x:` 之类不会走到这里
         (它们前面不是行首/逗号后的裸标识符，且深度已排除嵌套层)。 */
      if (body[k] === ':' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) keys.push(token);
      i = j - 1;
    }
  }
  expect(keys.length, `${where} 只读到 ${keys.length} 个键 ⇒ 锚点或扫描失效`).toBeGreaterThan(5);
  return keys;
};

describe('natal 键序跨端同源(#132)', () => {
  const rust = src('../../src-tauri/src/lib.rs');
  const server = src('../../../server/ai.mjs');
  const adapter = src('../data/deepseekAdapter.ts');

  /* 起点锚：三端各写一条，命中数当场自证。 */
  const RUST_START = /let natal = serde_json::json!\(\{/;
  const SERVER_START = /export function natalFactsOf\(record\) \{[\s\S]*?\n  return \{/;
  const ADAPTER_START = /\n  const natal = \{/;

  it('尺子能打响：三端各读到一份非空键序，且共有键齐全', () => {
    const shared = /export const NATAL_SHARED_KEYS = \[([^\]]*)\]/.exec(adapter)?.[1]
      .split(',').map((s) => s.trim().replace(/'/g, '')) ?? [];
    expect(shared.length, 'NATAL_SHARED_KEYS 读不到 ⇒ 前提失效').toBe(13);

    const rKeys = keysOf(rust, RUST_START, 'lib.rs natal');
    const sKeys = keysOf(server, SERVER_START, 'server natalFactsOf');
    const aKeys = keysOf(adapter, ADAPTER_START, 'adapter natal');
    for (const [name, ks] of [['rust', rKeys], ['server', sKeys], ['adapter', aKeys]] as const) {
      for (const key of shared) {
        expect(ks, `${name} 的 natal 缺共有键 ${key}`).toContain(key);
      }
    }
  });

  it('三端共有键的相对顺序必须一致(顺序即前缀字节)', () => {
    const shared = (/export const NATAL_SHARED_KEYS = \[([^\]]*)\]/.exec(adapter)?.[1] ?? '')
      .split(',').map((s) => s.trim().replace(/'/g, ''));
    const project = (ks: string[]): string[] => ks.filter((k) => shared.includes(k));
    const rKeys = project(keysOf(rust, RUST_START, 'lib.rs natal'));
    const sKeys = project(keysOf(server, SERVER_START, 'server natalFactsOf'));
    const aKeys = project(keysOf(adapter, ADAPTER_START, 'adapter natal'));
    expect(sKeys.join(','), '服务器与浏览器直连的共有键序分叉(基准本身不可信)').toBe(aKeys.join(','));
    expect(rKeys.join(','), '桌面 natal 共有键序与服务端不同 ⇒ 同一命盘在三端拼出不同的公共前缀')
      .toBe(sKeys.join(','));
  });

  it('tiaohouFacts 必须紧随 strengthScore、先于 luckStart(三端注释共同承诺的那一处)', () => {
    const triples = [
      ['lib.rs', keysOf(rust, RUST_START, 'lib.rs natal')],
      ['server', keysOf(server, SERVER_START, 'server natalFactsOf')],
      ['adapter', keysOf(adapter, ADAPTER_START, 'adapter natal')],
    ] as const;
    for (const [name, ks] of triples) {
      const i = ks.indexOf('strengthScore');
      expect(i, `${name} 没有 strengthScore`).toBeGreaterThanOrEqual(0);
      expect(ks[i + 1], `${name} 的 strengthScore 后面不是 tiaohouFacts`).toBe('tiaohouFacts');
      const t = ks.indexOf('tiaohouFacts');
      const l = ks.indexOf('luckStart');
      expect(l, `${name} 没有 luckStart`).toBeGreaterThanOrEqual(0);
      expect(t < l, `${name} 的调候排在了起运之后`).toBe(true);
    }
  });

  it('正向钉子：本文件读的确实是那三份源码(路径写错会让上面全绿)', () => {
    expect(rust).toContain('pub(crate) fn chat_cache_key');
    expect(server).toContain('export function natalFactsOf');
    expect(adapter).toContain('export const NATAL_SHARED_KEYS');
  });
});
