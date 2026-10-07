/* wiki 相对链接可达性判据：把「已校验全部相对链接可达」这句话从注释变成能跑的断言。
 *
 * 两条钉子(与 beijing-caliber-scan.test.ts 同构)：
 *   1) 基线 bad=0 且扫描面非空 —— 链接指向的源码被改名/删除时这条红。
 *   2) 尺子本身能分叉：故意往测试矩阵塞一条坏链，扫描必须报出恰好 1 条；
 *      还原后必须回到 bad=0。没有这条，第 1 条可能是一条永真空判据
 *      (上一轮北京口径就是栽在「尺量不出分叉却全绿」上)。 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 文档里的数量词可能写成中文(「十九个脚本」)，也可能写成阿拉伯数字，两种都认。
   ⚠ 别用单字表查「十九」：CN_DIGIT['十九'] 是 undefined ⇒ NaN ⇒ 计数钉子静默失效。
   ⚠ 数词必须限定为**真数词字符集**，不能用泛化的 `[一二三四五六七八九十]{1,2}`：
   「这个脚本先把…」里的「这」会被当成数词匹配上(实测红过一次)。
   「一」「二」同时也是常用代词/前缀，故只认紧跟量词的整体形态。 */
const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const cnToNumber = (s: string): number => {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const tens = s.indexOf('十');
  if (tens >= 0) {
    const hi = tens === 0 ? 1 : CN_DIGIT[s.slice(0, tens)];
    const lo = s.length > tens + 1 ? CN_DIGIT[s.slice(tens + 1)] : 0;
    if (hi == null || lo == null) return NaN;
    return hi * 10 + lo;
  }
  return CN_DIGIT[s] ?? NaN;
};
/* 只接受「十一/十九/四/19」这类纯数词，后面紧跟可选空白再跟「个脚本」。 */
const SCRIPT_COUNT_RE = /([一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九]|\d+)(?=\s*个脚本)/g;

/* 判据自身的用例表：漏算会伪装成「文档没问题」，错算会把正确文档判死。 */
export const COUNT_CASES: Array<[string, number[]]> = [
  ['本节共十九个脚本', [19]],
  ['四个脚本，都不参与运行时', [4]],
  ['scripts 下共 19 个脚本', [19]],
  ['十个脚本', [10]],
  ['这个脚本先把 ANSI 剥掉再解析', []], // ← 曾误报「这」为数词
  ['上一版文档写「四个脚本」', [4]], // 引用历史也算声明，由下面的豁免规则处理
];

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const CHECK_SCRIPT = resolve(repo, 'scripts', 'check-wiki-links.cjs');
const MATRIX_DOC = resolve(repo, 'docs', 'wiki', '51-测试矩阵.md');

/** 跑一次扫描并解析协议行。 */
function runCheck() {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [CHECK_SCRIPT], { encoding: 'utf8', cwd: repo });
  } catch (err) {
    stdout = String((err as any).stdout || '');
    code = Number((err as any).status ?? 1);
  }
  const ok = /^OK (\d+) (\d+) (\d+)(?: (\d+))?$/m.exec(stdout);
  return {
    mdFiles: Number(ok?.[1] ?? -1),
    total: Number(ok?.[2] ?? -1),
    bad: Number(ok?.[3] ?? -1),
    badLines: [...stdout.matchAll(/^BAD (.+)$/gm)].map((m) => m[1]),
    code,
    stdout,
  };
}

describe('wiki 相对链接可达性', () => {
  it('基线：所有相对链接的目标都存在，且扫描面非空', () => {
    const r = runCheck();
    expect(r.bad, '存在坏链:\n' + r.stdout).toBe(0);
    expect(r.code, '全绿时退出码应为 0:\n' + r.stdout).toBe(0);
    /* 空判据闸门：mdFiles/total 任一为 0 或 -1，说明扫描压根没碰到内容，
       此时 bad=0 是白给的，不能算通过。 */
    expect(r.mdFiles, '没扫到 wiki 文档，判据恒真').toBeGreaterThan(5);
    expect(r.total, '一条相对链接都没解析出来，判据恒真').toBeGreaterThan(100);
    /* 【判据缺陷 #130】矩阵表格里写着「本 wiki 里的相对链接(当前读数 N 条)」，而承诺「由脚本当场打印」
       是空的 —— 没有任何脚本打这个数，`total > 100` 也管不到它，于是那个数字从写下起就没人回读
       (实测停在 359、真值已 361)。散文里的数量词要么不写，要么就得有校验器；这里选择后者：
       把扫描器读数与文档里写的读数钉成同一个数。 */
    const doc = readFileSync(MATRIX_DOC, 'utf8');
    const claims = [...doc.matchAll(/相对链接\(当前读数 (\d+) 条\)/g)].map((m) => Number(m[1]));
    expect(claims.length, '矩阵里登记链接条数的位置匹配到 0 处或 >1 处 ⇒ 钉子不可信').toBe(1);
    expect(claims[0], `矩阵声称 ${claims[0]} 条，扫描器读到 ${r.total} 条 ⇒ 散文在说谎`).toBe(r.total);
  });

  it('尺子能分叉：植入坏链必须被抓到，还原后重新干净', () => {
    const original = readFileSync(MATRIX_DOC, 'utf8');
    /* ⚠ 只改 href，不改显示文字。上一版夹具拿整条 `[qwen-cache.test.mjs](../../…/qwen-cache.test.mjs)`
       做锚点再 `replace(anchor, anchor.replace("qwen-cache.test.mjs","…-TYPO…"))`：该文件名在链接里出现
       **两次**(方括号内一次、圆括号内一次)，无 count 的 replace 只换第一处 ⇒ 改的是显示文字、href 原样有效，
       扫描器报 bad=0 是**正确行为**，却被我读成「判据杀不掉坏链」。实测残留过一行
       `[qwen-cache-TYPO.test.mjs](../../server/test/qwen-cache.test.mjs)`。
       所以锚点取带 `](` 前缀的 href 片段，天然只命中链接目标那一处。 */
    const anchor = '](../../server/test/qwen-cache.test.mjs)';
    const hits = original.split(anchor).length - 1;
    expect(hits, `测试矩阵里 href 锚点出现 ${hits} 次，夹具不可信`).toBe(1);

    const mutant = anchor.replace('qwen-cache.test.mjs', 'qwen-cache-TYPO.test.mjs');
    try {
      writeFileSync(MATRIX_DOC, original.replace(anchor, mutant), 'utf8');
      /* 变异落地自证：坏 href 必须在盘上，且原 href 必须已不在。
         没有这一步，「扫描没抓到」分不清是判据瞎了还是变异压根没进去。 */
      const onDisk = readFileSync(MATRIX_DOC, 'utf8');
      expect(onDisk, '变异没落盘').toContain(mutant);
      expect(onDisk, '原 href 仍在，说明改的不是被测目标').not.toContain(anchor);
      const r = runCheck();
      expect(r.bad, '植入坏链后应恰好报 1 条:\n' + r.stdout).toBe(1);
      expect(r.badLines.join('\n'), '坏链应指向被改名的文件').toContain('qwen-cache-TYPO.test.mjs');
      expect(r.code, '有坏链时退出码应为 1:\n' + r.stdout).toBe(1);
    } finally {
      writeFileSync(MATRIX_DOC, original, 'utf8');
    }

    const restored = runCheck();
    expect(restored.bad, '还原后应重新 bad=0:\n' + restored.stdout).toBe(0);
    expect(restored.code, '还原后退出码应重新为 0:\n' + restored.stdout).toBe(0);
    /* 净零自证：还原写回的字节必须与原文件一致，否则「还原后变绿」绿的是另一个文件。 */
    expect(readFileSync(MATRIX_DOC, 'utf8'), '还原后内容与读入快照不一致').toBe(original);
  });

  it('散文里的链接语法也算链接：解释判据的文字同样受这条尺约束', () => {
    /* 本判据第一次跑红就红在我自己写的说明文字里(正文用 `]()` 讲路径)。
       曾想为此单加一道「省略号路径」闸门，实测删掉了：`path.normalize` 把 `…` 当普通目录名，
       任何含省略号的路径都必然解析不到真实文件 ⇒ 存在性判据恒先抓到它，闸门是冗余判据。
       这里因此只钉「坏链计数覆盖散文」这一实际行为，不再承诺独立的第二类计数。 */
    const original = readFileSync(MATRIX_DOC, 'utf8');
    const anchor = '](../../server/test/netguard.test.mjs)';
    expect(original.split(anchor).length - 1, 'href 锚点须唯一命中').toBe(1);
    const proseHref = '../../server/\u2026/netguard.test.mjs';
    try {
      writeFileSync(MATRIX_DOC, original.replace(anchor, `](${proseHref})`), 'utf8');
      const r = runCheck();
      expect(r.bad, '散文式省略号链接应作为坏链被抓到:\n' + r.stdout).toBe(1);
      expect(r.badLines.join('\n'), '应点名到该条路径').toContain(proseHref);
      expect(r.code, '有坏链时退出码应为 1:\n' + r.stdout).toBe(1);
    } finally {
      writeFileSync(MATRIX_DOC, original, 'utf8');
    }
    expect(runCheck().bad, '还原后应归零').toBe(0);
  });

  it('工具脚本文档必须逐个登记 scripts/ 下的文件，且数量词声明要属实', () => {
    /* 42-工具脚本.md 开头写「四个脚本」，实测 scripts/ 下有 19 个(含十一套变异电池)。
       散文里的数量词是最容易烂掉的一类承诺 —— 加一个脚本没人回去改数字，于是文档长期说谎。
       这里不钉具体数字(那会逼每次加脚本都改文档)，钉的是**覆盖完整性**：
       scripts/ 里每个文件名都要能在该文档中找到，缺一个就红。 */
    const doc = readFileSync(resolve(repo, 'docs', 'wiki', '42-工具脚本.md'), 'utf8');
    const actual = readdirSync(resolve(repo, 'scripts')).sort();
    const missing = actual.filter((f) => !doc.includes(f));
    /* 非空自证：actual 为空时 missing 恒空 ⇒ 永真判据。 */
    expect(actual.length, '没列出任何脚本，判据恒真').toBeGreaterThan(10);
    expect(missing, '以下脚本未在工具文档中出现: ' + missing.join(', ')).toEqual([]);
    /* 反向钉子：文档若用数量词声称脚本个数，必须等于真实个数。
       先钉**正则本身**(用例表)再拿它扫文档 —— 上一版直接扫文档，
       「这个脚本先把…」里的「这」被泛化字符集当成数词 ⇒ 正确文档被判死(假红)。 */
    for (const [text, expected] of COUNT_CASES) {
      const got = [...text.matchAll(SCRIPT_COUNT_RE)].map((m) => cnToNumber(m[1]));
      expect(got, `计数正则读错: ${text}`).toEqual(expected);
    }
    /* 扫文档时先摘掉「…」内的历史引述：那种句子在讲过去写错了什么，不是当前声明。 */
    const currentText = doc.replace(/「[^」]*个脚本[^」]*」/g, '');
    const claims = [...currentText.matchAll(SCRIPT_COUNT_RE)].map((m) => cnToNumber(m[1]));
    for (const n of claims) {
      expect(Number.isNaN(n), '数词解析出 NaN，正则与解析器不同步').toBe(false);
      expect(n, `文档声称 ${n} 个脚本，实际 ${actual.length} 个`).toBe(actual.length);
    }
    /* 扫描面非空自证：若一条声明都没读到，说明要么文档没写计数(允许)，
       要么正则压根不响(不允许)。用探针文本证明它能响。 */
    expect([...'本节共十九个脚本'.matchAll(SCRIPT_COUNT_RE)].map((m) => cnToNumber(m[1])), '计数钉子不响').toEqual([19]);
  });
});
