/** 聊天取证的「本月/今年」也必须是北京口径 —— 与详情页同一类缺陷的第二处消费点。
 *
 * 缺陷形态：monthFromText 用 `now.getMonth()+1`、extractWhen 用 `now.getFullYear()`，
 * 于是 UTC/欧美设备在 UTC 16:00–24:00 这一整天里把「本月」答成上个月、「今年」答成去年，
 * 扫年窗口(from)也会整段前移一年。utils/date 收口详情页之后，这里仍是漏点。
 *
 * 判据走真实导出入口(analyzeQuestion / extractWhen)，不自己复算年月 ——
 * 「测试自建判据在变异下全绿」是本项目记过的教训(§13.192)。
 *
 * ⚠ 时钟桩必须覆盖整个用例体：产品的默认参 `now = new Date()` 是在函数**内部**求值的，
 * 只在断言外面包一层 onUtcDevice 等于什么都没换(上一版就是这么写的，实测「本月」读到的是
 * 真表月 10 而不是桩的 12)。所以每个用例第一件事就是装桩。 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeQuestion, applyFollowUp, buildEvidence, extractWhen, SCAN_YEARS } from '../data/chatEngine';
import type { BaziRecord } from '../types/domain';
import type { ChatPlan } from '../data/chatEngine';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const engineSrc = readFileSync(resolve(repo, 'client/src/data/chatEngine.ts'), 'utf8').replace(/\r\n/g, '\n');

/* —— 非 +08 设备模拟器(与 beijing-date-caliber.test.ts 同构) ——
   本机东八区，本地读法与北京口径同值，必须换时钟才分得出两种写法。 */
const CROSS_YEAR_UTC = '2025-12-31T16:00:00Z';   // 北京 2026-01-01；UTC 设备本地读出 2025-12-31
const CROSS_MONTH_UTC = '2026-01-31T16:00:00Z';  // 北京 2026-02-01；UTC 设备本地读出 2026-01-31

class UtcDeviceDate extends Date {
  constructor(value?: unknown) {
    super(typeof value === 'undefined' ? CROSS_YEAR_UTC : value as string | number | Date);
  }
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
  /* 反向钉子：桩与原时刻的本地读数必须分叉，否则两种口径同值，断言永真。 */
  if (new Date(CROSS_YEAR_UTC).getFullYear() === p.getFullYear()) throw new Error('桩与原时刻本地读数相同，区分不出两种口径');
}
function onUtcDevice<T>(run: () => T): T {
  const real = globalThis.Date;
  (globalThis as { Date: unknown }).Date = UtcDeviceDate as unknown as DateConstructor;
  try { return run(); } finally { (globalThis as { Date: unknown }).Date = real; }
}

describe('聊天引擎的相对时间锚点按北京口径取值', () => {
  it('跨年那一刻，UTC 设备上「今年/本月/下个月/上个月」仍按北京年月锚定', () => {
    onUtcDevice(() => {
      /* 前提自证(当场打响)：此刻桩确实在场，本地读法与北京口径分叉。
         没有这三行，下面的期望值可能只是「真表恰好也是这个数」。 */
      expect(new Date().toISOString().slice(0, 10), '时钟桩没生效，产品读到的是真表').toBe('2025-12-31');
      expect(new Date().getFullYear(), '本地年份读数应与北京口径分叉').toBe(2025);
      expect(new Date().getMonth() + 1, '本地月份读数应与北京口径分叉').toBe(12);

      /* 期望值来自北京日历本身(此刻北京是 2026-01-01)，不是照抄产品读数。 */
      expect(extractWhen('今年财运如何').year, '「今年」在 UTC 设备上锚到了本地年').toBe(2026);
      expect(extractWhen('本月注意什么').month, '「本月」在 UTC 设备上锚到了本地月').toBe(1);
      expect(extractWhen('本月财运').year, '月份锚定的年份用了本地年').toBe(2026);
      expect(extractWhen('下个月运势').month, '「下个月」不是北京月+1').toBe(2);
      expect(extractWhen('上个月运势').month, '「上个月」不是北京月-1(北京 1 月的上月是去年 12 月)').toBe(12);
    });
    /* 显式传 now 的两条走真表：分别钉住跨月前后的北京月份，边界不许修过头。 */
    expect(extractWhen('本月财运', new Date('2026-01-31T15:59:59.000Z')).month, '跨月前应仍是 1 月').toBe(1);
    expect(extractWhen('本月财运', new Date(CROSS_MONTH_UTC)).month, '跨月后应已是 2 月').toBe(2);
    /* 反向对照：在桩时钟上，「本地读法」给出的确实是旧的一年/一月 —— 证明上面的期望值不是恒真。
       注意这条只能在桩里比：本机是东八区，真表的本地读数与北京同值(拿它做对照会写成假失败)。 */
    const localShape = onUtcDevice(() => {
      const d = new Date(CROSS_YEAR_UTC);
      return { year: d.getFullYear(), month: d.getMonth() + 1 };
    });
    expect(localShape.year, '对照失效：桩的本地年读数没和北京年分叉').toBe(2025);
    expect(localShape.month, '对照失效：桩的本地月读数没和北京月分叉').toBe(12);
  });

  it('真实调用点(analyzeQuestion 默认参)也把锚点落在北京年月', () => {
    /* 上一版只调 extractWhen(不传 now)，于是「产品在 analyzeQuestion 里怎么把时钟喂进来」
       完全没被钉住 —— 变异只要改调用点就能存活。这里走真实导出入口且不传 now，
       让产品自己的 `new Date()` 默认参在桩时钟上取值。 */
    const plan = onUtcDevice(() => analyzeQuestion('本月财运如何', []));
    expect(plan.year, '检索计划的年份来自设备本地年').toBe(2026);
    expect(plan.month, '检索计划的月份来自设备本地月').toBe(1);
    expect(plan.topics, '这句应带出流月主题(否则取证分支跟着变)').toContain('流月');
  });

  it('开放式扫年的起算年也按北京年，窗口整体不前移一年', () => {
    onUtcDevice(() => {
      expect(new Date().getFullYear(), '时钟桩没生效').toBe(2025);
      const scan = extractWhen('什么时候能升职');
      expect(scan.scan, '这句应走扫年分支').toBe(true);
      expect(scan.from, '扫年起点在 UTC 设备上退到本地年').toBe(2026);
      const plan = analyzeQuestion('我什么时候能发财', []);
      expect(plan.scan).toBe(true);
      expect(plan.scanFrom, '检索计划带出的窗口起点不是北京年').toBe(2026);
      /* 窗口长度本身也有钉子：起点 + SCAN_YEARS 决定取证覆盖哪几年 */
      expect((plan.scanFrom ?? 0) + SCAN_YEARS - 1).toBe(2033);
    });
  });

  it('证据层的扫年兜底(scanFrom 缺失)也按北京年起窗', () => {
    /* C3 变异(把 buildEvidence 里的 ?? chinaYear(new Date()) 改回本地 getFullYear)在上一版判据里
       整条存活：那版只测 extractWhen/analyzeQuestion，永远给得出 scanFrom，压根走不到这个兜底分支。
       这里直接构造「scan=true 但 scanFrom 缺失」的计划喂给真实 buildEvidence ——
       这种计划是可能出现的(ChatPlan 由外部拼装、追问沿用分支也只复制 from)。 */
    const record = {
      id: 'r1', name: '张三', gender: 'male', birthYear: 1984,
      yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
      nonAiResult: { annualFortunes: [], greatFortunes: [] },
      aiTasks: {},
    } as unknown as BaziRecord;
    const plan = { recordId: 'r1', personName: '张三', matchedCount: 1, topics: ['财运'], scan: true } as ChatPlan;
    expect(plan.scanFrom, '夹具前提：这条计划确实没带 scanFrom').toBeUndefined();
    const ev = onUtcDevice(() => buildEvidence(record, plan));
    /* 缺批断时走的是 missing 文案那条路，窗口起点同样得是北京年。 */
    expect(ev.missing.join('\n'), '取证窗口起点不是北京年(UTC 设备上前移一年)')
      .toContain('2026年至' + (2026 + SCAN_YEARS - 1) + '年');
    expect(ev.missing.join('\n'), '窗口里混进了本地年的读数').not.toContain('2025年');
  });

  it('追问继承分支给出的仍是北京年月(行为回归，非跨时区读数判据)', () => {
    /* applyFollowUp 在继承上一轮「本月/今年」时调用 whenOfQuestion(prevUser?.content, now)。
       ⚠ 服务端同构用例(chat-timezone.test.mjs)实测：把这一处换成 new Date()(S6 变异)本用例仍全绿，
       因为下游 chinaYear/chinaDateParts 走 +8h→getUTC*，喂进来的时钟是本地还是 UTC 都会折回北京值；
       而进程内桩抵消不了这一步。所以这里钉的是「继承分支确实跑了并输出北京年月」这条行为，
       不能读成「已验证跨时区读数」。读数级判据见 TZ 子进程探针与服务端 readings 电池。 */
    const plan = onUtcDevice(() => applyFollowUp(
      { recordId: null, personName: null, matchedCount: 0, topics: [], question: '那财运呢' } as ChatPlan,
      [{ role: 'user', content: '本月注意什么' }],
      [],
    ));
    expect(plan.year, '追问继承年份不是北京年').toBe(2026);
    expect(plan.month, '追问继承月份不是北京月').toBe(1);
  });

  it('源码层钉子：chatEngine 不再直接读本地时区字段，且真的导入共享模块', () => {
    /* 逐行看代码(剥掉注释)，凡按 `now` 取年月的地方都不许再用本地字段。 */
    const code = engineSrc.split('\n')
      .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, ''))
      .filter((l) => /cm|nowYear|monthFromText|extractWhen|scanFrom|getFullYear|getMonth/.test(l));
    const localReads = code.filter((l) => /now\.get(FullYear|Month|Date)\(\)/.test(l));
    expect(localReads, '仍有按设备本地时区取年月的行:\n' + localReads.join('\n')).toEqual([]);
    expect(engineSrc, 'chatEngine 没导入北京口径模块').toMatch(/import \{[^}]*china(Ymd|Year)[^}]*\} from '\.\.\/utils\/date'/);
    /* 扫描面非空自证：筛出来 0 行的话上面的 not.toEqual 是永真的空判据。 */
    expect(code.length, '扫描面为空，判据恒真').toBeGreaterThan(3);
  });
});
