/* 【判据空白 #151 · 界面半边】详情页必须真的能**改**四柱，而且改完整张盘跟着变。

   pillar-edit-recompute.test.ts 钉的是引擎语义与源码同源；那份全绿也仍可能
   「按钮没接上 / 提交后没落库 / 界面显示新柱但排盘数据还是旧的」。本文件走真实交互：
   点「编辑数据」→ 原位置修改日柱和时柱 → 点「保存修改」→ 读回 DOM 与存储。

   ⚠ 变异口径(每条都要单独跑，见文末)：
     M1 删掉 <BirthInputModal …initial=…/> ⇒ 找不到弹窗，红
     M2 applyPillarEdit 只写四柱、不重算(去掉 calculateNonAi 那行改用旧 nonAiResult) ⇒ 「五行/大运跟着变」红
     M3 落库时丢掉 birthDay ⇒ 换日夹具那条公历日判据红
     M4 保存后 setRecord 用现算的完整对象而不走 refreshRecord ⇒ 需看读取侧清洗，如实记录能否杀掉的结论
   夹具一律由 computePillarsFromDate 反查真实日期(#150 的教训：手写干支会被引擎拒)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { getBaziRecord, initializeMockSession, listBaziRecords, resetMockSession } from '../data/clientRepository';
import { calculateNonAi, computePillarsFromDate } from '../features/chart/nonAiCalculator';
import { cnCount } from '../shared/chineseReadAloud';
import type { BaziRecord, Person } from '../types/domain';

const ID = 'edit-person';

/** 1984-02-06 上午：立春后，年柱属甲子年前一柱；这里不假设具体干支，全部取自引擎读数。 */
const PILLARS = computePillarsFromDate({ year: 1984, month: 2, day: 6, hour: 10 });
/** 「修正后的命盘」= 同月内另一个真实日期、同一时辰整组重排。
 *  ⚠ 不能只换日柱：时柱由日干经五鼠遁唯一确定(#748 会校验)，单换日柱必被拒。
 *  我第一版就是这么写的 —— TARGET 取的是「戊寅日巳时」那一组，而测试里只把日柱塞进去，
 *  于是引擎报「时柱与出生日不合」，保存从未发生，waitFor 超时。那红的是我的夹具，不是产品。 */
const TARGET = computePillarsFromDate({ year: 1984, month: 2, day: 14, hour: 10 });
const BIRTH_TIME = { year: 1984, month: 2, day: 6, hour: 10, minute: 15 };
const CHART = calculateNonAi({ birthYear: 1984, birthMonth: 2, birthDay: 6, birthTime: BIRTH_TIME, ...PILLARS }, 'male');
// 当场自证夹具前提：两组四柱彼此不同，且各自都能排出盘(上面两行已隐含，这里点名日柱)。
if (TARGET.dayPillar === PILLARS.dayPillar) throw new Error('夹具失效：修正前后的日柱相同，判据将落在空集上');

const person: Person = { id: ID, name: '待修', nameInitial: 'D', gender: 'male', birthSummary: '一九八四年' };
const recordOf = (): BaziRecord => ({
  id: ID, name: '待修', gender: 'male', birthYear: 1984, birthMonth: 2,
  createdAt: '2025-01-01T00:00:00.000Z',
  ...PILLARS,
  aiStatus: 'completed', nonAiResult: structuredClone(CHART),
} as unknown as BaziRecord);

beforeEach(() => {
  const r = recordOf();
  initializeMockSession([person], [{ person, record: structuredClone(r), aiAnalysis: { status: 'completed', result: 'x' } }]);
});
afterEach(() => { cleanup(); resetMockSession(); vi.restoreAllMocks(); });

/** 「贰、排盘数据」那一格的读数。两条实测口径要记牢，都是我在这里踩过两次的：
 *  1) 必须限定在这个 region 内取 ——「壹、基础信息」格里也有 dt=日柱(它读 record)，全局 findByText
 *     会先命中那张；弹窗还开着时读到旧值，看着像「没重算」。
 *  2) 这张格渲染的是 fields.slice(1)(PersonDetail.tsx:275)，**四柱本身不在这张格里** ——
 *     命盘四柱只出现在同区 .chart-columns 的 dt=四柱，值是引擎 result.pillars 顿号连接的四柱。
 *     我按 dt=日柱 到这张格找，查的是本就不存在的一格，红在自己的假设上。
 *  渲染不出返回空串，交给下面的前提判红，绝不让断言落在空集上。 */
async function cell(label: string): Promise<string> {
  try {
    // findByRole 只接受 (role, queries, options) 三参：第四参会被 tsc -b 挡下(TS2554)，
    // 超时只能放进第三参的 waitForOptions。
    const grid = await screen.findByRole('region', { name: '基础排盘数据' }, { timeout: 2000 });
    const dt = within(grid).queryAllByText(label)[0];
    if (!dt) return '';
    const dd = (dt.parentElement as HTMLElement).querySelector('dd');
    return dd?.textContent?.trim() ?? '';
  } catch { return ''; }
}
/** 整组四柱的读数(顿号连接)，取自引擎 result.pillars；拆成四段供逐柱比对。 */
async function pillarCell(): Promise<string[]> {
  const v = await cell('四柱');
  return v ? v.split('、') : [];
}
/** 打开弹窗 → 把整组四柱换成目标命盘 → 提交。返回提交前后的日柱读数，供前后对比。 */
async function editToTarget() {
  render(<PersonDetail personId={ID} onBack={vi.fn()} />);
  await screen.findByRole('heading', { name: '人物详情' });
  const before = (await pillarCell())[2];
  fireEvent.click(screen.getByRole('button', { name: '编辑数据' }));
  const dialog = await screen.findByRole('region', { name: '基础信息' });
  expect(within(dialog).getByLabelText('日柱')).toHaveProperty('value', PILLARS.dayPillar);
  for (const [label, value] of [['年柱', TARGET.yearPillar], ['月柱', TARGET.monthPillar], ['日柱', TARGET.dayPillar], ['时柱', TARGET.hourPillar]]) fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  return { before, dialog };
}

describe('#151 修正四柱：真实交互路径', () => {
  it('前提：入口按钮存在，且弹窗里的四柱预填成当前命盘', async () => {
    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    fireEvent.click(screen.getByRole('button', { name: '编辑数据' }));
    const dialog = await screen.findByRole('region', { name: '基础信息' });
    expect(['年柱', '月柱', '日柱', '时柱'].map((label) => (within(dialog).getByLabelText(label) as HTMLInputElement).value)).toEqual([PILLARS.yearPillar, PILLARS.monthPillar, PILLARS.dayPillar, PILLARS.hourPillar]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('详情预填后以 composition 修正整串，确认保存并重排到存储', async () => {
    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    fireEvent.click(screen.getByRole('button', { name: '编辑数据' }));
    const dialog = await screen.findByRole('region', { name: '基础信息' });
    const input = within(dialog).getByLabelText('日柱') as HTMLInputElement;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: TARGET.dayPillar + 'p' } });
    expect(input.value).toBe(TARGET.dayPillar + 'p');
    fireEvent.compositionEnd(input, { data: TARGET.dayPillar });
    fireEvent.change(input, { target: { value: TARGET.dayPillar } });
    fireEvent.change(within(dialog).getByLabelText('时柱'), { target: { value: TARGET.hourPillar } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(async () => expect((await getBaziRecord(ID))?.dayPillar).toBe(TARGET.dayPillar));
    expect((await getBaziRecord(ID))?.nonAiResult?.pillars.hour).toBe(TARGET.hourPillar);
    cleanup();
  });

  it('整组改柱并保存 ⇒ 四柱、五行、大运跟随重算且不单列日主', async () => {
    const EXPECTED = calculateNonAi({ birthYear: 1984, birthMonth: 2, birthDay: 6, ...TARGET }, 'male');
    const { before } = await editToTarget();
    expect(before, '详情页没渲染出「四柱」那一格(或它不是四段)').not.toBe('');
    expect(TARGET.dayPillar).not.toBe(before);
    await waitFor(async () => expect((await pillarCell())[2]).toBe(TARGET.dayPillar));
    // 派生事实必须跟着换 —— 这三格是「只换字符串不重算」最能露形的一组合。
    const chart = screen.getByRole('region', { name: '基础排盘数据' });
    expect([...chart.querySelectorAll('dt')].map((dt) => dt.textContent?.trim())).not.toContain('日主');
    await waitFor(async () => expect((await getBaziRecord(ID))?.nonAiResult?.dayMaster).toBe(EXPECTED.dayMaster));
    /* 「贰、排盘数据」那一格走 mapText，计数读成中文数(实测读数「木三、火三、土一、金零、水一」)。
       第一版我按引擎原始值拼了阿拉伯数字，红在文案层而不是语义层 —— 期望值必须来自被测口径本身。 */
    expect(await cell('五行'), '五行还是旧盘计数 ⇒ 没走引擎重算').toBe(
      Object.entries(EXPECTED.elements).map(([k, v]) => `${k}${cnCount(v)}`).join('、'),
    );
    expect((await screen.findByRole('region', { name: '大运' })).textContent).toContain(EXPECTED.greatFortunes[0].ganZhi);
    cleanup();
  });

  it('落库的不只是显示：存储里这条记录的四柱与新排盘结果一致', async () => {
    await editToTarget();
    await waitFor(async () => expect((await getBaziRecord(ID))?.dayPillar).toBe(TARGET.dayPillar));
    const stored = (await listBaziRecords()).find((r) => r.id === ID);
    expect(stored?.nonAiResult?.pillars.day).toBe(TARGET.dayPillar);
    expect(stored?.nonAiResult?.dayMaster).toBe(TARGET.dayPillar[0]);
    expect(stored?.nonAiResult?.birthTime).toBeUndefined();
    cleanup();
  });

  it('壹、基础信息那张格(以及「复制基础信息」的来源)也换成新柱', async () => {
    // getBasicFields 读的是 record 上的四列，不读 nonAiResult —— 若 applyPillarEdit 只更新
    // nonAiResult 而漏掉 ...pillars，这张格会与「贰」分叉：一处新柱一处旧柱，复制出来的也是旧的。
    await editToTarget();
    await waitFor(async () => expect((await pillarCell())[2]).toBe(TARGET.dayPillar));
    const basic = await screen.findByRole('region', { name: '基础信息' });
    const read = (label: string) => {
      const dt = within(basic).queryAllByText(label)[0];
      return dt ? (dt.parentElement as HTMLElement).querySelector('dd')?.textContent?.trim() ?? '' : '';
    };
    expect(read('日柱'), '基础信息还是旧柱 ⇒ 写库时没带 ...pillars').toBe(TARGET.dayPillar);
    expect(read('时柱')).toBe(TARGET.hourPillar);
    cleanup();
  });

  it('非法修正被拒绝：留在弹窗里报错，命盘一个字都不改', async () => {
    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    fireEvent.click(screen.getByRole('button', { name: '编辑数据' }));
    const dialog = await screen.findByRole('region', { name: '基础信息' });
    const badHour = '甲子';
    fireEvent.change(within(dialog).getByLabelText('时柱'), { target: { value: badHour } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存修改' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('时柱与出生日不合');
    expect((within(dialog).getByLabelText('时柱') as HTMLInputElement).value).toBe(badHour);
    expect(await pillarCell()).not.toEqual([]);
    expect((await getBaziRecord(ID))?.hourPillar).toBe(PILLARS.hourPillar);
    cleanup();
  });

  it('换日盘修正后仍锚在真实生日：公历日期不许被进一的日柱带偏到次日', async () => {
    // 另建一条 23 点后出生、开了早子时换日的盘：日柱已是次日干支，birthDay 记着真实日。
    const shifted = computePillarsFromDate({ year: 1984, month: 2, day: 6, hour: 23 }, { ziShiftDay: true });
    const birthTime = { year: 1984, month: 2, day: 6, hour: 23, minute: 0 };
    const shiftedChart = calculateNonAi({ birthYear: 1984, birthMonth: 2, birthDay: 6, birthTime, ...shifted }, 'male');
    resetMockSession();
    const rec = {
      id: ID, name: '待修', gender: 'male', birthYear: 1984, birthMonth: 2,
      createdAt: '2025-01-01T00:00:00.000Z', ...shifted,
      aiStatus: 'completed', nonAiResult: structuredClone(shiftedChart),
    } as unknown as BaziRecord;
    initializeMockSession([person], [{ person, record: structuredClone(rec), aiAnalysis: { status: 'completed' } }]);
    // 前提：这张盘的日柱确实属于次日，否则下面那句「公历日没被带偏」证明不了任何事。
    expect(shiftedChart.solarDate).toBe('1984-02-06');
    expect(shifted.dayPillar).not.toBe(computePillarsFromDate({ year: 1984, month: 2, day: 5, hour: 10 }).dayPillar);

    render(<PersonDetail personId={ID} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    fireEvent.click(screen.getByRole('button', { name: '编辑数据' }));
    await screen.findByRole('region', { name: '基础信息' });
    // 只动四柱以外的字段会牵动定位；这里四柱一字不改、直接保存，专测 birthDay 有没有传下去。
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('button', { name: '编辑数据' });
    await waitFor(async () => expect((await getBaziRecord(ID))?.nonAiResult?.solarDate).toBe('1984-02-06'));
    expect(await cell('公历日期')).toContain('一九八四年二月六日');
    expect((await getBaziRecord(ID))?.nonAiResult?.birthTime).toEqual(birthTime);
    cleanup();
  });
});
