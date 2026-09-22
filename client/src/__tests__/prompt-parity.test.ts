import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 三份提示词(服务器 / 浏览器直连 / Rust 桌面端)必须逐字节一致，否则同一命盘在不同通道
 * 会给出不同口径的答案。这里直接读源码比对常量文本 —— 改一处忘两处会被这条测试拦下。 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../') + '/';
const read = (p: string) => readFileSync(root + p, 'utf8').replace(/\r\n/g, '\n');

const grabJs = (src: string, name: string) => {
  const s = src.indexOf(`const ${name} = '`);
  if (s < 0) throw new Error('missing ' + name);
  let acc = '';
  for (const ln of src.slice(s).split('\n')) { acc += (acc ? '\n' : '') + ln; if (ln.endsWith(';')) break; }
  return [...acc.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('').replace(/\\n/g, '\n').replace(/\\'/g, "'");
};
const grabRust = (src: string, name: string) => {
  const head = `const ${name}: &str = concat!(`;
  const s = src.indexOf(head);
  if (s < 0) throw new Error('missing rust ' + name);
  const body = src.slice(s + head.length, src.indexOf('\n);', s));
  return [...body.matchAll(/^\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1]).join('').replace(/\\n/g, '\n').replace(/\\"/g, '"');
};

describe('三通道提示词一致性', () => {
  const server = read('server/ai.mjs');
  const adapter = read('client/src/data/deepseekAdapter.ts');
  const rust = read('client/src-tauri/src/lib.rs');

  it('时段任务前缀三处完全相同', () => {
    const s = grabJs(server, 'SCOPE_PREFIX'), a = grabJs(adapter, 'SCOPE_PREFIX'), r = grabRust(rust, 'SCOPE_PREFIX');
    expect(a).toBe(s); expect(r).toBe(s);
    expect(s.length).toBeGreaterThan(400);
  });
  it('本命任务前缀三处完全相同', () => {
    const s = grabJs(server, 'BASELINE_PROMPT'), a = grabJs(adapter, 'BASELINE_PREFIX'), r = grabRust(rust, 'BASELINE_PREFIX');
    expect(a).toBe(s); expect(r).toBe(s);
  });
  it('全盘总结前缀服务器与浏览器一致', () => {
    expect(grabJs(adapter, 'OVERVIEW_PREFIX')).toBe(grabJs(server, 'OVERVIEW_PROMPT'));
  });
  it('后天调整前缀服务器与浏览器一致', () => {
    expect(grabJs(adapter, 'ADJUST_PREFIX')).toBe(grabJs(server, 'ADJUST_PREFIX'));
  });
  it('判定标准点名引擎字段并要求不得重判', () => {
    const scope = grabJs(server, 'SCOPE_PREFIX'), base = grabJs(server, 'BASELINE_PROMPT');
    expect(scope).toContain('natal.patternFacts');
    expect(scope).toContain('不得重判');
    expect(base).toContain('strengthScore.label');
    expect(base).toContain('不得改判');
    expect(base).toContain('inSeason');
  });
  it('判定标准里的英文字段名一律标注为内部代号，并禁止抄进正文', () => {
    const base = grabJs(server, 'BASELINE_PROMPT');
    expect(base).toContain('绝对不得写进 explanation');
    // 截图事故：「得令与否(inSeason)为false」原文照抄。这些括号注音式写法必须彻底消失。
    for (const word of ['inSeason', 'monthHasSupport', 'support', 'drain', 'index', 'label']) {
      expect(base).not.toContain(`(${word})`);
      expect(base).not.toContain(`（${word}）`);
    }
  });
  it('公共前缀不含任何随任务变化的内容', () => {
    for (const name of ['SCOPE_PREFIX', 'BASELINE_PROMPT', 'OVERVIEW_PROMPT']) {
      const text = grabJs(server, name);
      expect(/20[2-9]\d/.test(text)).toBe(false);
      expect(/年龄约 \d/.test(text)).toBe(false);
    }
  });
});
