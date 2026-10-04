/** 北京时间口径判据：utils/date ↔ 详情页「今天落在哪一运」↔ 窗口起点
 *
 * 这条链此前是判据空白：三处都用「今天」，但两处走 utils/date(显式 +8 小时后取 UTC 字段)，
 * PersonDetail 的两处 todayYmd 却直接读设备本地字段。jsdom/桌面跑在 UTC 或别的时区时，
 * 「UTC 16:00 之后北京已是次日」这一整天里，起运文案与大运表高亮会相对窗口起点、
 * 流年锚点错一天 —— 年末交运的人会被整段报成上一柱。
 *
 * 判据分三层，缺一层就会被变异绕过：
 * ① utils/date ↔ Intl 对账(参照系独立，不是我自己重写一份换算)；
 * ② 语义层：把产品两行「逐字抠出来、只把时钟换成可控桩」再求值 ——
 *    这样「改成 chinaYmd 但模块内部算错」和「干脆退回本地读法」都能杀；
 * ③ 源码层钉子：行数、不许出现本地 getFullYear/getMonth/getDate、必须经共享模块、
 *    大运表年份参数同源。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chinaDateParts, chinaYmd, chinaYear, chinaYearMonth } from '../utils/date';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const detailSrc = readFileSync(resolve(repo, 'client/src/features/person/PersonDetail.tsx'), 'utf8').replace(/\r\n/g, '\n');

/** 用 Intl 独立算出某时刻在北京的 ISO 日期(YYYY-MM-DD) —— 判据的第三方参照。 */
function beijingYmd(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 抠产品源码里的 `const 名字 = <右值>` —— 只认声明(带 const)，别误抓赋值语句。 */
function declRhs(name: string, src: string): string {
  const re = new RegExp('const ' + name + '(?![\\w.])\\s*=\\s*([^;\\r\\n]+)');
  const ms = [...src.matchAll(new RegExp(re.source, 'g'))];
  if (ms.length !== 1) throw new Error(`产品里 const ${name} 命中 ${ms.length} 次(应为 1)，判据得跟着改`);
  return ms[0][1].trim();
}

/** 把一行表达式在隔离作用域里求值(传入产品自己模块的绑定)。
 *  第二参非空时把其中的 new Date() 换成该时刻 —— 测的是产品那行拼装式本身。 */
// eslint-disable-next-line no-new-func
const runExpr = (expr: string, scope: Record<string, unknown>, at?: Date): unknown => {
  const names = Object.keys(scope);
  if (at) { names.push('__AT__'); scope = { ...scope, __AT__: at }; }
  const body = at ? expr.split('new Date()').join('__AT__') : expr;
  return Function(...names, '"use strict";return (' + body + ');')(...names.map((n) => scope![n]));
};

/** 消费点一(起运文案)：产品那一行的右值，逐字求值。 */
const productTodayYmd = (today: Date): string => String(runExpr(declRhs('todayYmd', detailSrc), { chinaYmd }, today));
/** 消费点二(大运表)：today0 / todayYmd0 两行，以及传给 findCurrentFortune 的年份参数。 */
const productTodayYmd0 = (today: Date): { today0: { year: number }; ymd: string; yearArg: number } => {
  const today0 = runExpr(declRhs('today0', detailSrc), { chinaDateParts }, today) as { year: number };
  const ymd = String(runExpr(declRhs('todayYmd0', detailSrc), { String, today0 }, today));
  return { today0, ymd, yearArg: today0.year };
};
/* —— 非 +08 设备模拟器 ——
   本机是东八区，「本地读法」与北京口径同值，直接传参根本区分不出两种写法；
   缺陷只在 UTC/欧美设备上暴露。所以这里不改被测代码，而是改它读的时钟：
   造一个 Date 桩，无参构造钉在跨年那一刻，且本地 getFullYear/getMonth/getDate 返回 UTC 读数。
   桩自带落地自检，未生效就抛错，绝不让判据静默恒真。 */
const TLM_UTC_BOUNDARY = '2025-12-31T16:00:00Z';
class UtcDeviceDate extends Date {
  constructor(value?: unknown) {
    super(typeof value === 'undefined' ? TLM_UTC_BOUNDARY : value as string | number | Date);
  }
  /* 只覆盖「本地字段」这一族读法，getUTC* 与 getTime 保持真实行为 */
  getFullYear(): number { return this.getUTCFullYear(); }
  getMonth(): number { return this.getUTCMonth(); }
  getDate(): number { return this.getUTCDate(); }
  getDay(): number { return this.getUTCDay(); }
  getHours(): number { return this.getUTCHours(); }
  getMinutes(): number { return this.getUTCMinutes(); }
}
{
  const p = new UtcDeviceDate();
  if (p.getFullYear() !== 2025 || p.getMonth() !== 11 || p.getDate() !== 31) throw new Error('UTC 设备桩没生效，判据会恒真');
  if (new Date(TLM_UTC_BOUNDARY).getFullYear() === p.getFullYear()) throw new Error('桩与原时刻本地读数相同，区分不出两种口径');
}

/** 把全局 Date 换成 UTC 设备桩后执行(产品那两行写的是 new Date())。 */
function onUtcDevice<T>(run: () => T): T {
  const real = globalThis.Date;
  (globalThis as { Date: unknown }).Date = UtcDeviceDate as unknown as DateConstructor;
  try { return run(); } finally { (globalThis as { Date: unknown }).Date = real; }
}

/** 抠出某个调用「还没被定位串写出的」实参表达式数组。`fn` = 函数名，`prefix` = 逐字对源码的
 *  前缀实参(含结尾逗号，如 `result, nowYear, `；传空串则返回全部实参)。返回值下标 0 就是
 *  紧跟在 prefix 之后的那一参 —— 所以「整串里第几参」要自己在表里数清楚(见 CALL_SITES 注释)。
 *  为什么要连声明一起求值：上一版 B6(年份参数改回本地读法)只钉变量名而整轮全绿存活 ——
 *  「抽出来的变量看起来对」不等于「传进去的就是它」，所以判据直接读调用点。
 *  为什么不用正则抠实参：实参本身可能是 `chinaYear(new Date())`，上一版用 [^,)]+ 抠它，
 *  截到 `chinaYear(new Date(` 就 SyntaxError，判据当场失效(好在这次是响亮地红，不是静默恒真)。
 *  扫描用状态机且深度从函数左括号记起，闭包里的逗号(.map((items) => …))不会被误当分隔符。
 *  产品里同名调用可以有多处(findCurrentFortune 就有两处)，所以逐个命中都试抠一遍，再用 `want`
 *  (整个调用里的第几参，1 基)挑出想要的那一参；`want` 必须恰好命中 1 处。 */
function callArg(fn: string, prefix: string, want: number): string {
  const anchor = fn + '(' + prefix;
  const starts: number[] = [];
  let i = detailSrc.indexOf(anchor);
  while (i >= 0) { starts.push(i); i = detailSrc.indexOf(anchor, i + 1); }
  if (!starts.length) throw new Error(`调用点 ${anchor} 命中 0 次，判据的定位串对不上产品源码`);
  const given = prefixCount(prefix);        // 定位串里已写出的实参个数
  const hits: string[] = [];
  for (const at of starts) {
    const args = tryArgs(at, fn, prefix, anchor);
    if (!args) continue;
    const idx = want - given - 1;           // want 是 1 基；args[0] 是第 given+1 参
    if (idx >= 0 && idx < args.length) hits.push(args[idx]);
  }
  if (hits.length !== 1) {
    throw new Error(`调用点 ${anchor} 里「整串第 ${want} 参(定位串已写出 ${given} 参)」命中 ${hits.length} 次(应为 1)，定位串得写得更具体`);
  }
  return hits[0];
}
/** prefix(函数左括号之后、定位串写出的那段)里有几个实参：顶层逗号数 + 1；空串 → 0。 */
function prefixCount(prefix: string): number {
  const body = prefix.replace(/,\s*$/, '');   // 尾随逗号只是「后面还有参数」的记号
  if (!body.trim()) return 0;
  let depth = 0, commas = 0;
  for (const ch of body) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) commas++;
  }
  if (depth !== 0) throw new Error(`定位串前缀 ${prefix} 括号不配对，判据得跟着改`);
  return commas + 1;
}
/** 从这个命中位置尝试抠实参；抠不出(括号提前闭合/结尾不是逗号)就返回 null 交给下一个命中。 */
function tryArgs(at: number, fn: string, prefix: string, anchor: string): string[] | null {
  const firstOpen = at + fn.length;
  if (detailSrc[firstOpen] !== '(') return null;
  /* 定位串末字符允许带尾随空白；沿串逐字符推进深度：函数左括号记 1，之后每对括号 ±1。 */
  let end = at + anchor.length - 1;
  while (end > firstOpen && /\s/.test(detailSrc[end])) end--;
  let depth = 0;
  for (let k = firstOpen; k <= end; k++) {
    const ch = detailSrc[k];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (depth === 0) return null;   // 这处调用的括号已闭合，抠不到后续实参
  }
  if (!',([{'.includes(detailSrc[end])) return null;
  let j = end + 1;
  while (j < detailSrc.length && /\s/.test(detailSrc[j])) j++;
  let from = j;
  const args: string[] = [];
  for (; j < detailSrc.length; j++) {
    const ch = detailSrc[j];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 1) break; depth--; }
    else if (ch === ',' && depth === 1) { args.push(detailSrc.slice(from, j).trim()); from = j + 1; }
  }
  args.push(detailSrc.slice(from, j).trim());
  return args.length ? args : null;
}
/** 把产品里「今天」的每一处真实调用实参抠出来，在 UTC 设备桩时钟上逐一求值。
 *  「抽出来的变量看起来对」不等于「传进去的就是它」——上一版 B6(年份参数改回本地读法)
 *  就是因为只钉了变量名而整轮全绿存活；这一版直接读调用点，且作用域里放的是
 *  「产品那一行的声明」而不是我塞进去的现成值 —— 于是改动声明本身也能杀掉变异。
 *  桩时钟下 new Date() 就是跨年那一刻，等价于产品在非 +08 设备上的真实读数。 */
/** 三处「今天」消费点的定位串逐字写死在这里，一眼对得上产品源码。
 *  `want` = 整个调用里的第几参(1 基)；定位串里已写出的实参不返回，故 args 下标 = want − 已写出的个数：
 *  - luckStartText(result, 写了 1 参 → 要年份取 want=2(args[0])
 *  - findCurrentFortune(result, nowYear, 写了 2 参 → 要日期取 want=3(args[0])
 *  - findCurrentFortune(result, today0.year, 写了 2 参 → 要日期取 want=3(args[0])
 *  `scope` 是求值这一参用的作用域：
 *  - 'luck' —— 在 luckStartText 函数体里(只绑 chinaYmd/chinaDateParts/chinaYear/String)
 *  - 'page' —— 在详情页组件内(绑 String + 本地 Date 桩，today0/todayYmd0 由声明行求值) */
const CALL_SITES: Array<{ key: string; fn: string; pre: string; want: number; label: string; scope: 'luck' | 'page' }> = [
  { key: 'luckStartText.todayYmd', fn: 'findCurrentFortune', pre: 'result, nowYear, ', want: 3, label: '起运文案内部的日期', scope: 'luck' },
  { key: '起运.luckStartText.nowYear', fn: 'luckStartText', pre: 'result, ', want: 2, label: '起运那一栏传给文案的年份', scope: 'page' },
  { key: '大运表.todayYmd', fn: 'findCurrentFortune', pre: 'result, today0.year, ', want: 3, label: '大运表高亮的日期', scope: 'page' },
];
function productCallArgs(): Record<string, string | number> {
  const built = onUtcDevice(() => ({
    parts: chinaDateParts(new Date()),
    ymd: chinaYmd(new Date()),
    year: chinaYear(new Date()),
  }));
  /* 共享模块的三个出口：用同一台桩时钟算出的读数当返回值，产品表达式里再调它们。 */
  const moduleBindings: Record<string, unknown> = {
    chinaYmd: () => built.ymd, chinaDateParts: () => built.parts, chinaYear: () => built.year, String,
  };
  /** 在产品源码里按「声明 → 使用」的原样顺序求值若干行，返回最后一次的绑定表。
   *  today0 是对象(chinaDateParts 的返回)，todayYmd/todayYmd0 是标量 —— 类型判据分开看，
   *  否则「把 today0 改成字符串」这类变异会撞在断言消息里而不是被判据红。 */
  const evalLines = (names: string[], extra: Record<string, unknown>): Record<string, unknown> => {
    const scope: Record<string, unknown> = { ...moduleBindings, ...extra };
    for (const name of names) {
      const rhs = declRhs(name, detailSrc);
      let v: unknown;
      try {
        // eslint-disable-next-line no-new-func
        v = Function(...Object.keys(scope), '"use strict";return (' + rhs + ');')(...Object.values(scope));
      } catch (e) {
        throw new Error(`${name} = ${rhs} 求值失败: ${(e as Error).message}`);
      }
      if (name === 'today0') {
        if (!v || typeof v !== 'object' || typeof (v as { year?: unknown }).year !== 'number') {
          throw new Error(`today0 求值得到 ${JSON.stringify(v)}，不是 {year,month,day}(判据得跟着改)`);
        }
      } else if (typeof v !== 'number' && typeof v !== 'string') {
        throw new Error(`${name} 求值得到 ${Object.prototype.toString.call(v)}，不是数字或日期串(判据得跟着改)`);
      }
      scope[name] = v;
    }
    return scope;
  };
  /** `want` 是整个调用里的第几参(1 基)，由 callArg 换算并校验命中唯一。
   *  求值时把全局 Date 换成 UTC 设备桩，于是 `new Date().getFullYear()` 读到的是 UTC 年(2025)，
   *  而 `chinaYear(new Date())` 走模块导出的北京口径桩(2026) —— B8 这类变异就此杀掉。 */
  const readArg = (fn: string, pre: string, want: number, label: string, scope: Record<string, unknown>): string | number => {
    const expr = callArg(fn, pre, want);
    if (!expr) throw new Error(`调用点 ${label} 的实参抠出来是空串，判据得跟着改`);
    const v = onUtcDevice(() => runExpr(expr, scope));
    if (typeof v !== 'number' && typeof v !== 'string') {
      throw new Error(`调用点 ${label} 的实参 ${expr} 求值得到 ${Object.prototype.toString.call(v)}，不是数字或日期串`);
    }
    return v;
  };
  /* luckStartText 内部：todayYmd 那一行的声明 + findCurrentFortune 的日期实参。
     nowYear 是形参，由调用方给，这里给桩时钟下的北京年 —— 要钉的是函数体自己那行读数。 */
  const scopes = {
    luck: evalLines(['todayYmd'], { result: {}, nowYear: built.year }),
    page: evalLines(['today0', 'todayYmd0'], { result: {}, String }),
  };
  /* 定位串必须逐字对上产品源码，否则 callArg 命中 0 次直接抛错(而不是静默放行)。
     两处 findCurrentFortune 的年份参数写法不同(一处形参 nowYear、一处 today0.year)，
     所以各用「函数名 + 各自的前缀实参」定位，才说得出要钉哪一参。 */
  const out: Record<string, string | number> = {};
  for (const s of CALL_SITES) out[s.key] = readArg(s.fn, s.pre, s.want, s.label, scopes[s.scope]);
  // 消费点数量自证：产品里若新增/删除了一处「今天」的消费点，这张表就得跟着改
  if (CALL_SITES.length !== 3) throw new Error('消费点表被改动，判据要重新对齐产品源码');
  return out;
}

describe('北京时间口径：跨年/跨日的「今天」必须与排盘引擎同源', () => {
  it('utils/date 的三个函数与 Intl 的 Asia/Shanghai 读数一致', () => {
    // 落地自证：参照函数自己得先是对的 —— 用一个已知时刻钉住它
    expect(beijingYmd(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
    expect(beijingYmd(new Date('2025-12-31T16:00:00Z'))).toBe('2026-01-01');

    for (const iso of [
      '2025-12-31T15:59:59.000Z',   // 北京仍是年内最后一天
      '2025-12-31T16:00:00.000Z',   // 北京已跨年
      '2026-10-04T15:59:59.000Z',
      '2026-10-04T16:00:00.000Z',
      '2026-02-28T16:30:00.000Z',
    ]) {
      const at = new Date(iso);
      const ref = beijingYmd(at);
      expect(chinaYear(at), 'chinaYear 在 ' + iso + ' 上不等于北京年').toBe(Number(ref.slice(0, 4)));
      const ym = chinaYearMonth(at);
      expect([ym.year, ym.month], 'chinaYearMonth 在 ' + iso + ' 上不等于北京年月')
        .toEqual([Number(ref.slice(0, 4)), Number(ref.slice(5, 7))]);
      const p = chinaDateParts(at);
      expect([p.year, p.month, p.day], 'chinaDateParts 在 ' + iso + ' 上不等于北京年月日')
        .toEqual([Number(ref.slice(0, 4)), Number(ref.slice(5, 7)), Number(ref.slice(8, 10))]);
      expect(chinaYmd(at), 'chinaYmd 在 ' + iso + ' 上不等于北京日期').toBe(ref);
    }
  });

  it('详情页两处「今天」按北京口径取值：UTC 设备在跨年那一刻仍读北京日期', () => {
    // 前提自证：桩确实让本地读法与北京口径分叉(否则本用例恒真)
    const boundary = new Date(TLM_UTC_BOUNDARY);
    expect(boundary.getFullYear(), '本机应是东八区，否则 UTC 桩区分不出两种口径').toBe(2026);
    expect(beijingYmd(boundary)).toBe('2026-01-01');

    // 语义层：产品在「设备本地还是旧年、北京已跨年」的机器上必须给出北京的日期
    expect(onUtcDevice(() => productTodayYmd(new Date())), '起运文案的 todayYmd 用的是设备本地日期(会错一天)').toBe('2026-01-01');
    const second = onUtcDevice(() => productTodayYmd0(new Date()));
    expect(second.ymd, '大运表的 todayYmd0 用的是设备本地日期(会错一天)').toBe('2026-01-01');
    expect(second.yearArg, '大运表退回整数年区间时用的年份不是北京年').toBe(2026);

    // 消费点自证：把产品「声明 + 调用」整段在桩时钟上跑一遍，钉真实传进去的实参
    const args = productCallArgs();
    expect(args['luckStartText.todayYmd'], '起运文案内部算出的今天在 UTC 设备上读成了本地日').toBe('2026-01-01');
    expect(args['起运.luckStartText.nowYear'], '起运那一栏传给文案的年份在 UTC 设备上读成了本地年').toBe(2026);
    expect(args['大运表.todayYmd'], '大运表高亮的日期实参在 UTC 设备上读成了本地日').toBe('2026-01-01');

    // 反向对照：同一时刻若真按设备本地字段拼，得到的就是旧的一天 —— 证明上面三条不是恒真
    const localShape = declRhs('todayYmd0', detailSrc).split('today0.year').join('2025')
      .split("String(today0.month).padStart(2, '0')").join("'12'")
      .split("String(today0.day).padStart(2, '0')").join("'31'");
    expect(localShape, '反向对照式没落地').toContain('2025');
    expect(Function('"use strict";return (' + localShape + ');')()).toBe('2025-12-31');

    // 边界另一侧不能修过头：北京仍在旧年的那一刻仍须是旧年
    const before = new Date('2025-12-31T15:59:59.000Z');
    expect(productTodayYmd(before)).toBe('2025-12-31');
    expect(productTodayYmd0(before).ymd).toBe('2025-12-31');
    expect(onUtcDevice(() => productTodayYmd(new Date(before)))).toBe('2025-12-31');
  });

  it('源码层钉子：两行 todayYmd 都走共享模块，不再直接读本地时区字段', () => {
    const lines = detailSrc.split('\n').filter((l) => l.includes('const todayYmd') || l.includes('const todayYmd0'));
    expect(lines.length, '详情页的 todayYmd 行数变了(应仍为两处消费点)').toBe(2);
    for (const l of lines) {
      expect(l, 'todayYmd 仍在直接读本地时区字段：' + l.trim()).not.toMatch(/today\d?\.get(FullYear|Month|Date)\(\)/);
      expect(l, 'todayYmd 没走共享的北京口径：' + l.trim()).toMatch(/china(Ymd|DateParts)\(new Date\(\)\)/);
    }
    // 消费点也得同源：findCurrentFortune 收到的年份参数不许来自本地 getFullYear
    expect(detailSrc, '大运表高亮的年份参数用的是本地读法').not.toMatch(/findCurrentFortune\(result, today\d?\.getFullYear\(\)/);
    // 导入必须真的存在，否则上面的表达式只是看起来对
    expect(detailSrc, '详情页没导入北京口径模块').toMatch(/import \{[^}]*chinaYmd[^}]*\} from '\.\.\/\.\.\/utils\/date'/);
  });
});
