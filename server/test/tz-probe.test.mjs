/* 子进程判据体：宿主时区由 env.TZ 决定(父用例用 spawnSync({env}) 起它)，
 * 时钟只钉「此刻」到跨年那一刻，字段读法保持宿主真实行为。
 * 走本地字段的写法在非 +08 宿主会读出旧一月/旧年(实测 America/New_York 下
 * month→12、year→2025)，北京口径必须始终给 2026-01。读数写成一行 JSON 供父用例解析。 */
/* ⚠ 本文件**故意不叫** tz-probe.mjs：`npm test`(= node --test) 按「*.test.mjs / test 目录」
   的规则发现测试，实测它被自动发现后直接执行了一遍(汇总里多出行「✔ test\\tz-probe.test.mjs」)。
   既然躲不掉，就把它写成能被自动发现的形态 —— 见下方 run() 的两用设计；
   但**别用 `node --test <本文件>` 单独跑**：Node 警告
   「run() is being called recursively within a test file. skipping running files」
   且什么都不跑(rc=0、stdout 空)，看着像探针坏了。手动跑用 `node test/tz-probe.test.mjs`。 */
/* ⚠ 取 chat.mjs 必须用 require，不能 import：import 是 hoisted 的，会在打桩之前就把
   chat.mjs 顶层的 const now = Date 绑成真 Date，桩永远打不着(实测各时区都报 month:1，
   看着像「修好了」，其实是桩没生效)。createRequire + 同步求值 ⇒ 桩先生效。 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import './netGuard.mjs';

const CROSS_YEAR_UTC = '2025-12-31T16:00:00Z'; // 北京 2026-01-01；UTC 主机读出 2025-12-31

/* 宿主时区的**实测**读数：任何打桩之前、用原生 Date 读同一刻。
   ⚠ 不要凭印象写死偏移：本机 TZ unset 时是 +8，TZ=UTC/-0500/+1000 一律读出 GMT+00:00
   (Windows Node 认不出 ±HHMM 这种写法，实测偏移都是 0)，而 IANA 区名会让进程直接抛错。
   所以这里只报读数，「换没换出来」由父用例比较 localMonth 与北京月份来判定。 */
const HOST_OFFSET_MIN = new Date(CROSS_YEAR_UTC).getTimezoneOffset();
const HOST_LOCAL_MONTH = new Date(CROSS_YEAR_UTC).getMonth() + 1;

function run() {
  const tz = process.env.TZ; // 允许未设：那正是「系统默认宿主」这一列，本机为东八区
  const RealDate = globalThis.Date;
  class InstantOnly extends RealDate {
    constructor(value) { super(typeof value === 'undefined' ? CROSS_YEAR_UTC : value); }
  }
  globalThis.Date = InstantOnly;
  let r;
  let pinnedIso;
  let localMonth;
  /* 桩落地自检放在 try 内、且趁桩还在时读：还原 Date 之后再 new Date() 读到的是真表，
     自检会永远抛「桩没生效」——上一版就是这么把四条本来正常的探针全判成失败的。 */
  try {
    pinnedIso = new Date().toISOString();
    localMonth = new Date().getMonth() + 1;
    if (pinnedIso.slice(0, 16) !== '2025-12-31T16:00') throw new Error('桩没生效: ' + pinnedIso);
    r = require('../chat.mjs').extractWhen('本月财运');
  } finally { globalThis.Date = RealDate; }
  if (localMonth !== HOST_LOCAL_MONTH) throw new Error('桩的本地读数与原表不一致(' + localMonth + ' vs ' + HOST_LOCAL_MONTH + ')，桩不可信');
  process.stdout.write('PROBE ' + JSON.stringify({
    tz: String(tz ?? ''),
    hostOffsetMin: HOST_OFFSET_MIN,
    localMonth,
    got: [r.year, r.month],
  }) + '\n');
}
/* 两种起法都要能跑：父用例 `node <本文件>`(直接求值)，以及 `npm test` 的自动发现。
   ⚠ 实测 process.env.TZ **不会**随 --test-name-pattern / 单独指定文件而被过滤掉：
   上一版靠「非子进程就跳过」的开关，结果 node --test 里它照样跑了完整矩阵并因 TZ 未设而红
   (报「TZ 未设的子进程没吐判据行」) —— 那种「看起来像环境坏了」的红最容易误诊。
   所以这里不加任何开关：无论谁起、带不带 TZ，都只如实报一行读数；
   真正的跨时区断言只在 chat-timezone.test.mjs 那条 opt-in 用例里做。
   ⚠ 末尾的 test() 必须留：`node --test` 会把本文件当测试文件发现，若里面一条测试都没有，
   它会报「must include at least one test」而失败(实测)。 */
import { test } from 'node:test';
run();
test('tz-probe(独立探针：报出当前宿主的北京口径读数)', run);
