import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 语气滑杆是「本机 · 按盘」的偏好，产品注释把理由写得很清楚：record 会随同步上行服务器、
   再下发到别的设备，一旦把语气写进 record，这边给人甲调低语气，别人打开同一条盘也跟着变低。
   这条约束完全靠「写了哪几个键」维持，而 tone.test.ts 只测了全局那一个键(readTone/saveTone)：
     - pref.<id> / ran.<id> 两个派生键从没被断过；
     - 「不写 record.toneUsed」在测试里反而被**主动破坏**(decade-task-gate 夹具带着 toneUsed: 80)，
       所以删掉那行注释里的「不再写 toneUsed」、真把语气写回 record，全套件照样绿。
   这里补的是这两类判据：一层行为(键名互不污染 + 取值优先级)，一层源码(两条请求体不许带 toneUsed)。 */

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const DETAIL = '../features/person/PersonDetail.tsx';

const TONE_BASE = 'mingli.analysis.tone';
const GLOBAL_KEY = TONE_BASE;
const prefKey = (id: string): string => TONE_BASE + '.' + id;
const ranKey = (id: string): string => TONE_BASE + '.' + id + '.ran';

afterEach(() => { try { localStorage.clear(); } catch { /* 非浏览器环境忽略 */ } });

/** 从真实模块取按盘那几个函数(import 一次，四个函数共用同一份求值)。 */
async function toneFns(): Promise<typeof import('../features/person/PersonDetail')> {
  return import('../features/person/PersonDetail');
}

describe('语气是本机按盘的偏好：两个派生键各自独立', () => {
  it('pref.<id> 与 ran.<id> 落在两个不同的键上，互不覆盖', async () => {
    const m = await toneFns();
    m.saveRecordTone('p-a', 35);
    expect(localStorage.getItem(prefKey('p-a'))).toBe('35');
    // 选定值不该顺手改写「上次生成用的值」—— 后者是重跑判定的依据，被覆盖就等于永远命中缓存
    expect(localStorage.getItem(ranKey('p-a')), 'saveRecordTone 不该同时写 ran 键').toBeNull();
    m.markUsedTone('p-a', 60);
    expect(localStorage.getItem(ranKey('p-a'))).toBe('60');
    expect(localStorage.getItem(prefKey('p-a')), 'markUsedTone 不该反过来改用户选定的值').toBe('35');
    expect(localStorage.getItem(GLOBAL_KEY), '按盘的写入不许动全局默认').toBeNull();
  });

  it('另一条盘的值不会串过来', async () => {
    const m = await toneFns();
    m.saveRecordTone('p-a', 20);
    m.saveRecordTone('p-b', 95);
    expect(m.recordTone('p-a')).toBe(20);
    expect(m.recordTone('p-b')).toBe(95);
    expect(localStorage.getItem(prefKey('p-b'))).toBe('95');
  });

  /* 优先级是「本机选过 → 本机上次跑过 → 全局默认」。中间那一档专门给换设备/同步来的盘：
     本机没选过，但上次生成用的是某个非默认档，滑杆得显示那条档，否则会误导成「还能命中缓存」。 */
  it('取值优先级：本机选过 > 本机上次跑的 > 全局默认', async () => {
    const m = await toneFns();
    m.saveTone(70);                       // 全局默认改成 70
    expect(m.recordTone('p-new')).toBe(70);          // 新盘：落到全局
    m.markUsedTone('p-old', 15);                     // 这条盘本机跑过(用 15)，但没在滑杆上选过
    expect(m.recordTone('p-old')).toBe(15);
    m.saveRecordTone('p-old', 45);                   // 之后用户在滑杆上选了 45
    expect(m.recordTone('p-old')).toBe(45);
    expect(m.usedTone('p-old'), 'usedTone 只读 ran 键：它代表「上次真跑用的档」').toBe(15);
    expect(m.usedTone('p-never')).toBeUndefined();
    expect(m.usedTone(null)).toBeUndefined();
  });

  it('脏值(空串/非数字/越界)一律当没设过或夹到合法区间，不把 NaN 发给模型', async () => {
    const m = await toneFns();
    localStorage.setItem(prefKey('p-x'), '');
    expect(m.recordTone('p-x'), '空串不能读成 0').toBe(80);
    localStorage.setItem(prefKey('p-x'), 'abc');
    expect(m.recordTone('p-x')).toBe(80);
    localStorage.setItem(prefKey('p-x'), '999');
    expect(m.recordTone('p-x'), '越界要夹住，否则语气指令超出量表').toBe(100);
    m.saveRecordTone('p-y', -20);
    expect(Number(localStorage.getItem(prefKey('p-y')))).toBe(0);
  });
});

/* 行为判据管不到「往 record 上写字段」这件事 —— 那是一次新增赋值，只有读源码才看得见。
   实测：给下面任一处 body 加上 `toneUsed: currentTone`，现有 504 条用例全部仍绿。
   扫描必须剥掉行尾注释再匹配(记忆教训：注释里的删改说明会被自己的否定式判据扫红)——
   第 572/584 两行的注释原文就写着「不再写 toneUsed / 不把语气写进同步记录」。 */
const codeOnly = (line: string): string => line.split('//')[0];

describe('语气绝不写进会同步的 record', () => {
  it('详情页每一处 saveBaziRecord 落库都不带 toneUsed', () => {
    const calls = src(DETAIL).split('\n').map(codeOnly).filter((l) => /saveBaziRecord\(/.test(l));
    // 计数探针：扫到 0 条等于判据空转，先证明扫描真的命中了落库调用
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const l of calls) expect(l).not.toMatch(/toneUsed/);
  });

  /* 反钉：确认这条扫描真的能打响。同一行若真把语气写回 record，必须被上面那条拒绝。 */
  it('判据本身能识别出被污染的写法', () => {
    const dirty = "      const pending = await saveBaziRecord({ ...base, aiStatus: 'pending', toneUsed: currentTone });";
    expect(codeOnly(dirty)).toMatch(/saveBaziRecord\(/);
    expect(codeOnly(dirty)).toMatch(/toneUsed/);
    // 而产品现在那行带注释的版本，剥注释后不含 toneUsed
    const real = src(DETAIL).split('\n').find((l) => /aiStatus: 'pending'/.test(l));
    if (!real) throw new Error("找不到 aiStatus:'pending' 那次落库 —— 待推写法被改走了");
    expect(codeOnly(real)).not.toMatch(/toneUsed/);
  });
});
