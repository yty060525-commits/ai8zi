import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import './netGuard.mjs'; // import 即上闸：本文件不连任何外部服务
import { openDatabase, insertRecord, getRecordById } from '../db.mjs';
import { extractWhen, analyzeQuestion, collectEvidence, SCAN_YEARS } from '../chat.mjs';

/* =============================================================================
 * 服务端「本月/今年」按北京口径取值 —— 宿主时区不该改变答案
 *
 * 服务端从不设置 process.env.TZ，所以 chat.mjs 里 `now.getMonth()/getFullYear()`
 * 读到的是**部署机**的本地时间。机器不在东八区时(美欧机房、或本机改了系统时区)，
 * UTC 16:00–24:00 这一整天里本地日期比北京早一天：
 *   「本月」答成上个月、「今年」答成去年，扫年窗口整体前移一年。
 * 详情页与浏览器端已收口到 utils/date 的北京口径，这里是同一类缺陷的服务端一处。
 *
 * 判据怎么做到「与时区无关地验证时区」：把全局 Date 的本地读数换成 UTC 读数
 * (等价于一台 UTC 设备)，再走真实导出函数。桩自带落地自检，没生效就抛错，
 * 绝不让断言静默恒真。 */

const CROSS_YEAR_UTC = '2025-12-31T16:00:00Z';   // 北京 2026-01-01；UTC 主机读出 2025-12-31
const CROSS_MONTH_UTC = '2026-01-31T16:00:00Z';  // 北京 2026-02-01；UTC 主机读出 2026-01-31

/** 在「这台机器是 UTC 时区」的假设下执行 run：只改本地读数族，getUTC* / getTime 保持真实。 */
function asUtcHost(run) {
  const RealDate = globalThis.Date;
  class UtcHostDate extends RealDate {
    constructor(value) { super(typeof value === 'undefined' ? CROSS_YEAR_UTC : value); }
    getFullYear() { return this.getUTCFullYear(); }
    getMonth() { return this.getUTCMonth(); }
    getDate() { return this.getUTCDate(); }
    getDay() { return this.getUTCDay(); }
    getHours() { return this.getUTCHours(); }
    getMinutes() { return this.getUTCMinutes(); }
  }
  globalThis.Date = UtcHostDate;
  try { return run(); } finally { globalThis.Date = RealDate; }
}

/** 只钉「此刻」、不改任何字段读法的桩：等价于一台时钟被拨到跨年那一刻的真机。
 *  与 asUtcHost 的区别很关键 —— 那个改了本地 getter，产品只要走 UTC 字段就永远看不到宿主时区；
 *  这个保留宿主时区的真实读法，于是「退回本地字段」的写法会当场给出旧月份(实测 month=12)。 */
async function withPinnedInstant(run) {
  const RealDate = globalThis.Date;
  class InstantOnly extends RealDate {
    constructor(value) { super(typeof value === 'undefined' ? CROSS_YEAR_UTC : value); }
  }
  globalThis.Date = InstantOnly;
  try { return await run(); } finally { globalThis.Date = RealDate; }
}

/* opt-in 跨时区子进程用例：本进程的宿主时区在 Node 启动时就定死了，改不了，
   所以「换宿主时区」的读数只能靠重新起一个进程去读(判据体在 tz-probe.test.mjs)。
   默认跳过以免拖慢常规 `node --test`；MINGLI_TZ_SUBPROCESS=1 时每时区各起一次子进程。
   ⚠ 上一版把判据体放在本文件里、用 --test-name-pattern 过滤调用自己：匹配的是
   「当前正在跑的测试名」，子进程一进来还没有任何测试在跑 ⇒ 四条钩子全不匹配 ⇒
   判据体压根没执行(rc=0、无输出)，差点被我读成「环境坏了」。独立小文件才可靠。 */
if (process.env.MINGLI_TZ_SUBPROCESS === '1') {
  test('跨年那一刻，换宿主时区「本月」仍锚到北京的一月(opt-in 子进程)', async () => {
    const { spawnSync } = await import('node:child_process');
    /* ⚠ 上一版用 bash 前缀 `TZ=xxx node …` 量这个矩阵，得出「Windows Node 只认 UTC，
       IANA 区名会让进程 RangeError、±HHMM 落回 GMT」——那是**测量假象**：bash 的前缀赋值
       没进到 Windows 子进程(env 里根本没有 TZ)。改用 spawnSync({env}) 当场重测，六个区名
       全部 rc=0 且偏移各异(America/New_York -5h、Kiritimati +14h、Shanghai +8h)。
       教训：环境类判据必须用与产品同一条注入路径来量。 */
    const probePath = (await import('node:url')).fileURLToPath(new URL('tz-probe.test.mjs', import.meta.url));
    const zones = ['', 'UTC', '-0500', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Shanghai'];
    const diverged = [];
    for (const z of zones) {
      const env = { ...process.env };
      if (z === '') delete env.TZ; else env.TZ = z;
      const r = spawnSync(process.execPath, [probePath], { encoding: 'utf8', env });
      const m = /PROBE (\{.*"tz".*\})/.exec(r.stdout || '');
      assert.ok(m, (z || '<未设>') + ' 子进程没吐判据行 rc=' + r.status
        + ' out=' + String(r.stdout).slice(-160) + ' err=' + String(r.stderr).slice(-200));
      const got = JSON.parse(m[1]);
      assert.equal(got.tz, z, (z || '<未设>') + ' 子进程里的 TZ 读不回来，桩不可信: ' + JSON.stringify(got));
      /* 这一刻的本地月份只有 12(比北京早一天)才说明该宿主能暴露缺陷；其余宿主本地==北京，
         断言 got==[2026,1] 属于恒真巧合，单独计数点名。 */
      if (got.localMonth === 12) {
        diverged.push(z || '<未设>');
        assert.deepEqual(got.got, [2026, 1], (z || '<未设>') + ' 宿主上「本月」锚到了主机本地年月: ' + JSON.stringify(got));
      } else {
        assert.equal(got.got[0] * 100 + got.got[1], 202601, (z || '<未设>') + ' 读数不是北京 2026-01: ' + JSON.stringify(got));
      }
    }
    console.log('  分叉宿主(本地比北京早一天，真正验到缺陷): ' + diverged.join(', ')
      + ' ｜ 仅巧合通过的宿主数: ' + (zones.length - diverged.length));
    /* 反向钉子：至少一个非东八区宿主真的被测到，否则这一条等于没跑(上一版就是这么全绿的)。 */
    assert.ok(diverged.length >= 1, '没有任何宿主出现本地/北京分叉，判据恒真: ' + JSON.stringify(zones));
  });
} else {
  test('跨年那一刻，换宿主时区「本月」仍锚到北京的一月(opt-in 子进程)', () => {
    console.log('  - 跳过：设 MINGLI_TZ_SUBPROCESS=1 才跑(每个宿主时起一个子进程)');
  });
}

describe('服务端相对时间锚点走北京口径', () => {
  test('桩自证：本地读数与北京口径确实分叉(否则下面的期望值恒真)', () => {
    asUtcHost(() => {
      const now = new Date();
      assert.equal(now.toISOString().slice(0, 10), '2025-12-31', '时钟桩没生效，读到的是真表');
      assert.equal(now.getFullYear(), 2025, '桩的本地年应与北京年分叉');
      assert.equal(now.getMonth() + 1, 12, '桩的本地月应与北京月分叉');
    });
    /* 显式传时刻的四条走真表：钉的是「北京年月」本身，且换宿主时区读数不变(见下一个用例)。
       期望值当场由北京日历推出：15:59:59Z 仍是旧一天，16:00:00Z 起北京已是新一天。 */
    assert.equal(extractWhen('本月财运', new Date('2025-12-31T15:59:59.000Z')).month, 12);
    assert.equal(extractWhen('本月财运', new Date(CROSS_YEAR_UTC)).month, 1);
    assert.equal(extractWhen('本月财运', new Date('2026-01-31T15:59:59.000Z')).month, 1);
    assert.equal(extractWhen('本月财运', new Date(CROSS_MONTH_UTC)).month, 2);
  });

  test('跨年那一刻，宿主时区上「本月」都锚到北京的一月', async () => {
    /* 这一条是判据的真钉子。上一版写成「换 TZ 跑子进程 + 显式传 now」，实测在变异体下
       三个时区仍给出同串(全绿) —— 因为产品拿到的是同一个 Date 对象，换宿主时区不会改变它；
       而修好后的 chinaParts 只读 UTC 字段，本来就跟 TZ 无关。那个矩阵结构上看不见缺陷。
       现在改成：只把「此刻」钉在跨年那一刻(不改字段读法)，让产品的默认参 new Date()
       取值。走本地字段的写法会读出旧一月(变异体实测 month=12)，北京口径读出 1。
       ⚠ 本进程只能有一个宿主时区(Node 启动时就把 TZ 定死了)，所以这里钉的是「当前宿主」，
       另外两个时区的读数由下面那条 opt-in 的子进程用例覆盖。 */
    const r = await withPinnedInstant(() => extractWhen('本月财运'));
    assert.equal(r.month, 1, '宿主(' + (process.env.TZ || '系统默认') + ')上「本月」锚到了主机本地月: ' + JSON.stringify(r));
    assert.equal(r.year, 2026, '宿主上月份锚定的年份不是北京年: ' + JSON.stringify(r));
    /* 反向对照：同一台桩时钟下按本地字段拼 —— 只有宿主不在东八区时才会与北京分叉，
       所以这条按宿主条件打响，绝不当成无条件判据(上一版无条件写死 2025-12，在东八区必红)。 */
    const localShape = await withPinnedInstant(() => {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    });
    if (localShape === '2025-12') {
      assert.notEqual(JSON.stringify([r.year, r.month]), JSON.stringify([2025, 12]), '对照分叉了但产品读数也跟着分叉');
    } else {
      assert.equal(localShape, '2026-01', '东八区宿主的本地读数应等于北京读数: ' + localShape);
    }
  });

  test('跨年那一刻，UTC 主机上「今年/下个月/上个月」与扫年起点仍锚到北京年月', () => {
    asUtcHost(() => {
      assert.equal(extractWhen('今年财运如何').year, 2026, '「今年」锚到了主机本地年');
      assert.equal(extractWhen('本月注意什么').month, 1, '「本月」锚到了主机本地月');
      assert.equal(extractWhen('本月财运').year, 2026, '月份锚定的年份用了本地年');
      assert.equal(extractWhen('下个月运势').month, 2, '「下个月」不是北京月+1');
      assert.equal(extractWhen('上个月运势').month, 12, '北京 1 月的上月是去年 12 月');
      const scan = extractWhen('什么时候能升职');
      assert.equal(scan.scan, true, '这句应走扫年分支');
      assert.equal(scan.from, 2026, '扫年起点退到了主机本地年');
      const plan = analyzeQuestion('我什么时候能发财', []);
      assert.equal(plan.scanFrom, 2026, '检索计划带出的窗口起点不是北京年');
    });
  });

  test('取证层的扫年兜底(scanFrom 缺失)也按北京年起窗', () => {
    const db = openDatabase(':memory:');
    insertRecord(db, {
      id: 'r1', userId: 'u1', name: '张三', gender: 'male', birthYear: 1984, birthMonth: 2,
      createdAt: '2025-01-01', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
      nonAiResult: { solarDate: '1984-02-06', dayMaster: '庚', zodiac: '鼠', greatFortunes: [], annualFortunes: [], monthlyFortunes: [] },
      aiStatus: 'completed', aiTasks: {},
    });
    const rec = getRecordById(db, 'r1');
    try {
      /* 夹具前提当场核对：这条计划确实没带 scanFrom，才走得到产品里的 ?? 兜底。 */
      const plan = { topics: ['财运'], scan: true };
      assert.equal(plan.scanFrom, undefined, '夹具前提：scanFrom 必须缺失');
      const ev = asUtcHost(() => collectEvidence(db, rec, plan, { providers: [] }));
      const text = ev.missing.join('\n');
      assert.ok(text.includes('2026年至' + (2026 + SCAN_YEARS - 1) + '年'), '取证窗口起点不是北京年(UTC 主机上前移一年): ' + text);
      assert.equal(text.includes('2025年'), false, '窗口里混进了主机本地年的读数: ' + text);
    } finally { db.close(); }
  });

  test('源码层钉子：chat.mjs 不再用宿主时区字段取年月', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../chat.mjs', import.meta.url), 'utf8');
    const code = src.split(/\r?\n/)
      .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, ''))
      .filter((l) => /now\.get|chinaParts|scanFrom/.test(l));
    const localReads = code.filter((l) => /now\.get(FullYear|Month|Date)\(\)/.test(l));
    assert.deepEqual(localReads, [], '仍有按宿主时区取年月的行:\n' + localReads.join('\n'));
    assert.ok(code.length > 3, '扫描面为空，判据恒真');
  });
});
