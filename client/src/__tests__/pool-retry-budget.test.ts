import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOLDOWN_MS, FIXED_CONCURRENCY, fixedMapLimit, orchestrateBaziAnalysis } from '../data/baziOrchestrator';
import type { BaziAnalysisTask, BaziRecord } from '../types/domain';

/* 固定并发池的**三条钱账**，此前只有一处间接覆盖：
   · concurrency-pool.test.ts 的两条用例都断 `>= 23`，把「一条任务被打三次」也判成通过；
   · auto-retry-schedule.test.tsx 的 settleBatch 钉的是【缺陷 #111】(冷却窗未清空就分轮)，
     它观察调用数是否停住，不比对精确口数。
   于是 #108(每条一本账)、#110(退队条目放哪儿)两条修复本身没有判据 —— 全删掉仍全绿。
   这里用**直接调 fixedMapLimit** 的方式钉死：桩是可控的，不需要整盘排布，读数就是请求口数。 */

const THROTTLE = '请求过于频繁（已被限流）（HTTP 429 · DeepSeek）';
type Item = { id: string };
const failed = () => ({ status: 'failed' as const, error: THROTTLE });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 稳定窗：严格大于一个 COOLDOWN_MS(否则把池子自己的冷却读成「队列已空」，#111 同一课)，
 *  又小于两个窗 ⇒ 「批长 > 并发数却在一个窗内收尾」这种形态才是可判的。 */
const STABLE_MS = COOLDOWN_MS + 1500;

async function settledWithin(promise: Promise<void>, ms: number): Promise<'done' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const winner = await Promise.race([
    promise.then(() => 'done' as const),
    new Promise<'pending'>((r) => { timer = setTimeout(() => r('pending'), ms); }),
  ]);
  if (timer) clearTimeout(timer);
  return winner;
}

describe('固定并发池的重发账(#108 / #110 / #110b)', () => {
  /** 【实测订正 · jsdom 2026-10-07】冷却重发的次数上限来自 `requeued` 这个 WeakSet，而不是额度：
   *  · 删掉 runOne 里的 `spend(budgetOf?.(item))` ⇒ 读数不变(仍两口、仍等满三秒)，**行为不可观测**；
   *  · 删掉 runOne 退队那侧的 `!requeued.has(...)` 判据 ⇒ 滴灌到超时；
   *  · 删掉 pump 取用 pending 时补的那句 `requeued.add(item)` ⇒ 读数同样不变(两口)。
   *  ⚠ 第三句当时只测了「闸门仍在」这一半。【实测矩阵 · jsdom 2026-10-07】把这句 add **连同重发本身**
   *  一起删掉(S5 形态：pending 被清空但条目永不重发)时，本夹具仍然读出 `['a','a']`、仍然等满三秒 ——
   *  原因是 `spend` 无下限，余额被扣成负数后 step() 的即时重试循环照样能进(`attempt < cap` 不看余额)，
   *  于是那两口来自 step 而不是池子 ⇒ 「口数 + 耗时」分不清是谁发的。所以下面那条夹具钉子改成
   *  **budgetOf 返回 undefined**(与线上恒失败盘同一形态：两条固定池调用都没接账本)，此时两口
   *  只能来自池子的退队重发。S5 实测该形态读 `['a']`(一口)、正确码读 `['a','a']`。 */
  it('夹具钉子：一条限流任务恰好发两口、并等满一个冷却窗', async () => {
    const calls: string[] = [];
    const started = Date.now();
    await fixedMapLimit<Item>([{ id: 'a' }], 1, async (item) => { calls.push(item.id); return failed(); });
    expect(calls, '没有两口 ⇒ 要么没首发、要么退队重发被摘掉(S5 形态)或一次上限失效').toEqual(['a', 'a']);
    expect(Date.now() - started, '发了两口却没等冷却窗 ⇒ 第二条不是退队重发').toBeGreaterThanOrEqual(COOLDOWN_MS);
  });

  /** #108 的对账方向钉子：接上账本(budgetOf 给一口)后**仍然恰好两口**，且第二口必须等满冷却窗。
   *  【实测 A/B · jsdom 2026-10-07】同一形态在 S5(退队不重发)下读 `['a']`、正确码读 `['a','a']` ⇒
   *  这一格对 S5 也杀得住；它钉的是「把重发接进账本(#108 的方向)」之后重发不许凭空消失。 */
  it('接上账本后仍恰好两口：退队重发与本条额度同源(#108)', async () => {
    const calls: string[] = [];
    const started = Date.now();
    await fixedMapLimit<Item>([{ id: 'a' }], 1, async (item) => { calls.push(item.id); return failed(); }, () => ({ retriesLeft: 1 }));
    expect(calls, '接了账本就不重发 ⇒ #108 的对账写反了').toEqual(['a', 'a']);
    expect(Date.now() - started, '第二口没等冷却窗 ⇒ 它不是退队重发').toBeGreaterThanOrEqual(COOLDOWN_MS);
  });

  /** 【实测矩阵 · jsdom 2026-10-07】并发 8、每条一口即回、恒限流 —— 批长 n > c 时耗时是 ⌈n/c⌉ × COOLDOWN_MS：
   *    n=8 → 3.0s(一窗) | n=9 → 6.0s | n=10 → 6.0s | n=16 → 6.0s(两窗) | n=24 → 9.0s(三窗)
   *  ⇒ 「整批在一个收尾窗内 resolve」这种**耗时型**判据压根不存在(我前两版都红在正确代码上)，
   *  ⚠ **耗时型**判据在这里不可用(我前两版都红在正确代码上)：批长 n > c 时整批需要 ⌈n/c⌉ 个冷却窗，
   *    settledWithin(run, COOLDOWN_MS+1500) 对 n=c+1 的正确代码读出 'pending'(实测)。 */
  it('退队条目先抽干，未处理条目排在它后面(#110)', async () => {
    const c = FIXED_CONCURRENCY.scope;
    const items = Array.from({ length: c + 1 }, (_, i) => ({ id: 'k' + String(i) }));
    const calls: string[] = [];
    await fixedMapLimit<Item>(items, c, async (item) => { calls.push(item.id); return failed(); }, () => ({ retriesLeft: 1 }));
    expect(calls.length, '每条最多「首发 + 一次冷却重发」＝两口子').toBe((c + 1) * 2);
    expect(new Set(calls).size, '有任务一口都没发到').toBe(c + 1);
    // 实测正确读数：@0..@7 首发八条，@8..@15 是冷却重发的八条，第九条的两口排在最后。
    expect(calls.slice(c, 2 * c), '冷却重发没有先于未处理条目排空 ⇒ 退队条目被塞回了主队列').toEqual([
      'k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7',
    ]);
    expect(calls.slice(2 * c), '第九条的两口位置不对').toEqual(['k8', 'k8']);
  }, STABLE_MS + 3000);

  /** 【实测 · jsdom 2026-10-07】并发 2、四条各限流一口即回 —— 这一格能同时杀掉两种旧写法：
   *    正确代码  `["a","b","a","b","c","d","c","d"]`、6.0s 收尾
   *    queue.push → 退队的 a/b 被排到 c/d 之后 ⇒ `["a","b","c","d","a","b","c","d"]`(次序判据当场红)
   *    queue.unshift ⇒ 同样在 4.5s 的稳定窗里读不出差别(实测这一格对 unshift **存活**)，
   *                   它由上面那条「抽干次序」用例 + 下面那条结构用例合起来杀。
   *  ⚠ 稳定窗必须取**两个**冷却窗以上：批长 n > c 时整批需要 ⌈n/c⌉ 个窗才收尾(n=c+1 实测 6.0s)，
   *    我前两版都用了「一个窗多一点」的窗口 ⇒ settledWithin 对正确代码读出 'pending'，红在产品码上。 */
  it('小批量限流：整批在三个冷却窗内收尾，且未处理条目不被冷却条目插队(#110)', async () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const calls: string[] = [];
    const run = fixedMapLimit<Item>(items, 2, async (item) => { calls.push(item.id); return failed(); }, () => ({ retriesLeft: 1 }));
    expect(await settledWithin(run, COOLDOWN_MS * 3), '池子没收尾 ⇒ 退队条目被塞回长队列，running 永不归零').toBe('done');
    expect(calls, '抽干次序不对：冷却条目插到了未处理条目前面').toEqual(['a', 'b', 'a', 'b', 'c', 'd', 'c', 'd']);
  }, COOLDOWN_MS * 3 + 3000);

  /** #110b 的**结构**判据。行为层我原想用「并发 2 + 六条各两口」的发送次序去钉，实测**杀不掉**：
   *  `queue.unshift(item)` 与 `pending.push(item)` 在「恒失败 + 额度 1」下的口数/次序读数完全相同
   *  (unshift 只是让这条多占一轮冷却，仍然恰好两次)，见本文件末尾的变异记录。
   *  所以这里比对的是源码形态本身 —— 注释里写明的两条禁令必须在代码里成立。 */
  it('退队条目单独排队，既不 append 回主队列也不 unshift 到队首(#110b)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'baziOrchestrator.ts'), 'utf8');
    const pool = src.slice(src.indexOf('export async function fixedMapLimit'), src.indexOf('/** 进度条上的任务名'));
    expect(pool, '冷却重发被塞回主队列 ⇒ checkDone 永不为真，这一句 await 卡死').not.toMatch(/queue\.(push|unshift)\(/);
    expect((pool.match(/pending\.push\(/g) ?? []).length, 'pending 的入队点应唯一').toBe(1);
    expect((pool.match(/const pending: T\[\] = \[\];/g) ?? []).length, 'pending 声明应唯一').toBe(1);
    // 收尾判据必须同时看 queue 与 pending，否则冷却期仍会提前 resolve(静默丢任务)。
    expect(pool, 'checkDone 没把 pending 算进空队判据').toContain('running === 0 && queue.length === 0 && pending.length === 0');
  });

  /** #108 的**批次层**账：恒失败(可重试、非限流 ⇒ 不触发池子冷却)下，一整轮每条任务最多两口子 ——
   *  step() 首发 1 + 即时重试 1；补跑轮从**同一本账**取额度，余额已被主跑扣光 ⇒ 不该再发第三口。
   *  【实测 · jsdom 2026-10-07】补跑轮对**每条任务**都保证一次额外尝试(own.repairBudget，与主跑的
   *  own.budget 分账)，所以恒失败的一整轮每条是 **3 口**(首发 + 即时再试 + 补跑一口)、整轮 69 口。
   *  #108 的病灶不是「补跑不许发」，而是「补跑那份额度没和池子的退队重发对账」⇒ 批次逐轮变大
   *  (实测旧写法 92 → 20 → 46)。这一格钉的是**封顶**：多打的那一口必须记在补跑自己的账上、
   *  被退队重发共同扣减，而不是每条无限再试。retries:2 时同样恰 3 口(实测 69 口)——
   *  主跑额度更宽但补跑仍只有一口，这是 HEAD 两阶段各自的语义。 */
  it('整轮恒失败：每条两口子封顶(首发 + 补跑一口)，第三口正是 #121 的超发(#108 / #117)', async () => {
    const record = {
      id: 'budget-r1', name: '账本盘', gender: 'male', birthYear: 1984, birthMonth: 2,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
      aiStatus: 'not_started',
    } as unknown as BaziRecord;
    const counts = new Map<string, number>();
    const result = await orchestrateBaziAnalysis(record, async (task) => {
      counts.set(task.taskId, (counts.get(task.taskId) ?? 0) + 1);
      // 「上游服务返回五百」：过 isRetryableFailure(所以补跑会把它列进去)，但不算限流/超时(所以不进冷却重发)。
      return { task, status: 'failed' as const, error: '上游服务返回五百' };
    }, undefined, { retries: 1, retryDelayMs: 0 });
    const ids = [...counts.keys()];
    expect(result.aiStatus, '整轮恒失败却报完成').toBe('failed');
    expect(ids.length, '本轮被发起的任务条数(桩即时失败 ⇒ 无要点，总结不发)').toBe(23);
    // 【实测订正 · jsdom 2026-10-07】HEAD 读 3(首发 + 补跑首发 + 补跑再试，整轮 69)；#121 修好后
    //   step 的再试也查同一本账 ⇒ 主跑扣光就没有第三口 ⇒ 每条 2、整轮 46。这一格因此是 #121 的
    //   **行为**判据：把 `if (own.budget.retriesLeft <= 0) break;` 换回 `attempt < retries` 会红在这里。
    for (const id of ids) expect(counts.get(id), `${id} 本轮花掉的请求数不等于「首发 + 补跑一口」`).toBe(2);
    expect([...counts.values()].reduce((a, b) => a + b, 0), '整轮总口数不是 23×2 ⇒ 有任务被多打/少打').toBe(46);
  }, 60000);

  /** #117 的**结构**判据：补跑名单必须查**补跑阶段那本账**的余额，入队的必须是筛过的名单。
   *  ⚠ 我第一版把闸门写进 repairStep 函数体里、再用「闸门位置 < 第一次 attemptOnce 位置」来判 ——
   *    结果**红在正确代码上**(实测 expected 1773 to be less than 1690)：循环形态下第二次发口天然
   *    排在闸门之后，位置比较对 for/while 形态根本不成立。改成比对**入队名单那一行**。 */
  it('补跑名单带余额闸门：补跑账已光的任务不入名单(#117)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'baziOrchestrator.ts'), 'utf8');
    const lines = src.split(/\r?\n/);
    const decl = lines.filter((l) => /^\s*const repairable = stillFailed\.filter/.test(l));
    expect(decl.length, '补跑名单(repairable)的定义行数应唯一').toBe(1);
    // 当场核对闸门真在被测表达式里(不是同式重算)：这一行本身必须查补跑账的余额。
    expect(decl[0], '补跑名单没查补跑账余额 ⇒ 退队重发已扣光的条目仍被无条件重发').toMatch(/repairBudget\.retriesLeft\s*>\s*0/);
    // 入队的必须是这份筛过余额的名单；仍指向未筛的 stillFailed ⇒ 闸门形同不存在。
    const enqueue = lines.filter((l) => /fixedMapLimit<BaziAnalysisTask>\(.*repairStep/.test(l));
    expect(enqueue.length, '补跑入队那一句应唯一').toBe(1);
    expect(enqueue[0], '入队的是未筛余额的 stillFailed ⇒ 空账也被重发(#117)').toMatch(/\(\s*repairable\s*,/);
    expect(enqueue[0], '池子的退队重发没接进补跑那本账 ⇒ 补跑烧两口(#108)').toMatch(/roundOf\(t\.taskId\)\.repairBudget/);
  });

  /** #108 / #117 的**结构**判据：三处扣账必须都在，而且**两本账各归各的阶段**。
   *  删掉任何一句 `spend(...)`，行为层的读数都不变(实测订正见上面夹具钉子那句)，只有直接比对源码才看得见。 */
  it('扣账分两本：主跑与补跑各自 spend 同一条任务的账(#108 / #117)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'baziOrchestrator.ts'), 'utf8');
    // ⚠ 判据写法本身踩过一次坑：`^\s*spend\(.*\);\s*$` 在带行尾注释的那一句上**不命中**(注释里
    //   没有分号，`\s*$` 卡住)，实测只数到两处 ⇒ 把正确代码判成缺账。这里用「到行尾」而不是「到串尾」。
    // 【判据缺陷 #122 · 实测】`[^\n]*$`(gm)取出的片段**带着行尾那个孤立的 \r**(CRLF 文件)，于是后面
    //   所有按 `$` 锚定的比对都静默失效 —— 剥注释那条如此，将来任何「以分号结尾」之类的形状判据也如此。
    //   所以匹配就只用 `^[ \t]*spend\(` 定位行首，行尾一律先剥掉再比对。
    const spends = (src.match(/^[ \t]*spend\(.*$/gm) ?? []).map((l) => l.replace(/\r$/, ''));
    expect(spends.length, '扣账点应恰好三处(池子退队 / step 即时重试 / 补跑即时重试)').toBe(3);
    // ⚠ 第二次踩同一个坑：`/own\.repairBudget\b/` 在 :491 那句的**行尾注释**里也命中
    //   (`spend(own.budget); // …补跑另有 own.repairBudget`) ⇒ 数到 2、把正确代码判成缺账。
    //   源码类判据一律先剥行尾注释再比对(与上面「只在代码行里查 REPAIR_RETRIES」同一条纪律)。
    // 【判据缺陷 #122 · 实测】上面那条纪律自己没遵守：`/\/\/.*$/` 的 `$` 不带 m 时只认**串尾**，
    //   而按 `[^\n]*$` 取出的片段带着行尾那个孤立 `\r`(CRLF 文件)，于是整条 replace **静默不生效** ⇒
    //   注释里的 `own.repairBudget` 照样被当成代码命中(实测 expected 2 to be 1，红在正确代码上)。
    //   所以剥注释必须先按行切断再 replace；下面这条 codeOf 同时服务本格与 #120 那格。
    const codeOf = (line: string) => line.split(/\r?\n/)[0]!.replace(/\/\/.*$/, '').trim();
    // 正向钉子(#122)：剥注释这件事必须**当场能打响**。取一句真实带行尾注释的扣账行，要求剥完只剩调用本身 ——
    //   否则「注释里的名字被当成代码」这个失效形态又会静默回来(整格判据照样只数行数，看不出差别)。
    const withComment = spends.find((l) => /\/\//.test(l));
    expect(withComment, '夹具变了：没有一句扣账带行尾注释 ⇒ 下面这条钉子测不到东西').toBeTruthy();
    expect(codeOf(withComment!), '剥行尾注释没生效(多半是 CRLF 的孤立 \\r 让无 m 的 $ 锚不住)')
      .not.toMatch(/\/\//);
    expect(spends.filter((l) => /own\.budget\b/.test(codeOf(l))).length, '主跑那本账没被 step 扣到').toBe(1);
    expect(spends.filter((l) => /own\.repairBudget\b/.test(codeOf(l))).length, '补跑那本账没被补跑循环扣到 ⇒ 退队重发看不见它(#108)').toBe(1);
    expect(spends.some((l) => /budgetOf\?\.\(item\)/.test(l)), '池子的退队重发没接进账本').toBe(true);
    // 反向钉子：不许出现「给整批共用一份补跑次数」的旧形态 —— 那是 #108「每条固定烧三次、批次不收敛」的成因。
    // ⚠ 只在**代码行**里查，注释里就在解释这个名字；整串源码去查会红在解释删改的注释上。
    const codeLines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(codeLines.some((l) => /\bREPAIR_RETRIES\b/.test(l)), '又出现了整批共用的补跑次数常量 ⇒ 批次不收敛').toBe(false);
    // REPAIR_BUDGET 必须是**按条**记账的对象(出现在 roundOf 造的账本里)，不是整批共享的计数器。
    expect(codeLines.some((l) => /repairBudget:\s*\{\s*retriesLeft:\s*REPAIR_BUDGET\s*\}/.test(l)), '补跑额度没记进每条任务的账本').toBe(true);
  });

  /** 【缺陷 #120 · 实测订正】上面那条结构判据钉住了「三处扣账点」，却没钉住**扣法**：
   *  旧 spend 是无条件 `-= 1`，余额能被打成负数。我一度据此断言「#117 那道查余额的闸门读不出
   *  已经烧过的条目」，并用整盘恒超时桩去验 —— **预测是错的**，这里记下实测矩阵(jsdom 2026-10-07，
   *  task-01/02 两条固定池路径都接了 budgetOf，所以 step() 永远看不到被池子扣掉的余额)：
   *    · spend 去掉 `> 0`(旧写法)      ：retries:0 总口数 67、retries:1 总口数 90
   *    · 正确码(有下限)                ：与上面**逐字相同**(67 / 90)，task-01 读数也同为 2 / 3
   *    · 再把 scope 池改为共享 step() 那本账：仍为 67 / 90
   *    · 再给池子退队闸门加一道余额检查    ：46 / 69 ⇒ 只有这一形态才省钱
   *  ⇒ 「扣成负数」在当前接线方式下**行为不可观测**，spend 的下限只是防御性写法，不是缺陷修复；
   *  而「主跑把补跑额度扣光 ⇒ retries:0 的恒失败盘一整轮一条都不补跑」是**设计口径**(#117 有意为之)。
   *  这一格因此只钉扣法本身，不许在这里假称已经杀掉负余额形态。 */
  it('扣账必须有下限：余额不许被打成负数(#120 结构)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'baziOrchestrator.ts'), 'utf8');
    const line = src.split(/\r?\n/).filter((l) => /^\s*const spend = /.test(l));
    expect(line.length, 'spend 的定义行数应唯一').toBe(1);
    // 剥行尾注释后再比对(源码类判据的老坑：注释里就在解释这个名字)。
    // ⚠ #122：`line[0]` 来自 `split(/\r?\n/)`，没有孤立 \r，这里的 `$` 才真的能锚到行尾；
    //   若改成按 `[^\n]*$` 取片段(multicast match)，同一句 replace 会静默失效。
    const code = line[0]!.replace(/\/\/.*$/, '');
    expect(code, 'spend 里没有「余额为正」的下限闸门 ⇒ 无条件 -= 1 会把余额打成负数').toMatch(/retriesLeft\s*>\s*0/);
    expect(code, 'spend 没有扣减动作 ⇒ 闸门是空壳').toMatch(/retriesLeft\s*-=\s*1/);
    // 反向钉子：不许写成 `if (budget)` 后无条件扣(那正是旧形态，且能同时骗过上面两条正则)。
    expect(/if\s*\(\s*budget\s*\)\s*budget\.retriesLeft\s*-=/.test(code), '闸门被中性化成无下限扣减').toBe(false);
  });

  /** #109 的**结构**判据：补跑名单取自本轮账本，而不是开跑前那份 record.aiTasks 快照。
   *  行为层已有 orchestration.test.ts 的「repairs still-failing tasks」覆盖(删掉补跑整块会红)，
   *  但把这一行换成旧写法 `tasks.filter((task) => record.aiTasks?.[task.taskId]?.status === 'failed' ...)`
   *  时全仓没有任何用例读得出来 —— 实测缺陷 #109：并发 8、桩即时 resolve 时一轮发出 113 口，
   *  其中两遍各 23 口是**已经跑成功**的任务被当成仍失败整批重发，同一份结论最多买三次。 */
  it('补跑名单读本轮账本 aiTasks，不读开跑前的 record 快照(#109)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'baziOrchestrator.ts'), 'utf8');
    const line = src.split(/\r?\n/).filter((l) => /^\s*const stillFailed = tasks\.filter/.test(l));
    expect(line.length, 'stillFailed 的定义行数应唯一').toBe(1);
    // 当场核对判据真在被测表达式里(不是同式重算)：紧跟其后的那几行必须从 aiTasks 取条目。
    const at = src.split(/\r?\n/).findIndex((l) => /^\s*const stillFailed = tasks\.filter/.test(l));
    const block = src.split(/\r?\n/).slice(at, at + 5).join('\n');
    expect(block, '补跑名单没读本轮账本 ⇒ 主队列已成功的任务会被整批重发').toContain('const item = aiTasks[task.taskId]');
    expect(block, '读回了开跑前的快照 ⇒ 实测 #109 的两遍全量重发').not.toMatch(/record\.aiTasks\s*\?\.\[?task\.taskId/);
  });

  /** #104 / #106 的**行为**判据。此前两条只有注释里的「实测」，全仓没有任何用例读得出来：
   *  · 把退队那侧的 `!requeued.has(...)` 删掉(#104 形态)⇒ 上面三条抽干次序用例**全绿**(每条仍两口)，
   *    因为一口即回的桩压根进不了第二次冷却；只有让重发**挂住**才看得见。
   *  · 把 `!requeued.has(...)` 整句删掉(#106 形态：不设一次上限)⇒ 滴灌到超时。
   *  场景取最小可分叉形态：并发 2、两条恒限流、每条第二口在冷却窗内挂起(模拟真实网络在途)。
   *  【实测矩阵 · jsdom 2026-10-07】
   *      正确码            ['a','b','a','b']、≈一个冷却窗收尾
   *      M106(整句删闸门)  两口子之后继续滴灌 ⇒ 本用例与夹具钉子、两条 #110 用例同时红(4 条)
   *      M110a(push 回主队列) 抽干次序变 ['a','b','c','d',…] ⇒ 由上面两条 #110 用例杀
   *      M110b(unshift 队首)  次序变 ['a','b','b','a'] ⇒ 本用例与两条 #110 用例同红
   *  ⚠ 诚实交代：**只删退队那侧的 `!requeued.has(...)`、保留 requeued.add 这一形态(M104)，
   *    在本池里行为不可观测** —— 冷却重发发生在额度已被同一本账扣光之后，`spend` 把余额打成 -1，
   *    pump 取 pending 时那句 `requeued.add` 仍然补上标记 ⇒ 实测读数与正确码逐字相同(['a','b','a','b'])。
   *    这一格改由下面的结构判据钉(add 恰好两处 + 闸门存在)。 */
  it('冷却重发只认一次：挂住的条目仍被补发，且批次照常收尾(#104 / #106)', async () => {
    const calls: string[] = [];
    const started = Date.now();
    await fixedMapLimit<Item>([{ id: 'a' }, { id: 'b' }], 2, async (item) => {
      calls.push(item.id);
      if (calls.length <= 2) {
        // 头两口命中限流后，这一条在冷却窗内一直挂着(真实请求不会秒回)——
        // 它占着一个 worker，正好暴露「收尾判据是否只看 queue」的旧形态。
        await sleep(COOLDOWN_MS - 300);
        return failed();
      }
      return failed();
    });
    expect(calls, '每条恰好「首发 + 一次冷却重发」＝两口子；三口以上说明一次上限没生效(#106)').toEqual(['a', 'b', 'a', 'b']);
    expect(Date.now() - started, '没有等满冷却窗 ⇒ 第二条不是退队重发').toBeGreaterThanOrEqual(COOLDOWN_MS - 400);
  }, STABLE_MS + 2000);

  /** #104 唯一可用的判据(结构)：见上面用例注释的 M104 实测结论 —— 行为层杀不掉，只能比对源码。
   *  两处 `requeued.add` 各有分工：退队时补标记(让重发也进名单)、取用时补标记(让已重发的条目
   *  不再二次退队)。少任何一处都会让闸门失效；删退队侧 add 属 M104 形态(行为不可观测)，
   *  删取用侧 add 会让闸门永远为真(等价于 M106)，两者都由这里的计数与闸门判据杀掉。 */
  it('一次上限的两处登记都在：退队登记 + 取用登记 + 闸门(#104 结构)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'baziOrchestrator.ts'), 'utf8');
    const codeLines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(codeLines.filter((l) => /requeued\.add\(item as object\)/.test(l)).length,
      'requeued 的登记点应恰好两处(退队 / 取用)；少一处闸门就形同不存在').toBe(2);
    expect(codeLines.some((l) => /!\s*requeued\.has\(item as object\)/.test(l)),
      '退队条件里没有一次上限闸门 ⇒ 恒限流形态滴灌到超时(#106)').toBe(true);
    // 反向钉子：闸门不许被写成恒真/恒假的常量比较(那是变异体自己蒙绿的老路)。
    expect(codeLines.some((l) => /!requeued\.has\(item as object\)\s*(&&|\|\|)\s*(true|false)/.test(l)),
      '闸门被常量短路').toBe(false);
  });

  /** #113 的**行为**判据：整轮恒失败时，最后一条进度读数必须同时满足三件事 ——
   *   · `done === total`(分子分母同源，否则界面停在「共二六」而实际只有二五条)；
   *   · `total === tasks.length`（补跑那一条**不另开一格**，因为它不在本轮队列里）；
   *   · 名单文案里的条数 = 真实条数。
   *  【实测矩阵 · jsdom 2026-10-07 · 恒失败盘 retries:0，共 24 步】
   *      正确码  @0 = 1/23本命 ⇒ @1..@22 全在 2/24 ⇒ @23 收尾 23/23
   *      M116(删撤回)  @0 = 1/24 ⇒ @1..@22 = 24 ⇒ @23 = **24/24**  ⇒ 本用例红(分母多一格)
   *      M119(补跑句写 tasks.length)  读数与正确码**逐条相同**(23/23) ⇒ 本用例**杀不掉**
   *  ⚠ 我原本按「done 被虚增分母顶掉」预测 M119 会露出 23/24，实测证明这个预测是错的：这里恰好
   *  没有 adjustment、总结也没发出去，`tasks.length` 与 `totalShown()` 同值 ⇒ 两版代码不可区分。
   *  #119 的真形态是「占位已撤回后又被补跑那一句摆回来」(有 adjustment 或要点攒出来了才会分叉)，
   *  所以这一格只钉 #113/#116 的同源判据；M119 由 progress-bar-count 那侧的界面读数负责，
   *  不许在这里假称已经杀掉。 */
  it('整轮恒失败的收尾读数：分子分母同源，且不虚增格子(#113 / #116)', async () => {
    const record = {
      id: 'final-r1', name: '恒失败盘', gender: 'male', birthYear: 1984, birthMonth: 2,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
      aiStatus: 'not_started',
    } as unknown as BaziRecord;
    const steps: Array<{ done: number; total: number; label: string }> = [];
    await orchestrateBaziAnalysis(record, async (task) => ({ task, status: 'failed' as const, error: '上游服务返回五百' }),
      (p) => { steps.push({ done: p.done, total: p.total, label: p.label }); }, { retries: 0, retryDelayMs: 0 });
    expect(steps.length, '恒失败盘的步数(实测订正：不是「步数 == 槽位数」，见上面 #116 那段)').toBeGreaterThan(0);
    const last = steps[steps.length - 1]!;
    expect(last.total, '末条分母不等于本轮队列长度 ⇒ 有占位没撤回或补跑虚增了一格').toBe(23);
    expect(last.done, '末条分子与分母不同源 ⇒ 进度条停在差一格').toBe(last.total);
    // 补跑那一句的文案必须报真实条数(23 条全失败)，不能是「零条」「共二四条」这类与账本脱钩的读数。
    const repairStep = steps.find((s) => s.label.includes('自动重试失败任务'));
    expect(repairStep, '整轮恒失败却没有发出补跑状态句').toBeTruthy();
    expect(repairStep!.label, '补跑文案的条数与真实名单不符').toContain('二三');
  }, 60000);

  /** 【缺陷 #117 / #120 · 实测读数】恒超时形态(超时既触发池子退队重发、又过 isRetryableFailure)
   *  是线上最常见的失败形状，这里钉整轮口数与补跑名单，防止「同一份结论买三次」回来(#109)。
   *  【实测矩阵 · jsdom 2026-10-07，桩即时 resolve，23 条任务全失败】
   *      retries:0 → 总口数 67 = 首发 23 + 冷却重发 23 + 补跑 21；task-01 读 2、task-02 读 2
   *      retries:1 → 总口数 90；task-01/02 **各读 3**(不是「最多两口子」—— step 的即时重试与池子的
   *                  退队重发各自独立地花掉两口、补跑再花一口 ⇒ 编排器注释里那句「主跑阶段一整轮
   *                  最多 2 次请求」在恒超时形态下**不成立**，已由这一格订正)
   *  ⚠ 诚实交代两点我原先都猜错了：
   *   · 「retries:0 时补跑闸门会把条目全拦掉」是**错的** —— 池子扣的是 own.budget，
   *     补跑名单查的是 own.repairBudget，两本账分家后 retries:0 照样补跑(见上面 roundOf 的订正)。
   *   · 「spend 没有下限 ⇒ 这一格会露出负余额」也是**错的** —— 去掉下限后 67/90 逐字不变(Mcclamp SURVIVED)，
   *     因为两条固定池路径都接了 budgetOf、step() 看不到池子那本账。所以那个下限是防御性写法，
   *     负余额由上面那条结构判据钉；这里只钉得住「重复买同一份结论」那一半(M117 会让时段任务多烧一口)。 */
  it('恒超时盘的整轮口数：时段任务三口封顶、补跑名单非空(#117)', async () => {
    const mkRecord = (id: string) => ({
      id, name: '恒超时盘', gender: 'male', birthYear: 1984, birthMonth: 2,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
      aiStatus: 'not_started',
    } as unknown as BaziRecord);
    const TIMEOUT_MSG = '请求超时，已完成连接中断'; // 命中 TRANSIENT_RE(可重试) + isTimeoutFailure(退队重发)

    const counts0: string[] = [];
    const steps0: Array<{ label: string }> = [];
    await orchestrateBaziAnalysis(mkRecord('clamp-r0'), async (task) => {
      counts0.push(task.taskId);
      return { task, status: 'failed' as const, error: TIMEOUT_MSG };
    }, (p) => { steps0.push({ label: p.label }); }, { retries: 0, retryDelayMs: 0 });
    expect(counts0.filter((id) => id === 'task-02').length, '时段任务一整轮最多两口子(1 首发 + 1 再试)；第三口＝主跑与补跑重复买同一份结论(#109)').toBe(2);
    expect(counts0.filter((id) => id === 'task-01').length, '本命同样两口子(退队重发与 step 首发各扣一次同一本账)').toBe(2);
    expect(steps0.some((s) => s.label.includes('自动重试失败任务')), 'retries:0 却没有补跑状态句 ⇒ 补跑额度被并回主跑那本账(#117 的反向口径)').toBe(true);

    const counts1: string[] = [];
    await orchestrateBaziAnalysis(mkRecord('clamp-r1'), async (task) => {
      counts1.push(task.taskId);
      return { task, status: 'failed' as const, error: TIMEOUT_MSG };
    }, (p) => { steps0.push({ label: p.label }); }, { retries: 1, retryDelayMs: 0 });
    // HEAD 在 retries:1 下实测 90 口(task-02 三条)；#121 后同一本账封住再试 ⇒ 实测 67 口(task-02 两条)。
    // 这里钉成**上界**而不是等号：退队重发是否触发取决于时序，等号会把调度抖动当成缺陷。
    expect(counts1.filter((id) => id === 'task-02').length, '时段任务一整轮最多两口子(首发 + 一次冷却重发)；第三口＝主跑与补跑重复买同一份结论(#109 / #121)').toBeLessThanOrEqual(2);
    expect(counts1.length, '整轮总口数(实测 67)不许随轮次膨胀 ⇒ 批次必须收敛').toBeLessThanOrEqual(69);
  }, 180000);
});

/** 【缺陷 #116】占位「撤得掉」这一半此前没有任何判据：把收尾那句 `if (!hasFindings) summarySlot = false;`
 *  整行删掉，全仓其余用例仍然全绿 —— 界面会一直显示「共二六」而实际只有二五条任务，
 *  进度条永远差最后一格。
 *  【实测订正 · jsdom 2026-10-07】我第一版用**全盘恒失败**造这个场景，读数证明它压根不是撤回路径：
 *    本命也失败 ⇒ collectFindings 三个桶都空 ⇒ `summarySlot` 从未被摆进分母(末条读 23/23)，
 *    那条路只测得到「没要点就不发总结」；同时 tasks.length 停在 23、done 却数到 24(补跑轮那一条
 *    不在 tasks 里)⇒ 「步数恰等于槽位数」这种期望根本不存在，实测 24 ≠ 23。
 *  真正的撤回路径要求**占位已摆上、跑完却没攒出要点**：本命成功给出喜用(时段任务的占位因此摆进分母)，
 *  其余全失败(一个要点都提不出来)。实测读数 25 → …→ 25 → 末条 24/24。 */
it('占位摆上后没攒出要点：总结占位必须撤回，末条读数回到真实长度', async () => {
  const record = {
    id: 'retract-r1', name: '无要点盘', gender: 'male', birthYear: 1984, birthMonth: 2,
    createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
    aiStatus: 'not_started',
  } as unknown as BaziRecord;
  const steps: Array<{ done: number; total: number }> = [];
  await orchestrateBaziAnalysis(record, async (task) => task.taskId === 'task-01'
    // 只有本命成功：它的正文没有【要点】形态的可摘句，collectFindings 只看时段任务 ⇒ 三桶皆空。
    ? ({ task, status: 'completed' as const, analysis: { explanation: '【格局】测试', pattern: '测试格', strength: '身强', usefulElements: ['木'], avoidElements: ['金'] } } as never)
    : ({ task, status: 'failed' as const, error: '上游服务返回五百' }),
    (p) => { steps.push({ done: p.done, total: p.total }); }, { retries: 0, retryDelayMs: 0 });
  expect(steps.some((s) => s.total === 25), '占位从没摆上 ⇒ 这一格测不到「撤回」，只测到不发').toBe(true);
  const last = steps[steps.length - 1]!;
  expect(last.total, '占位没撤回：末条分母比真实任务多一格').toBe(24);
  expect(last.done, '末条分子应满格').toBe(last.total);
});
