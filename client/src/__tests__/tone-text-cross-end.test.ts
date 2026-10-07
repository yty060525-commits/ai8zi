import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 语气指令正文三端逐字节同源判据(#135)。
   ai.mjs / lib.rs / deepseekAdapter.ts 各有一份「语气：…」指令，滑杆档位(90/60/45/10)与五档文案本应同一条。
   实测缺陷：浏览器直连 toneInstructionText 用的是缩写版(「语气：温柔夸夸——先说优点亮点…」)，另两端是完整版，
   同一个滑杆值在网页直连拿到的措辞指令与走服务器/桌面不同。而 server/test/prompt-parity.test.mjs:12 自陈
   「语气段的措辞文本也各端一份，只比标题」—— 标题钉了、正文从没比过，所以这个分叉一直静默存活。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const adapter = src('../data/deepseekAdapter.ts');
const server = src('../../../server/ai.mjs');
const rust = src('../../src-tauri/src/lib.rs');

/** 取某函数体里所有以「语气：」开头的字符串字面量(按出现顺序)。 */
const toneStrings = (text: string, fnRe: RegExp, where: string): string[] => {
  const start = text.split('\n').findIndex((l) => fnRe.test(l));
  expect(start, `${where} 的函数没找到 ⇒ 写法变了`).toBeGreaterThanOrEqual(0);
  // 从命中行起往下扫到第一个单独的收尾大括号(函数结束)。
  const lines = text.split('\n').slice(start);
  const body: string[] = [];
  for (const l of lines.slice(1)) {
    if (/^\s*\}/.test(l)) break;
    for (const m of l.matchAll(/['"]?(语气：[^'"]*)['"]/g)) body.push(m[1]);
    // Rust 用 "…" 结尾后接 }，JS 用 '…'; 上面 matchAll 已覆盖两种引号里的中文串。
  }
  expect(body.length, `${where} 读到的语气正文字符串数不是 5(读到 ${body.length})`).toBe(5);
  return body;
};

describe('语气指令正文三端逐字节同源(#135)', () => {
  const a = toneStrings(adapter, /export function toneInstructionText/, 'adapter toneInstructionText');
  const s = toneStrings(server, /export function toneInstruction\(/, 'server toneInstruction');
  const r = toneStrings(rust, /fn tone_instruction\(tone: i32\)/, 'rust tone_instruction');

  it('尺子能打响：三端各读到五条「语气：」正文', () => {
    for (const [name, arr] of [['浏览器', a], ['服务端', s], ['桌面', r]] as const) {
      expect(arr.length, `${name} 语气正文条数异常`).toBe(5);
      for (const t of arr) expect(t, `${name} 有条正文不以「语气：」开头`).toMatch(/^语气：/);
    }
  });

  it('三端五档正文逐字节相同(同一滑杆值三通道拿到同一条指令)', () => {
    /* 档位阈值都是 90/60/45/10、每档唯一一条，所以按集合比对既查内容分叉也不依赖书写行序。
       用排序后的 join 做等式，任何一端少一档/换措辞都会红。 */
    const key = (arr: string[]): string => [...arr].sort().join('\u0001');
    expect(key(s), '服务端语气正文与浏览器直连分叉').toBe(key(a));
    expect(key(r), '桌面语气正文与浏览器直连分叉 ⇒ 同一问在不同通道拿到不同措辞指令(#135)').toBe(key(a));
  });

  it('正向钉子：读的确实是那三份源码，且没有残留缩写版破折号写法', () => {
    expect(adapter).toContain('export function toneInstructionText');
    expect(server).toContain('export function toneInstruction(');
    expect(rust).toContain('fn tone_instruction(tone: i32)');
    // #135 修复前浏览器直连用的是「语气：xxx——」缩写句式；统一后三端都不该再有这种破折号紧跟档名的写法。
    for (const [name, arr] of [['浏览器', a], ['服务端', s], ['桌面', r]] as const) {
      for (const t of arr) expect(t, `${name} 仍是缩写版(「档名——」)`).not.toMatch(/(夸夸|优先|客观|犀利|直白)——/);
    }
  });
});
