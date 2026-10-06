/* 缺陷 #96：界面上的公历/交运日期把「二十六日」念成「二六日」。

   根因是展示层用错了读法函数。shared/chineseReadAloud 里有两个语义不同的读数器：
     - cnCount(n)：年份/人数这类**逐位**读(1990 → 一九九〇，26 → 二六)，文件注释写明
       「≤二十用整体读法，再大就逐位读；人数/序号够用，年份请走 cnYear」;
     - cnSmall(n)：≤99 的**规范中文数**(26 → 二十六、12 → 十二)。
   同仓库的 src/utils/buildInfo.ts:11 给构建时间戳自己又写了一份私有 cnSmall，注释与
   shared 那份逐字相同(「十几读十二、整十读二十、其余读二十三」) —— 也就是说项目对
   「月/日/时/分该怎么念」早有定论，buildLabel 走的是规范读法。

   但 PersonDetail.tsx:192 与 RecordsPage.tsx:30 **两份重复的 cnDate** 都用 cnCount 念月和日：
     1979-11-23 → 「一九七九年十一月二三日」   (应为「二十三日」)
   而同一屏的起运文案(PersonDetail.tsx:186)却用 cnCount 念年龄跨度，那里 3 年读「三岁」是对的 ——
   问题只在「日」这一档会超过二十。列表行、详情页「贰、排盘数据」、大运表「交运日」三处同源受影响。

   本文件钉三件事(修复前后都成立)：
     1) 夹具前提：引擎把这条盘定位到 1979-11-23，且两端**都真的渲染出**日期
        (否则相等断言在空集上永真);
     2) 等价性钉子：两条展示路在同一输入上读出同一个字符串 —— 双份实现漂移时这里先红，
        并指出是哪一侧分叉;
     3) 口径钉子：月/日念成规范中文数「二十三日」，与 buildLabel 同一口径。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { RecordsPage } from '../features/records/RecordsPage';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import { buildLabel } from '../utils/buildInfo';
import type { BaziRecord, Person, PersonDetailData } from '../types/domain';

const ID = 'date-parity';

/** 详情页「贰、排盘数据」那一格与列表行 .chart-summary 都只吃 nonAiResult 里的 solarDate，
 *  所以夹具直接用**真实引擎**算出来的排盘结果(不是手抄形状)：
 *  1979-11-23 正午的四柱经 lunar-javascript 实测为 己未/乙亥/甲午/庚午，
 *  该月只有这一天三柱全等 ⇒ 引擎定位回的 solarDate 必为 1979-11-23(下面当场钉住)。 */
const chart = calculateNonAi({ birthYear: 1979, birthMonth: 11, yearPillar: '己未', monthPillar: '乙亥', dayPillar: '甲午', hourPillar: '庚午' }, 'male');

const fixture = (): { people: Person[]; details: PersonDetailData[] } => {
  const record = {
    id: ID, name: '甲', gender: 'male', birthYear: 1979, birthMonth: 11,
    createdAt: '2025-01-01T00:00:00.000Z',
    yearPillar: '己未', monthPillar: '乙亥', dayPillar: '甲午', hourPillar: '庚午',
    aiStatus: 'completed', nonAiResult: structuredClone(chart),
  } as unknown as BaziRecord;
  const person: Person = { id: ID, name: '甲', nameInitial: 'J', gender: 'male', birthSummary: '己未年' };
  return { people: [person], details: [{ person, record: structuredClone(record), aiAnalysis: { status: 'completed', result: 'x' } }] };
};

/** 详情页 dt=公历日期 那一格的实际读数；渲染不出返回空串(交给夹具前提判红)。 */
async function detailReading(): Promise<string> {
  render(<PersonDetail personId={ID} onBack={vi.fn()} />);
  try {
    const cell = await screen.findByText('公历日期', {}, { timeout: 1500 });
    const dd = (cell.parentElement as HTMLElement).querySelector('dd') as HTMLElement | null;
    return dd?.textContent?.trim() ?? '';
  } catch {
    return '';
  } finally {
    cleanup();
  }
}

/** 记录列表 .chart-summary 里的日期段（整行形如「公历…，生肖…，日主…」）。 */
async function listReading(): Promise<string> {
  render(<RecordsPage onOpenPerson={vi.fn()} />);
  try {
    const row = await screen.findByText(/^公历.+，生肖/, undefined, { timeout: 1500 });
    const m = /^公历(.+?)，/.exec(row.textContent ?? '');
    if (!m) throw new Error(String(row.textContent));
    return m[1].trim();
  } catch {
    return '';
  } finally {
    cleanup();
  }
}

beforeEach(() => {
  const f = fixture();
  initializeMockSession(f.people, f.details);
});
afterEach(() => { cleanup(); resetMockSession(); });

describe('公历日期读法(缺陷 #96：两位数日被逐位读成「二三日」)', () => {
  it('夹具前提：引擎确实把这条盘定位到 1979-11-23，且两端都渲染得出日期(否则相等断言在空集上永真)', async () => {
    expect(chart.solarDate, '夹具四柱在这个月里定位不到预期日期，下面的读数没有意义').toBe('1979-11-23');
    const a = await detailReading();
    const b = await listReading();
    expect(a, '详情页没渲染出公历日期 ⇒ 本文件的比对什么都没测').not.toBe('');
    expect(b, '列表页没渲染出公历日期 ⇒ 本文件的比对什么都没测').not.toBe('');
  });

  it('钉子一(等价性)：同一 ISO 在详情页与列表页读出同一个字符串(两份 cnDate 实现漂移时先红)', async () => {
    const a = await detailReading();
    const b = await listReading();
    expect(b, '两处公历日期读法分叉 ⇒ 有人只改了其中一份 cnDate 实现').toBe(a);
  });

  /* 缺陷 #96 修复后的承诺读数。修复前这里的实际读数是「一九七九年十一月二三日」
     (cnCount 超过二十就逐位读)，与同仓库 buildLabel 的规范读法自相矛盾；
     两条展示路(PersonDetail / RecordsPage 各一份 cnDate)一起改成 cnSmall 念月/日。
     ⚠ 若这条转红且读数回到「二三日」⇒ 有人把其中一侧改回去了，看钉子一谁先分叉。 */
  it('钉子二(口径)：两位数日按中文数读成「二十三日」，与构建时间戳同一口径', async () => {
    const a = await detailReading();
    expect(a).toBe('一九七九年十一月二十三日');
    /* 同一套汉字词表在构建时间戳那条路上读的也是规范数 —— 两处一致才算收敛完成。 */
    expect(buildStampDay(), 'buildLabel 与本文件读的不是同一个「日」的口径').toContain('二十二');
  });

  it('钉子三(交叉印证)：个位日不受影响，两端仍同源(排除“所有日期都读错”这种过度归因)', async () => {
    const single = { ...structuredClone(chart), solarDate: '1984-02-06' };
    const f = fixture();
    f.details[0].record = { ...f.details[0].record, nonAiResult: single as never };
    initializeMockSession(f.people, f.details);
    const a = await detailReading();
    const b = await listReading();
    expect(a).toBe('一九八四年二月六日');
    expect(b).toBe(a);
  });
});

/** 「日」那一档的规范读法在同仓库里确实存在并被使用：buildInfo.ts:11 的私有 cnSmall
 *  注释与 shared/chineseReadAloud 的 cnSmall 逐字相同。这里拿一个「22 日」的时间戳正向印证，
 *  不在本文件抄第二份读法实现。 */
function buildStampDay(): string {
  const at = new Date(2026, 9, 22, 9, 5);   // 本地构造；buildLabel 内部按北京口径取分量
  return buildLabel(String(at.getTime()));
}
