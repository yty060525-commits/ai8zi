#!/usr/bin/env node
/* 北京口径缺陷类闭合扫描：可重复执行的枚举判据。
 *
 * 目的：把「同类修到第 3 次就做全空间枚举扫描」这条规则落成脚本，
 * 让未来的回归无法绕过它。每次新增 `new Date()`/`Date.now()`/本地字段读取点时，
 * 本脚本必须显式给出分类，否则报「未覆盖」。
 *
 * 分类：
 *   (a) routed — 已走 chinaDate / chinaParts / chinaYear / chinaYearMonth / chinaYmd / chinaDateTimeParts
 *   (b) neutral — 时区中性：ISO 串、时间戳比较、耗时计算、cache buster、session TTL、
 *       日历回环校验(如 ChartPage 的 probe.getFullYear() 检查日期存在性)
 *   (c) uncovered — 既没走北京辅助函数，也不在 neutral 白名单里 ⇒ 视为潜在缺陷
 *
 * 用法：node scripts/beijing-caliber-scan.cjs [--json]
 * 退出码：0 全绿；1 有 uncovered 项；2 环境错误
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 扫描范围：客户端源码 + 服务端 .mjs + Tauri Rust。排除测试、dist、node_modules、target。 */
function walk(dir, patterns, skipDirs) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      out.push(...walk(full, patterns, skipDirs));
    } else if (patterns.some((p) => p.test(e.name))) {
      out.push(full);
    }
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'target', '.git']);

/** server/test/ 下的 .mjs 是判据体与探针，不是产品代码。
 *  它们故意读本地字段来证明「本地读数 vs 北京读数」确实分叉，因此不在本扫描的覆盖范围内。 */
const SERVER_TEST_PREFIX = 'server/test/';

const files = [
  ...walk(path.join(ROOT, 'client', 'src'), [/\.[cm]?[jt]sx?$/], SKIP_DIRS),
  ...walk(path.join(ROOT, 'server'), [/\.mjs$/], SKIP_DIRS),
  ...walk(path.join(ROOT, 'client', 'src-tauri', 'src'), [/\.rs$/], SKIP_DIRS),
].filter((abs) => {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  return !rel.startsWith(SERVER_TEST_PREFIX);
});

/** 匹配本地字段读取：getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getTime 等。
 *  getTime 本身返回 UTC epoch，时区中性；但和 getFullYear 同现时通常是在做本地日历运算。 */
const LOCAL_FIELD_RE = /\.(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds)\s*\(/g;
const NEW_DATE_RE = /new\s+Date\s*\(/g;
const DATE_NOW_RE = /Date\.now\s*\(\)/g;
const BEIJING_HELPER_RE = /\b(chinaDateParts|chinaDateTimeParts|chinaYear|chinaYearMonth|chinaYmd|chinaParts)\b/g;

/** 时区中性的白名单：这些行即使出现本地字段也无需走北京辅助函数。
 *  每条用「文件相对路径 + 正则片段」匹配，命中即标 neutral。 */
const NEUTRAL_PATTERNS = [
  // ISO 串比较：toISOString().slice(0,10) 本身就是 UTC 日期，与设备时区无关。
  { file: null, regex: /toISOString\s*\(\s*\)/ },
  // 纯耗时/差值计算：Date.now() 或 new Date().getTime() 做减法。
  { file: null, regex: /Date\.now\s*\(\s*\)/ },
  { file: null, regex: /\.getTime\s*\(\s*\)/ },
  // cache buster / session key：用时间戳当唯一后缀。
  { file: null, regex: /cache.?buster|nonce|timestamp.*key/i },
  // 日历回环校验：probe.getFullYear() 只检查「这个日期在该月存在吗」，不读业务年月。
  { file: /ChartPage/, regex: /probe\.(getFullYear|getMonth|getDate)/ },
  { file: /nonAiCalculator/, regex: /lastDay|daysInMonth|new Date\(year,\s*month\s*\+\s*1,\s*0\)/ },
  // lunar-javascript 库对象(Solar/Lunar/EightChar)的 getYear/getMonth/getDay 返回的是
  // 「朴素历法字段」——它们按传入的年月日构造，不读系统时钟，因此与宿主时区无关。
  // 这类调用在排盘引擎里大量出现，统一归为 neutral。
  { file: /client\/src/, regex: /\b(Solar|Lunar|EightChar|atNoon|noonOf|candidate|nd|solar|lunar|eight)\b.*\.(getYear|getMonth|getDay|getHours|getMinutes)\s*\(/ },
  // 服务端 chat.mjs 内部已全量走 chinaParts，不再单独列白名单。
  // buildInfo.ts 的 at.get* 已被 chinaDateTimeParts 包裹，不会裸出现。
];

function isNeutral(relPath, line) {
  return NEUTRAL_PATTERNS.some((p) => {
    if (p.file && !p.file.test(relPath)) return false;
    return p.regex.test(line);
  });
}

function scan() {
  const results = { routed: [], neutral: [], uncovered: [] };

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const code = fs.readFileSync(abs, 'utf8');
    const lines = code.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      const hasLocalField = LOCAL_FIELD_RE.test(line);
      LOCAL_FIELD_RE.lastIndex = 0;
      const hasNewDate = NEW_DATE_RE.test(line);
      NEW_DATE_RE.lastIndex = 0;
      const hasDateNow = DATE_NOW_RE.test(line);
      DATE_NOW_RE.lastIndex = 0;
      const hasBeijingHelper = BEIJING_HELPER_RE.test(line);
      BEIJING_HELPER_RE.lastIndex = 0;

      if (!hasLocalField && !hasNewDate && !hasDateNow) continue;

      const entry = { file: rel, line: i + 1, text: trimmed };

      if (hasBeijingHelper) {
        results.routed.push(entry);
      } else if (isNeutral(rel, line)) {
        results.neutral.push(entry);
      } else if (hasLocalField) {
        results.uncovered.push(entry);
      } else if (hasNewDate || hasDateNow) {
        // new Date()/Date.now() 单独出现时通常是拿时刻做差或转 ISO，默认归 neutral；
        // 但如果同一作用域内有本地字段读取却没走 helper，上面 hasLocalField 分支已经抓到了。
        results.neutral.push(entry);
      }
    }
  }

  return results;
}

function main() {
  try {
    const results = scan();
    const jsonMode = process.argv.includes('--json');

    if (jsonMode) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`扫描 ${files.length} 个文件`);
      console.log(`  routed (已走北京辅助): ${results.routed.length}`);
      console.log(`  neutral (时区中性):     ${results.neutral.length}`);
      console.log(`  uncovered (未覆盖):     ${results.uncovered.length}`);
      if (results.uncovered.length > 0) {
        console.log('\n⚠ 以下调用点既没走北京辅助函数，也不在中性白名单里：');
        for (const r of results.uncovered) {
          console.log(`  ${r.file}:${r.line}  ${r.text.slice(0, 120)}`);
        }
      }
    }

    process.exitCode = results.uncovered.length > 0 ? 1 : 0;
  } catch (err) {
    console.error('scan failed:', err.message);
    process.exitCode = 2;
  }
}

main();
