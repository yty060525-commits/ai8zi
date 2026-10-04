/* 北京口径扫描判据：把「同类修到第 3 次就做全空间枚举扫描」落成可执行断言。
 *
 * 两条钉子：
 *   1) 基线必须 uncovered=0 —— 任何新增的未覆盖本地字段读取都会让这条红。
 *   2) 分类器不空转：故意把 PersonDetail.tsx 的 chinaDateParts(new Date()) 替换成
 *      new Date().getFullYear()/getMonth()/getDate()，扫描必须报出这一条 uncovered；
 *      还原后必须变回 uncovered=0。
 *
 * 运行方式：作为 vitest 用例被自动发现。 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const SCAN_SCRIPT = resolve(repo, 'scripts', 'beijing-caliber-scan.cjs');
const PERSON_DETAIL = resolve(repo, 'client', 'src', 'features', 'person', 'PersonDetail.tsx');

/** 跑一次扫描并解析 stdout 里的计数行。 */
function runScan() {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [SCAN_SCRIPT], { encoding: 'utf8', cwd: repo });
  } catch (err) {
    stdout = String((err as any).stdout || '');
    code = Number((err as any).status ?? 1);
  }
  const routed = Number(/routed.*?:\s*(\d+)/.exec(stdout)?.[1] ?? -1);
  const neutral = Number(/neutral.*?:\s*(\d+)/.exec(stdout)?.[1] ?? -1);
  const uncovered = Number(/uncovered.*?:\s*(\d+)/.exec(stdout)?.[1] ?? -1);
  return { routed, neutral, uncovered, code, stdout };
}

describe('北京口径全空间枚举扫描', () => {
  it('基线：uncovered 必须为 0', () => {
    const r = runScan();
    expect(r.uncovered, '扫描发现未覆盖的本地字段读取:\n' + r.stdout).toBe(0);
    expect(r.code, '扫描退出码应为 0:\n' + r.stdout).toBe(0);
  });

  it('分类器不空转：故意退回本地读数必须被抓到', () => {
    const original = readFileSync(PERSON_DETAIL, 'utf8');
    const anchor = "const today0 = chinaDateParts(new Date());";
    const mutant = "const today0 = { year: new Date().getFullYear(), month: new Date().getMonth() + 1, day: new Date().getDate() };";

    // 前置自检：锚点必须在当前文件里唯一命中，否则夹具失效。
    const hits = original.split(anchor).length - 1;
    expect(hits, `PersonDetail.tsx 里锚点出现 ${hits} 次，夹具不可信`).toBe(1);

    try {
      writeFileSync(PERSON_DETAIL, original.replace(anchor, mutant), 'utf8');
      const r = runScan();
      expect(r.uncovered, '变异后扫描应恰好报出 1 条 uncovered:\n' + r.stdout).toBe(1);
      expect(r.stdout, 'uncovered 列表应包含 PersonDetail.tsx:\n' + r.stdout).toContain('PersonDetail.tsx');
      expect(r.code, '有 uncovered 项时退出码应为 1:\n' + r.stdout).toBe(1);
    } finally {
      writeFileSync(PERSON_DETAIL, original, 'utf8');
    }

    // 还原后必须变回干净状态。
    const restored = runScan();
    expect(restored.uncovered, '还原后扫描应重新 uncovered=0:\n' + restored.stdout).toBe(0);
    expect(restored.code, '还原后扫描退出码应重新为 0:\n' + restored.stdout).toBe(0);
  });
});
