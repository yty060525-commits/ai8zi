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
  it('判定标准点名引擎结论并要求不得重判', () => {
    const scope = grabJs(server, 'SCOPE_PREFIX'), base = grabJs(server, 'BASELINE_PROMPT');
    expect(scope).toContain('格局事实');
    expect(scope).toContain('旺衰评分');
    expect(scope).toContain('不得重判');
    expect(base).toContain('不得改判');
    expect(base).toContain('是否得令');
  });
  it('提示词正文不得出现任何英文字段名(截图事故的根因)', () => {
    // 截图事故：「得令与否(inSeason)为false」被原文照抄。根因是提示词自己写进了英文键名 —— 提示词里有什么，模型就抄什么。
    // schema 键名与占位符 X 是让模型按结构作答所必需的机器可读标记；其余一律不许有拉丁字母。
    const ALLOWED = new Set(['JSON', 'schema', 'title', 'explanation', 'pattern', 'strength', 'usefulElements', 'avoidElements', 'overall', 'health', 'career', 'wealth', 'love', 'notice', 'X']);
    // 这些是「数据结构的内部代号」——它们一旦出现，模型就会照抄成正文(截图事故的根因)。
    const BANNED = ['inSeason', 'monthHasSupport', 'support', 'drain', 'index', 'label', 'basis', 'special', 'dayMaster', 'hiddenStems', 'tenGods', 'shenSha', 'scope', 'natal', 'patternFacts', 'strengthScore', 'tiaohouFacts', 'true', 'false', 'null'];
    for (const name of ['SCOPE_PREFIX', 'BASELINE_PROMPT', 'OVERVIEW_PROMPT', 'ADJUST_PREFIX']) {
      const text = grabJs(server, name);
      const latin = text.match(/[A-Za-z]+/g) || [];
      expect(latin.filter((w) => !ALLOWED.has(w))).toEqual([]);
      for (const word of BANNED) {
        expect(text).not.toContain(word);
        expect(text).not.toContain(`(${word})`);
        expect(text).not.toContain(`（${word}）`);
      }
    }
  });
  it('公共前缀不含任何随任务变化的内容', () => {
    for (const name of ['SCOPE_PREFIX', 'BASELINE_PROMPT', 'OVERVIEW_PROMPT']) {
      const text = grabJs(server, name);
      expect(/20[2-9]\d/.test(text)).toBe(false);
      expect(/年龄约 \d/.test(text)).toBe(false);
    }
  });
  it('natal 标题与语气标题两端用同一份常量，且各分支只拼一次', () => {
    // 标题一旦在某个分支被手写改字(如「本命」→「命主」)，跨通道公共前缀当场分叉；
    // 定义文本相同不代表拼装顺序相同，所以这里查真实代码里的引用形式。
    for (const [file, src] of [['deepseekAdapter.ts', adapter], ['server/ai.mjs', server]] as const) {
      expect(src).toContain('NATAL_BLOCK_HEAD + JSON.stringify(');
      expect(src).toContain('TONE_HEAD + tone');
      expect(src.match(/# 本命事实数据\(JSON，只依据此数据\)/g)?.length ?? 0).toBe(1);
      expect(src.match(/# 语气要求\(必须按此措辞把握全篇\)/g)?.length ?? 0).toBe(1);
    }
  });
});
