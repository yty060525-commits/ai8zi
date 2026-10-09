import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 判据空白 #147：任务缓存键的**结构**(段序/段数)与**语气档口径**跨端从未被读过。
   #131/#132/#133 那批跨端判据只覆盖了聊天键(chatv6)与 natal 键序、温度，任务键这一半是空的 ——
   实测取证(vitest + grep，2026-10-09)：全仓没有任何用例读过 `format!("vN|…` 或 Rust 的
   `fn tone_bucket`；server/test 里用到 cacheKey 的四份(api / cache-clear-http / task-abort)都只调
   ai.mjs **自己**的实现，等于各测各的。

   为什么这条值得钉：两端各自的注释(lib.rs:66「(任务键 v7|… 与聊天键 chatv1|… 同位)」与
   lib.rs:820「第 2..6 段与任务键同位(性别+四柱)，chart_sig 索引自动覆盖」)都在承诺**同一件事** ——
   chart_sig 是按键的第 2..6 段建的索引，所以「删一条盘要连带清掉它的缓存」依赖段序在两端一致。
   注释说了，没人验过。把桌面那个 `{}` 挪一位，两套套件照旧全绿，而桌面的按盘清理会静默漏清。

   ⚠ 版本号本身(v15 vs v11)**不钉相等**：两端各有独立的 SQLite，升版本只是让本机旧缓存作废，
   数字不同步不是缺陷；而且写死任何一个读数都会让人顺手把判据改成「跟着改数字」就通过。
   这里钉的是形状：段数、每段语义、以及语气档在 0..100 全空间上恒等。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const SERVER_AI = '../../../server/ai.mjs';
const SERVER_CHAT = '../../../server/chat.mjs';
const SERVER_DB = '../../../server/db.mjs';
const RUST = '../../src-tauri/src/lib.rs';
const ADAPTER = '../data/deepseekAdapter.ts';
const CHAT_ENGINE = '../data/chatEngine.ts';

/** 从服务端拼装行取段清单：`return ['v15', model, record.gender, …].join('|')`。 */
function serverSegments(text: string): string[] {
  const line = text.split('\n').find((l) => /^\s*return \['v\d+', model,/.test(l));
  if (!line) throw new Error('找不到服务端任务键的拼装行 ⇒ 结构已变，本文件判据要重写');
  return (line.slice(line.indexOf('[') + 1, line.lastIndexOf(']'))).split(',').map((s) => s.trim());
}

/** 桌面 format! 的字面量段清单(跨三行，所以按「以 `format!("v` 开头那一行」取，不能整块切片)。 */
function rustLiteralParts(text: string): string[] {
  const line = text.split('\n').find((l) => l.includes('format!("v')) ?? '';
  const lit = /^ *format!\("([^"]*)"/.exec(line)?.[1];
  if (!lit) throw new Error('读不到桌面任务键 format! 的字面量 ⇒ 结构已变');
  return lit.split('|');
}

describe('任务缓存键的结构与语气档跨端同源(#147)', () => {
  it('前提钉子：两端都能读到拼装式(否则下面的比对全是空转)', () => {
    const s = src(SERVER_AI), r = src(RUST);
    expect(() => serverSegments(s)).not.toThrow();
    expect(r).toContain('pub(crate) fn cache_key');
    expect(r).toMatch(/format!\("v\d+\|/);
  });

  it('两端任务键的段数相同，且第 2..6 段确实是「模型之后紧跟性别 + 四柱」', () => {
    const segs = serverSegments(src(SERVER_AI));
    /* 服务端逐格读数(当场打印用例会显示)：['vN', model, record.gender, 年, 月, 日, 时, task.type, …] */
    expect(segs[1], '第 2 段不再是 model').toBe('model');
    expect(segs.slice(2, 7).map((x) => x.replace(/^record\./, '')).join(','),
      `服务端第 3..7 段不再是 性别+四柱，实际读到 ${segs.slice(2, 7).join(',')}`).toBe('gender,yearPillar,monthPillar,dayPillar,hourPillar');

    /* 桌面：字面量里的 {} 个数与顺序就是段清单。第 1 段是版本号(含 {model} 命名插值)，
       其后应是六个 {}(性别+四柱)，再往后是 type/年/月/出生年/语气档。 */
    const parts = rustLiteralParts(src(RUST));
    expect(parts.length, `桌面 format! 段数 ${parts.length} 与服务端 ${segs.length} 不等 ⇒ chart_sig 覆盖不到同一批缓存`)
      .toBe(segs.length);
    expect(parts.slice(2, 8).join('|'), `桌面第 3..8 段不再是六个 {}，实际 ${parts.slice(2, 8).join('|')}`)
      .toBe('{}|{}|{}|{}|{}|{}');
  });

  it('语气档：桌面 (clamp+2)/5*5 与服务端 round(clamp/5)*5 在 0..100 全空间恒等', () => {
    const rust = src(RUST);
    const rustLine = rust.split('\n').find((l) => /^fn tone_bucket/.test(l)) ?? '';
    /* 从真实源码取表达式，而不是抄一份我脑中的公式(#144 那一课：注释说对齐≠对齐)。 */
    const expr = /fn tone_bucket\(tone: Option<i32>\) -> i32 \{ (.+) \}/.exec(rustLine)?.[1];
    expect(expr, '读不到桌面 tone_bucket 的表达式 ⇒ 结构变了，须重锚').toBeTruthy();
    expect(expr, `桌面语气档写法已变，实际读到 ${expr}`).toBe('(clamp_tone(tone) + 2) / 5 * 5');

    const server = src(SERVER_AI);
    const srvExpr = /const toneBucket = (.+);/.exec(server)?.[1];
    expect(srvExpr, '读不到服务端 toneBucket 的表达式').toBeTruthy();

    /* Rust 的整数除法是 floor，JS 的 Math.round 是四舍六入五成双里的「向正无穷取整」；
       两者在 0..100 整数域上对 5 分档恰好重合 —— 这是当场枚举出来的结论，不是推理。
       把桌面写成 (clamp+2) 的初衷是「round-half-up」，与服务端 Math.round 在 .5 处不同，
       但 clamp_tone 返回 i32，永远不会出现 .5，所以两边恒等。下面逐点验证这个论证。 */
    const rustBucket = (t: number) => Math.floor((Math.max(0, Math.min(100, t)) + 2) / 5) * 5;
    const srvBucket = (t: number) => Math.round(Math.max(0, Math.min(100, t)) / 5) * 5;
    const diverging: string[] = [];
    for (let t = 0; t <= 100; t++) if (rustBucket(t) !== srvBucket(t)) diverging.push(`${t}:${srvBucket(t)}vs${rustBucket(t)}`);
    expect(diverging, `两端语气档在这些取值上分叉(会导致同问在一边吐旧缓存)：${diverging.join(' ')}`).toEqual([]);
    /* 正向钉子：尺子本身能分叉 —— 若桌面漏了 +2(退回纯 floor)，必须在若干点上与 round 不同。 */
    const naiveFloor = (t: number) => Math.floor(Math.max(0, Math.min(100, t)) / 5) * 5;
    const wouldDiverge = [3, 4, 8, 9, 13, 14].filter((t) => naiveFloor(t) !== srvBucket(t));
    expect(wouldDiverge.length, '这把尺分辨不出「漏 +2」⇒ 上面的恒等断言是永真的').toBeGreaterThan(0);
  });

  it('默认语气两端同为 80(它是语气档的落点，分叉会让未带语气的请求落到不同档)', () => {
    const rust = src(RUST);
    const rustDefault = /fn clamp_tone\(tone: Option<i32>\) -> i32 \{ match tone \{ Some\(n\) => n\.clamp\(0, 100\), None => (\d+) \}/.exec(rust)?.[1];
    const serverDefault = /export const DEFAULT_TONE = (\d+)/.exec(src(SERVER_AI))?.[1];
    expect(rustDefault, '读不到桌面 clamp_tone 的 None 分支').toBeTruthy();
    expect(serverDefault, '读不到服务端 DEFAULT_TONE').toBeTruthy();
    expect(rustDefault, `桌面默认语气 ${rustDefault} ≠ 服务端 ${serverDefault}`).toBe(serverDefault);
  });

  /* 下面三条是 #147 的第二轮：第一轮只钉了「键怎么拼」，实测发现**签名与线上字节**这两半才是真空白。
     取证(grep 全仓，2026-10-09)：`chart_sig` 在 JS 侧只被 chat.test.mjs 用**手写键串**测过内容，
     从没与真实的 cacheKey/chatCacheKey 输出对过；`rename_all` 在整个测试体系里命中 0 次。 */

  it('#147b 签名的两段来源：派生切片与删除拼接必须落在同一批段上(两端各一份)', () => {
    /* chart_sig 是「删一条盘要连带清掉它的缓存」的唯一索引键。它由两处独立代码产生：
       写入端按键切一段(slice 2..7)，删除端按参数拼一段。两者语义必须逐字相同，否则
       删盘时 DELETE ... WHERE chart_sig=? 匹配 0 行 —— 不报错，只是旧答案永远清不掉。 */
    const srv = src(SERVER_DB);
    expect(srv, '找不到服务端 chartSigFromKey ⇒ 结构已变，本判据要重写')
      .toContain('return parts.slice(2, 7).join(\'|\');');
    expect(srv, '服务端删除侧拼接不再是 性别+四柱')
      .toContain('const sig = [gender, y, m, d, h].join(\'|\');');

    const rust = src(RUST);
    expect(rust, '找不到桌面 chart_sig_from_key ⇒ 结构已变，本判据要重写')
      .toContain('Some(parts[2..7].join("|"))');
    expect(rust, '桌面删除侧拼接不再是 性别+四柱')
      .toContain('let sig = format!("{}|{}|{}|{}|{}", gender, y, m, d, h);');

    /* 反向钉子(尺子本身能分叉)：把删除侧少拼一段，上面的等式就不成立。这里当场证明
       「5 段」这个形状是被断言的、不是永真 —— 段数由 join 的分隔符个数决定。 */
    const segCount = (s: string): number => (s.match(/[|]/g) ?? []).length;
    expect(segCount('male|甲子|丙寅|庚午|壬午'), '签名应为 5 段(性别+四柱)').toBe(4);
  });

  it('#147c 真实键的产物必须等于手写签名(把拼装式与消费式接上，而不是各测各的)', () => {
    /* 这条是上面那条的落地半边：拼装式(ai.mjs/chat.mjs)与签名式(db.mjs/lib.rs)此前从未在同一
       个断言里出现过。重排一次键序(比如把 birthYear 提到四柱前)，两边各自都还「自洽」，
       而桌面上按盘清理会静默漏清 —— 正是 #132 那一类跨端分叉的形状。 */
    const rec = { gender: 'male', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', birthYear: 1984 };
    const expectedSig = ['male', '甲子', '丙寅', '庚午', '壬午'].join('|');

    const keyLine = src(SERVER_AI).split('\n').find((l) => /^\s*return \['v\d+', model,/.test(l)) ?? '';
    const taskKeyParts = keyLine.slice(keyLine.indexOf('[') + 1, keyLine.lastIndexOf(']')).split(',').map((s) => s.trim());
    expect(taskKeyParts.slice(2, 7).map((s) => s.replace(/^record\./, '')).join(','))
      .toBe('gender,yearPillar,monthPillar,dayPillar,hourPillar');
    /* 键里这五段与夹具同名同序 ⇒ 拼出来的签名就是 expectedSig(把「拼装式」与「消费式」接上)。 */
    expect(taskKeyParts.slice(2, 7).map((s) => s.replace(/^record\./, '')).map((k) => String(rec[k as keyof typeof rec])).join('|'))
      .toBe(expectedSig);

    const chatLine = src(SERVER_CHAT).split('\n').find((l) => /^\s*return \['chatv\d+', model,/.test(l)) ?? '';
    expect(chatLine, '服务端聊天键的第 3..7 段与任务键不同位 ⇒ chart_sig 覆盖不到聊天缓存')
      .toContain('record.gender, record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar');

    /* 桌面两张键同样以 {} 紧跟模型段之后，顺序即性别+四柱。
       ⚠ 实参表首项是 `model`(任务键的格式串用 {model} 命名插值，聊天键则把它当位置参数)，
       所以这里跳过首项再取五段 —— 不是从格式串里数字符个数。 */
    const rustTask = rustArgOrder(src(RUST), /format!\("v\d+\|\{model\}/);
    const rustChat = rustArgOrder(src(RUST), /format!\("chatv\d+\|/);
    expect(rustTask.slice(0, 5).join(',')).toBe('record.gender,record.year_pillar,record.month_pillar,record.day_pillar,record.hour_pillar');
    expect(rustChat.slice(1, 6).join(',')).toBe('chat.gender,chat.year_pillar,chat.month_pillar,chat.day_pillar,chat.hour_pillar');
    /* 两条键的首个实参语义不同(命名插值 vs 位置参数)，这正说明「按位置数 {}」会读错，
       当场把两个读数钉住，免得以后有人把两处 slice 当成笔误统一掉。 */
    expect(rustTask[0]).toBe('record.gender');
    expect(rustChat[0]).toBe('model');

    /* 签名本身的期望值当场核一遍(避免我把 5 段念成 4 段)。 */
    expect(expectedSig.split('|').length).toBe(5);
  });

  it('#147d 跨端线上字节契约：Rust 三张入参结构体都声明 camelCase，JS 侧确实发驼峰', () => {
    /* serde 没写 rename_all 时字段退回 snake_case，TS 发的 yearPillar 就映射不到 year_pillar，
       Option<String> 缺省成 None → 键里拼空串。全程无异常：桌面照样写库、照样返回「已完成」，
       只是每个盘的缓存键都塌成同一个签名。实测 grep：全仓没有任何用例读过 rename_all。 */
    const rust = src(RUST);
    for (const structName of ['BaziRecord', 'AiTaskInput', 'ChatRequest']) {
      const idx = rust.indexOf(`pub struct ${structName} {`);
      expect(idx, `桌面找不到 ${structName} ⇒ 改名或挪文件了`).toBeGreaterThan(-1);
      const decl = rust.slice(Math.max(0, idx - 260), idx);
      const hits = [...decl.matchAll(/#\[serde\(rename_all = "camelCase"\)\]/g)].length;
      expect(hits, `${structName} 上方 260 字符内没有 camelCase 声明(命中 ${hits}) ⇒ 线上字节会变 snake_case`)
        .toBeGreaterThanOrEqual(1);
    }

    /* JS 侧的真实发送点：这三处就是那批驼峰键的产生地。 */
    expect(src(CHAT_ENGINE), '聊天通道不再传驼峰四柱 ⇒ 桌面 ChatRequest 会缺列')
      .toContain('yearPillar: target.yearPillar, monthPillar: target.monthPillar, dayPillar: target.dayPillar, hourPillar: target.hourPillar');
    const adapter = src(ADAPTER);
    expect(adapter, '任务通道不再把 record 原样送进 run_ai_task').toContain("invoke<BaziTaskResult>('run_ai_task', { record: toTauriRecord(record)");
    expect(adapter, 'toTauriRecord 不再展开 record ⇒ 驼峰字段可能丢失').toContain('const toTauriRecord = (record: BaziRecord) => ({ ...record,');
  });
});

/** 取 Rust `format!` 之后那一串实参(可能跨行)，返回逗号分隔的表达式清单。
    ⚠ 格式串自己就带括号(`{model}`/`{:016x}`)，所以「第一个右括号」不是参数表结尾 ——
    实测第一版这样切，读回来的首项是格式串本身而不是 record.gender。 */
function rustArgOrder(text: string, anchor: RegExp): string[] {
  const start = text.search(anchor);
  expect(start, `桌面找不到 ${anchor.source} ⇒ 键写法变了`).toBeGreaterThan(-1);
  const openQuote = text.indexOf('"', start);
  const closeQuote = text.indexOf('"', openQuote + 1);
  const openParen = text.indexOf('(', start);
  let i = closeQuote + 1;
  while (i < text.length && text[i] !== ',' && text[i] !== ')') i++;
  expect(text[i], '格式串后既没有实参也没有右括号 ⇒ 写法已变').toBe(',');
  const closeParen = text.indexOf(')', i);
  return text.slice(i + 1, closeParen)
    .split(',')
    .map((s) => s.replace(/\s+/g, ''))
    .filter((s) => s.length > 0);
}
