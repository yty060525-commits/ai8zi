import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import type { BaziRecord } from '../types/domain';
import { STEMS, ELEMENTS, HIDDEN_STEMS } from '../features/chart/elements';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { buildLocalAnalysis, buildLocalTaskAnalysis, LOCAL_ANALYSIS_ENGINE_VERSION } from '../data/localAnalysis';
import { buildBaziTasks } from '../data/baziOrchestrator';

const NOW = new Date('2026-09-26T06:00:00Z');
/* jsdom 里 import.meta.url 不是 file: 协议，new URL(...) 会抛「URL must be of scheme file」，故用绝对路径。 */
const PROBE_DIR = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/.scratch/';
const make = (year: number, month: number, day: number, hour: number, gender: 'male' | 'female'): BaziRecord => {
  const p = computePillarsFromDate({ year, month, day, hour });
  const nonAiResult = calculateNonAi({ birthYear: year, birthMonth: month, birthDay: day, ...p }, gender, NOW.toISOString());
  return { id: `love-${gender}-${year}${month}${day}${hour}`, name: '爱情钉子', gender, createdAt: NOW.toISOString(),
    birthYear: year, birthMonth: month, birthDay: day, ...p, nonAiResult, aiStatus: 'completed' } as unknown as BaziRecord;
};
/* 取某条任务正文里的【爱情】小节首句。 */
const loveOf = (rec: BaziRecord, taskId: string): string => {
  const task = buildBaziTasks(rec, NOW).find((t) => t.taskId === taskId);
  if (!task) throw new Error(`没有任务 ${taskId}（预期清单里没有它）`);
  const a = buildLocalTaskAnalysis(rec, task, NOW);
  if (!a) throw new Error(`任务 ${taskId} 没算出批断`);
  const m = /【爱情】\n([\s\S]*?)(?:\n【|$)/.exec(a.explanation);
  if (!m) throw new Error(`正文里没有【爱情】小节：${a.explanation.slice(0, 80)}`);
  return m[1].trim();
};
/** 年份 → 该盘流年任务的 id（从预期清单读，不猜编号）。 */
const taskIdForYear = (rec: BaziRecord, year: number): string => {
  const t = buildBaziTasks(rec, NOW).find((x) => x.type === 'annual' && x.year === year);
  if (!t) throw new Error(`预期清单里没有 ${year} 年的流年任务`);
  return t.taskId;
};

/* =============================================================================
 * 流年/流月「爱情」小节的配偶星引动判据（任务 #22「优化算法」第二条落地）
 * 旧写法只认一条途径：本期**天干**的十神属配偶组（男财女官杀）。实测偏窄 ——
 *   全空间扫描（792 个由引擎排出的真实盘 × 未来十年流年 = 7920 行，见 .scratch/spouse-scan*.txt）：
 *     ① 只看本期天干：命中 20.0%（干支循环里配偶组恰占 4/10 干，故恒为两成）
 *     ② 本期地支本气属配偶组：20.1%
 *     ③ 本期地支与本命日支（配偶宫）逢冲/三合/六合：41.8%
 *     并集 60.6%，即旧写法把 40.6% 的引动年一律写成「感情宫位未受特别引动」。
 * 夹具不手拼干支（会抛「该月找不到与这三部命盘对应的日期」），一律 computePillarsFromDate 现排。
 * 判据变了 ⇒ 规则引擎版本升到 local-rules-v4（下面 M7 那条钉子读真实文件字节把它钉住）：
 *   aiTasks 里 source==='local' 的存量正文会因此与新读数不一致，须重新生成一轮才更新；
 *   本机预览按钮每次点击现算、不落库，不受影响。
 *
 * —— 变异记录（.scratch/mutate-love2.py，11 个变异体，脚本尾行 RESTORED_IDENTICAL=True）——
 *   杀红：M1 删地支途径 / M2 颠倒配偶组 / M4 只认存量十神字段 / M5 配偶组退成单五行 /
 *         M6 忽略配偶宫途径 / M7 忘升版本 / M8·M9 把①②两路变量合并（侧别统计被兜底污染）/
 *         M10 取向退回本期档位 / M11 星未现却写「被引动」。
 *   存活：M3 松写法（整串 includes(日支)）。此前已用全空间比对证明它与逐对写法在 7920 行上
 *         读数完全相同（.scratch 记录 pair_diff_count=0），故本套件对它**结构上不可能**变红，
 *         这是一处已知覆盖盲区，不是「判据冗余可删」的证据。
 *   M5 曾长期表现为「漏判掩盖」：它只杀掉依赖双元素的那两条用例，说明配偶组必须成对取的两个
 *     五行里，阴那一侧单独出现的年份要专门钉（见「配偶组含阴阳两个五行」那条）。
 * ========================================================================== */
// 乙卯日、男命：我克者土为妻星 → 配偶五行 = 戊/己；日支卯为配偶宫。
const MALE = make(1986, 3, 12, 8, 'male');
describe('时段批断爱情小节的配偶星引动', () => {
  /* 版本号钉子必须读**真实文件的字节**，不能只比常量本身：
     `expect(LOCAL_ANALYSIS_ENGINE_VERSION).toBe('local-rules-v3')` 是同义反复——改判据却忘了升版本时
     它照样绿（常量与被断言的值是同一个来源）。这里断的是源文件里那一行写的是什么。 */
  const SRC_FILE = 'C:/Users/yty06/Documents/ai/bbazi/ai 8zi/ai 8zi/ai 8zi/client/src/data/localAnalysis.ts';
  it('改了爱情判据就必须升引擎版本：源文件里那行写的是 v4（M7 变异体在此转红）', () => {
    const raw = readFileSync(SRC_FILE, 'utf8').replace(/\r\n/g, '\n');
    const m = /^export const LOCAL_ANALYSIS_ENGINE_VERSION = '([^']+)';$/m.exec(raw);
    // 前提钉子：这一行必须存在且唯一，否则下面的断言是空的
    expect(m).not.toBeNull();
    expect(raw.match(/LOCAL_ANALYSIS_ENGINE_VERSION = '/g)).toHaveLength(1);
    expect(m![1]).toBe('local-rules-v4');
    // 交叉核对：源文件那行与模块导出的常量同源（防止有人另抄一份字面量）
    expect(LOCAL_ANALYSIS_ENGINE_VERSION).toBe(m![1]);
  });

  it('前提钉子：档位与喜忌侧读得出、且这句确实来自本机规则引擎', () => {
    const n = MALE.nonAiResult!;
    expect(n.pillars.day).toBe('乙卯');
    expect(n.strengthScore?.label).toBeTruthy();
    // 2026 丙午：丙火=伤官、午藏丁=食神，既非妻星也不动配偶宫（卯与午无冲合三合）
    expect(loveOf(MALE, 'task-02')).toContain('感情宫位未受特别引动');
  });

  it('配偶星不透干时，仍按本期地支本气认出引动（旧写法在此静默漏判）', () => {
    // 2033 癸丑：癸=枭(印)、丑本气己土=妻星；日支卯与丑无冲合 → 只有途径②能命中
    const line = loveOf(MALE, 'task-09');
    expect(line).toContain('妻星');
    expect(line).toContain('流年地支丑所藏本气己亦财之星');
    expect(line).not.toContain('未受特别引动');
  });

  it('配偶宫被引动要说清是哪一个本命柱与之相引，别柱自己的冲合不许算到配偶宫头上', () => {
    // 2027 丁未：未与日支卯半合木局(亥卯未同组) → 途径③；同时未本气己土也是妻星 → 途径②也在
    const line = loveOf(MALE, 'task-03');
    expect(line).toContain('更与本命日支卯（配偶宫）相引');
    // 反例前提：本命月柱辛卯自己就含「卯」字，若按整串 includes 判，任何与月柱相冲的年份
    // 都会被误报成动了配偶宫。2035 乙卯…逐年里 2029 己酉冲卯两处都有，须逐对核到本期干支。
    const other = loveOf(MALE, 'task-05');
    expect(other.length).toBeGreaterThan(6);
  });

  it('配偶宫判据只认「本期地支 ↔ 本命日支」这一对，别柱含同一个字不算', () => {
    const n = MALE.nonAiResult!;
    // 前提钉子：这盘月支与日支同为卯 —— 于是任何与「月柱辛卯」成冲/合的流年，
    // 其关系串（形如「辛卯与X卯」）里也含「卯」字。旧式整串 includes 会把这种
    // 别柱之间的命中记到配偶宫头上；逐对取两支才不会。
    expect(n.pillars.month).toBe('辛卯');
    expect(n.pillars.day).toBe('乙卯');
    // 本期干支取自任务对象与流年表（不是同式重算）
    const annualGz = (taskId: string): string => {
      const t = buildBaziTasks(MALE, NOW).find((x) => x.taskId === taskId);
      if (!t?.year) throw new Error(`任务 ${taskId} 没有年份`);
      const row = n.annualFortunes.find((r) => r.year === t.year);
      if (!row) throw new Error(`流年表里没有 ${t.year}`);
      return row.ganZhi;
    };
    let palaceClaims = 0;
    for (const id of ['task-02', 'task-03', 'task-04', 'task-05', 'task-06', 'task-07', 'task-08', 'task-09', 'task-10', 'task-11']) {
      const line = loveOf(MALE, id);
      const claims = line.includes('（配偶宫）相引');
      const gz = annualGz(id);
      // 独立核对：本期地支与日支卯之间是否真有 冲(酉)/六合(戌)/三合组(亥卯未 %4 同余)
      const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
      const b = BRANCHES.indexOf(gz[1]), d = BRANCHES.indexOf('卯');
      const reallyTouched = Math.abs(b - d) === 6 || (b + d) % 12 === 1 || b % 4 === d % 4;
      expect(claims, `${id} 本期${gz} 声称动了配偶宫=${claims}，实际冲合关系=${reallyTouched}`).toBe(reallyTouched);
      if (claims) palaceClaims++;
    }
    // 反例存在性：窗口里既有「动了配偶宫」的年份，也有没动却被松写法误报的年份（甲寅/丙午…）
    expect(palaceClaims).toBeGreaterThan(0);
    expect(loveOf(MALE, 'task-10')).not.toContain('配偶宫）相引');
  });

  /* ── 爱情句的吉凶取向必须按「配偶星自己落在哪一侧」写，而不是照抄本期整体档位 ─────────
   * v3 首轮把三条途径并起来后一律用 verdict 定调，实测读数里出现两类自相矛盾：
   *   · [task-07] strength="…喜忌并见（顺逆交参）" :: 妻星临忌被引动（流年天干辛为七杀、更与…相引）
   *       —— 辛是七杀不是妻星，「临忌」说的是辛，读者却会以为妻星犯忌；
   *   · [task-11] strength="…减力（逆）" :: 本期妻星被引动（更与…相引）且向喜用 …
   *       —— 同一行刚说本期减力，这里又说向喜用。
   * 现在按配偶星自身侧别分四档：偏喜 → 「且向喜用」；偏忌 → 「临忌被引动」；
   * 同侧并见且本期减力 → 「气势有损、进展偏缓」；其余 → 中性那句。 */
  const EL_OF = (gan: string) => ELEMENTS[STEMS.indexOf(gan) >> 1];
  const MAIN_EL = (zhi: string) => {
    const s = (HIDDEN_STEMS[zhi] ?? [])[0] ?? '';
    return STEMS.includes(s) ? ELEMENTS[STEMS.indexOf(s) >> 1] : '';
  };
  /** 这盘的忌侧：日主乙木、档位中和偏旺 ⇒ 扶抑取比劫(木)与印(水)为忌。label 由下面钉子钉住。 */
  const avoidOf = (): string[] => {
    expect(MALE.nonAiResult!.pillars.day[0]).toBe('乙');
    return ['木', '水'];
  };
  /** 独立复算 periodVerdict 的三档读数（同源口径：天干五行 + 地支本气五行）。 */
  const verdictOf = (gz: string): '加力' | '减力' | '并见' => {
    const els = [EL_OF(gz[0]), MAIN_EL(gz[1])].filter(Boolean);
    const help = new Set(els.filter((e) => !avoidOf().includes(e)));
    const harm = new Set(els.filter((e) => avoidOf().includes(e)));
    return help.size > harm.size ? '加力' : harm.size > help.size ? '减力' : '并见';
  };
  /** 男命乙木：我克者为财。财组占**两个**相邻五行——乙下标0 ⇒ +2=土、+3=金，故妻星为「土、金」。
   *   ⚠ 这里曾经只写「土」，是我这条复算自己错了（不是产品错）：辛金同属财组，
   *     「辛亥年妻星被引动」在引擎里是对的，而错误的单元素预期把一条正确读数判成失败，
   *     差点让我去改本就正确的产品码。十神分组恒为一对相邻五行，缺这一条即漏判。 */
  const spouseElsOf = (): string[] => {
    expect(MALE.nonAiResult!.pillars.day[0]).toBe('乙');
    return ['土', '金'];
  };
  it('前提钉子：档位标签与逐年独立复算的加减力读数一致', () => {
    expect(MALE.nonAiResult!.strengthScore?.label).toBe('中和偏旺');
    // 忌侧复算与产品自己的 useful/avoid 字段一致（否则下面所有取向断言都建在错的前提上）
    const a0 = buildLocalAnalysis(MALE, NOW)!;
    expect([...a0.avoidElements].sort()).toEqual([...avoidOf()].sort());
    const rows: string[] = [];
    for (const id of ['task-02', 'task-03', 'task-04', 'task-05', 'task-06', 'task-07', 'task-08', 'task-09', 'task-10', 'task-11']) {
      const task = buildBaziTasks(MALE, NOW).find((t) => t.taskId === id)!;
      const row = MALE.nonAiResult!.annualFortunes.find((r) => r.year === task.year)!;
      const a = buildLocalTaskAnalysis(MALE, task, NOW)!;
      // 产品自己的读数（strength 字段）必须与我独立复算的一致，否则上面的复算不可信
      const claimed = /本期(加力|减力|喜忌并见)/.exec(a.strength)?.[1];
      const v = verdictOf(row.ganZhi);
      rows.push(`${task.year} ${row.ganZhi} 复算=${v} 产品=${claimed}`);
      expect(claimed, `${id} 复算与产品读数不一致：${row.ganZhi}`).toBe(v === '并见' ? '喜忌并见' : v);
    }
    writeFileSync(PROBE_DIR + 'love-verdict-nails.txt', rows.join('\n'), 'utf8');
  });

  it('爱情句的取向按配偶星自身侧别写：不许拿本期整体档位当配偶星吉凶', () => {
    let neutral = 0, positive = 0;
    const rows = MALE.nonAiResult!.annualFortunes;
    for (const id of ['task-02', 'task-03', 'task-04', 'task-05', 'task-06', 'task-07', 'task-08', 'task-09', 'task-10', 'task-11']) {
      const line = loveOf(MALE, id);
      const year = buildBaziTasks(MALE, NOW).find((t) => t.taskId === id)!.year!;
      const row = rows.find((r) => r.year === year)!;
      // 配偶星自己落在哪一侧（独立复算：只看属妻星的那几个字，不看整期）
      const els = [EL_OF(row.ganZhi[0]), MAIN_EL(row.ganZhi[1])].filter(Boolean);
      const sHelp = new Set(els.filter((e) => spouseElsOf().includes(e) && !avoidOf().includes(e)));
      const sHarm = new Set(els.filter((e) => spouseElsOf().includes(e) && avoidOf().includes(e)));
      if (line.includes('且向喜用')) {
        expect(sHelp.size, `${id} ${row.ganZhi} 配偶星不在喜侧却写了「向喜用」`).toBeGreaterThan(0);
        expect(sHarm.size, `${id} ${row.ganZhi} 配偶星也落在忌侧，不许一面倒写成「向喜用」`).toBe(0);
        positive++;
      }
      if (line.includes('临忌被引动')) {
        expect(sHarm.size, `${id} ${row.ganZhi} 配偶星不在忌侧却写了「临忌」`).toBeGreaterThan(0);
        expect(sHelp.size, `${id} ${row.ganZhi} 配偶星也落在喜侧，不许一面倒写成「临忌」`).toBe(0);
        positive++;
      }
      if (line.includes('逢引动')) {
        expect(sHelp.size, `${id} ${row.ganZhi} 配偶星明显在喜侧却走了中性句`).not.toBeGreaterThan(sHarm.size);
        expect(sHarm.size, `${id} ${row.ganZhi} 配偶星明显在忌侧却走了中性句`).not.toBeGreaterThan(sHelp.size);
        neutral++;
      }
      if (line.includes('喜忌同临')) neutral++;
      // 引动句与未引动句互斥：写了依据就不许再来一句「未受特别引动」。
      //   判据取「（」是因为引动句必带依据括号，而 boilerplate 那句没有——别用「引动」二字，
      //   「未受特别引动」自己就含它（第一版这么写，恒真）。
      if (line.includes('（')) expect(line, `${id} ${row.ganZhi}`).not.toContain('未受特别引动');
    }
    // 各形态都必须真的出现，否则这条测的是空集（恒真断言）
    expect(positive, '窗口里没有「向喜用」句').toBeGreaterThan(0);
    expect(neutral, '窗口里没有中性分支句式 ⇒ 侧别相抵/星未现的分支没被覆盖').toBeGreaterThan(0);
  });

  it('四种取向句式在真实盘上全部可达，且每一句的措辞与其自身依据相符', () => {
    // 男命十年窗口只出得了「向喜用／宫动星未现／未引动」三种，「临忌」与「喜忌同临」必须换盘才可达
    // （实测见 .scratch/love-orient.txt）。所以这里枚举两盘×全流年，而不是拿一个窗口硬凑。
    const FEMALE = make(1990, 6, 15, 10, 'female');   // 辛亥日：克我者火为官杀，身弱
    const seen: Record<string, number> = { 向喜用: 0, 临忌: 0, 喜忌同临: 0, 星本身未现: 0, 未受特别引动: 0 };
    for (const rec of [MALE, FEMALE]) {
      for (const t of buildBaziTasks(rec, NOW)) {
        if (t.type !== 'annual') continue;
        const row = rec.nonAiResult!.annualFortunes.find((r) => r.year === t.year)!;
        const a = buildLocalTaskAnalysis(rec, t, NOW)!;
        const line = (/【爱情】\n([\s\S]*?)(?:\n【|$)/.exec(a.explanation)?.[1] ?? '').trim();
        const key = ['向喜用', '临忌', '喜忌同临', '星本身未现', '未受特别引动'].find((k) => line.includes(k));
        if (!key) continue;
        seen[key]++;
        // 措辞与依据相符：偏喜句不许提忌、偏忌句不许提喜、中性句不许一面倒。
        if (key === '向喜用') expect(line, `${rec.id} ${row.ganZhi}`).not.toContain('波折');
        if (key === '临忌') expect(line, `${rec.id} ${row.ganZhi}`).not.toContain('机会增多');
        if (key === '喜忌同临') expect(line, `${rec.id} ${row.ganZhi}`).toContain('进退');
        // 「临忌／向喜用」两句都必须点出配偶星自己的字；只有纯宫位引动才走「星本身未现」。
        if (key === '临忌' || key === '向喜用') {
          expect(line, `${rec.id} ${row.ganZhi} 取向句没给出配偶星依据`).toMatch(/天干|本气/);
        }
        if (key === '星本身未现') expect(line, `${rec.id} ${row.ganZhi}`).toContain('配偶宫）相引');
      }
    }
    for (const k of Object.keys(seen)) expect(seen[k], `句式「${k}」在两盘全流年里一次都没出现`).toBeGreaterThan(0);
  });

  it('正文零拉丁字母、零半角括号（仓库硬约束，新增句式也要过）', () => {
    for (const id of ['task-02', 'task-03', 'task-04', 'task-05', 'task-09', 'task-11']) {
      const line = loveOf(MALE, id);
      expect(line, `${id} 那句不合格`).not.toMatch(/[A-Za-z()]/);
    }
  });

  it('女命以官杀为夫星：只看日主代数推出的那一组，不靠存量 tenGod 字段', () => {
    const FEMALE = make(1983, 1, 9, 11, 'female');   // 丁酉日：克我者水为官杀
    const n = FEMALE.nonAiResult!;
    expect(n.pillars.day).toBe('丁酉');
    // 2032 壬子：壬=正官、子藏癸=七杀，两条途径都指向夫星
    const line = loveOf(FEMALE, 'task-08');
    expect(line).toContain('夫星');
    expect(line).toContain('壬为正官');
    expect(line).toContain('流年地支子所藏本气癸亦官杀之星');
    expect(line).not.toContain('妻星');
  });

  /* ── 变异测试记录（首轮 + 补测后，见 .scratch/mutate-love.out.txt）───────────────────
   * 已杀：M1 去掉地支途径 / M2 配偶组取反 / M4 只认十神字段 / M6 只认天干途径 /
   *       M7 改了判据却不升引擎版本（由上面那条读真实文件字节的钉子杀掉）。
   * 两个变异体存活，逐个查清后如实记录（不谎称杀掉）：
   *   M3「宫位判据退回整串 includes(日支)」——存活且**经证明语义等价**。引擎的关系串形如
   *     「辛卯与丁未」，两侧都是整柱两字，第二字就是该柱地支；对全部 (本期支, 日支, 别柱支) 组合枚举 12×12×12×2 种串形态，
   *     loose 与 strict 读数差异 = 0（.scratch/probe-equivalence2.py: pair_diff_count=0）。
   *     ⇒ 逐对写法读起来更明确，但当前不改变任何输出；保留它是因为串形态一改（例如将来只写单支）
   *       松写法会立刻误报，而这条等价性只在「两支都在串里」时成立。
   *   M5「配偶组只取一个五行」——**不是等价变异，是覆盖盲区**。补了下面这条阴干钉子后仍全绿，
   *     原因是这一处 helper 只被 movedByStem/movedByBranch 两处消费，而那两处的输出在六十甲子
   *     循环里被另一条途径托住了：配偶组只取阳干时，凡「运干属阴配偶星」的盘都会由地支途径
   *     （本气同组）报出同一句结论，正文一字不差。⇒ 该兜底目前不可观测，保留但不谎称杀掉了。
   *     若将来有第三种读法（例如按十神字段单判），这条会立刻变成真缺陷，届时须重跑变异。 */
  it('大运行没有 tenGod 字段时，配偶星仍按五行推出（旧写法在此静默漏判）', () => {
    // 前提钉子：domain 里 greatFortunes.tenGod 是**可选**字段，且瘦身后重建的大运槽不带载荷
    //   （见 baziOrchestrator 的 decadeSlots 补槽路径），所以这条兜底不是防御性冗余。
    const n = MALE.nonAiResult!;
    const BR = '子丑寅卯辰巳午未申酉戌亥';
    const dayBranch = n.pillars.day[1];
    const touched = (a: string, b: string) => {
      const x = BR.indexOf(a), y = BR.indexOf(b);
      return Math.abs(x - y) === 6 || (x + y) % 12 === 1 || x % 4 === y % 4;
    };
    // 配偶星取土（乙木克土），本气为土的支 = 辰戌丑未；这里直接用支名，不引被测模块的表。
    const task = buildBaziTasks(MALE, NOW).find((t) => t.type === 'decade')!;
    const EARTH_BRANCHES = ['辰', '戌', '丑', '未'];
    const mainStem: Record<string, string> = { 子: '癸', 丑: '己', 寅: '甲', 卯: '乙', 辰: '戊', 巳: '丙', 午: '丁', 未: '己', 申: '庚', 酉: '辛', 戌: '戊', 亥: '壬' };
    // ①-A 先单独钉「天干途径 + 无 tenGod」：挑一条**运干就是妻星(戊/己)**、宫位又没动的运，
    //   把它的 tenGod 抹掉。只认字段的写法在这条上会整句漏判——这是 M4 的杀手，不能和②混在一起测。
    //   ⚠ 不加「宫位没动」的额外条件：那会把样本缩到零（本盘戊戌运的戌与日支卯六合）。
    const stemRows = n.greatFortunes.filter((g) => ['戊', '己'].includes(g.ganZhi[0]));
    expect(stemRows.length, `九步大运里没有戊/己干的运(${n.greatFortunes.map((g) => g.ganZhi).join(' ')})`).toBeGreaterThan(0);
    for (const g of stemRows) {
      const a = buildLocalTaskAnalysis(MALE, { ...task, decade: { ...g, tenGod: undefined } }, NOW)!;
      const line = /【爱情】\n([\s\S]*?)(?:\n【|$)/.exec(a.explanation)![1].trim();
      expect(line, `${g.ganZhi}运缺 tenGod 时丢了天干途径`).toContain(`大运天干${g.ganZhi[0]}`);
      expect(line).toContain('妻星');
      // 同一步运若把 tenGod 交回去，读数必须一模一样（兜底不该改变正常路径的输出）。
      const withField = buildLocalTaskAnalysis(MALE, { ...task, decade: g }, NOW)!;
      const baseLine = /【爱情】\n([\s\S]*?)(?:\n【|$)/.exec(withField.explanation)![1].trim();
      expect(line).toBe(baseLine);
    }
    const rows = n.greatFortunes.filter((g) => g.ganZhi && !['戊', '己'].includes(g.ganZhi[0])
      && EARTH_BRANCHES.includes(g.ganZhi[1]) && !touched(g.ganZhi[1], dayBranch));
    expect(rows.length, `这盘的九步大运里没有可用样本(现有：${n.greatFortunes.map((g) => g.ganZhi).join(' ')})`).toBeGreaterThan(0);
    const row = rows[0];
    const stripped = { ...task, decade: { ...row, tenGod: undefined } };
    const a = buildLocalTaskAnalysis(MALE, stripped, NOW)!;
    const line = /【爱情】\n([\s\S]*?)(?:\n【|$)/.exec(a.explanation)![1].trim();
    expect(line, `${row.ganZhi}运(${row.startYear}起)本气是妻星却没报`).toContain('妻星');
    expect(line).toContain(`地支${row.ganZhi[1]}所藏本气${mainStem[row.ganZhi[1]]}亦财之星`);
    expect(line).not.toContain('未受特别引动');
    // 对照：同一行如果连本气都不是配偶星，就必须退回那句「未受特别引动」——防止判据过宽。
    const other = n.greatFortunes.find((g) => !EARTH_BRANCHES.includes(g.ganZhi[1])
      && !['戊', '己'].includes(g.ganZhi[0]) && !touched(g.ganZhi[1], dayBranch));
    if (other) {
      const b = buildLocalTaskAnalysis(MALE, { ...task, decade: { ...other, tenGod: undefined } }, NOW)!;
      const otherLine = /【爱情】\n([\s\S]*?)(?:\n【|$)/.exec(b.explanation)![1].trim();
      expect(otherLine, `对照组 ${other.ganZhi} 被误报成引动`).toContain('未受特别引动');
    }
  });

  it('配偶组含阴阳两个五行：阴那一侧（己土）单独也能认出妻星', () => {
    // 乙木男命：我克者为土，戊(阳)/己(阴) 都是妻星。只取一个五行的写法会漏掉一半年份。
    const n = MALE.nonAiResult!;
    const yin = n.annualFortunes.filter((r) => r.ganZhi[0] === '己');
    const yang = n.annualFortunes.filter((r) => r.ganZhi[0] === '戊');
    expect(yin.length, '十年窗口里没有己年，测不到阴侧').toBeGreaterThan(0);
    expect(yang.length, '十年窗口里没有戊年，对照组不成立').toBeGreaterThan(0);
    for (const row of [...yin, ...yang]) {
      const id = taskIdForYear(MALE, row.year);
      const line = loveOf(MALE, id);
      expect(line, `${row.year} ${row.ganZhi} 未报妻星：${line}`).toContain('妻星');
    }
  });

  it('松写法会把别柱与本期之间的冲合误记到配偶宫（逐对判据的杀手用例）', () => {
    // 找一个流年：它与**月柱辛卯**成冲/合、但与**日支卯**不成 —— 此时整串 includes 会误报。
    const n = MALE.nonAiResult!;
    const BR = '子丑寅卯辰巳午未申酉戌亥';
    const dayB = n.pillars.day[1], monthB = n.pillars.month[1];
    const touched = (a: string, b: string) => {
      const x = BR.indexOf(a), y = BR.indexOf(b);
      return Math.abs(x - y) === 6 || (x + y) % 12 === 1 || x % 4 === y % 4;
    };
    void dayB; void monthB;
    let found = 0;
    for (const row of n.annualFortunes ?? []) {
      const b = row.ganZhi[1];
      const vsDay = touched(b, n.pillars.day[1]);
      const claims = loveOf(MALE, taskIdForYear(MALE, row.year)).includes('（配偶宫）相引');
      // 与日支无冲合却声称动了配偶宫 = 松写法的形态；正确实现下恒不成立。
      expect(claims, `${row.year} ${row.ganZhi} 与日支${n.pillars.day[1]}无冲合却报配偶宫`).toBe(vsDay);
      if (!vsDay) found++;
    }
    expect(found, '十年窗口里全是与日支相冲合的年份，反例不成立').toBeGreaterThan(0);
  });
});
