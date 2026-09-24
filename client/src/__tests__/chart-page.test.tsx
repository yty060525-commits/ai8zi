import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartPage } from '../features/chart/ChartPage';
import '../features/chart/nonAiCalculator'; // 预载引擎(缓存)，让页面内的按需加载立即命中
import { loadTrueSolarProvinces } from '../features/chart/trueSolarCities';
await loadTrueSolarProvinces(); // 预热真太阳时表(此 await 在 fake timers 之前)，令 ChartPage 效应内复用已解析 promise；app 端仍是首屏懒加载

afterEach(cleanup);

describe('ChartPage simplified form', () => {
  it('only exposes name, gender, birth year, and birth month', () => {
    render(<ChartPage />);
    expect(screen.getByLabelText('姓名')).toBeTruthy();
    expect(screen.getByLabelText('出生年')).toBeTruthy();
    expect(screen.getByLabelText('出生月')).toBeTruthy();
    expect(screen.getByRole('group', { name: '性别' })).toBeTruthy();
    expect(screen.queryByText('分类')).toBeNull();
    // 历法选择现在是刻意提供的(阳历/农历)，默认阳历；不再有「公历/农历」二选一的旧式录入按钮组以外形态
    expect(screen.getByRole('group', { name: '历法' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '阳历(公历)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '农历(夏历)' })).toBeTruthy();
    expect(screen.queryByText(/额度|费用|基础排盘结果|排盘状态/)).toBeNull();
  });

  it('submits a typed record, closes the modal, and requests records navigation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-08T12:34:56.000Z'));
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    fireEvent.click(screen.getByRole('button', { name: '手录四柱' })); // 手录路径：先切到「手录四柱」模式
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '测试用户' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '1984' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '录入四柱八字' }));
    for (const [label, value] of [['年柱', '甲子'], ['月柱', '丙寅'], ['日柱', '庚午'], ['时柱', '壬午']] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); }); // 等待按需加载引擎的微任务完成
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({ name: '测试用户', gender: 'male', birthYear: 1984, birthMonth: 2, yearPillar: '甲子', createdAt: '2025-03-08T12:34:56.000Z', nonAiResult: expect.objectContaining({ dayMaster: '庚' }) }));
    vi.useRealTimers();
  });

  it('按生日自动排盘：填日期时辰即算出四柱并保存，无需手录', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-08T12:34:56.000Z'));
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />); // 默认即「按生日排」模式
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '自动命主' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '2000' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('出生日'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('时(0–23)'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('分(0–59)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    // 2000-02-05 立春后 08:00 辰时 → 庚辰 戊寅 癸巳 丙辰
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({
      name: '自动命主', birthYear: 2000, birthMonth: 2,
      yearPillar: '庚辰', monthPillar: '戊寅', dayPillar: '癸巳', hourPillar: '丙辰',
      nonAiResult: expect.objectContaining({ dayMaster: '癸' }),
    }));
    vi.useRealTimers();
  });

  it('按生日模式：该日期不存在时提示、且不落库', async () => {
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '某人' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '2001' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('出生日'), { target: { value: '30' } }); // 2 月无 30 日
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
    expect(screen.getByRole('alert').textContent).toContain('该日期不存在');
    expect(onRecordCreated).not.toHaveBeenCalled();
  });

  it('手录模式仍显示出生年月两栏、隐藏日/时/分', () => {
    render(<ChartPage />);
    expect(screen.getByLabelText('出生日')).toBeTruthy(); // 默认 auto 模式有日栏
    fireEvent.click(screen.getByRole('button', { name: '手录四柱' }));
    expect(screen.queryByLabelText('出生日')).toBeNull();
    expect(screen.queryByLabelText('时(0–23)')).toBeNull();
    expect(screen.getByLabelText('出生月')).toBeTruthy();
  });

  it('农历模式：切到农历后标签随之改，存的是换算出的公历年月并通过引擎校验', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-08T12:34:56.000Z'));
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    fireEvent.click(screen.getByRole('button', { name: '农历(夏历)' }));
    // 农历态下月/日标签改成农历口径，并出现「闰月」勾选
    expect(screen.getByLabelText('月(农历)')).toBeTruthy();
    expect(screen.getByLabelText('日(初几)')).toBeTruthy();
    expect(screen.getByLabelText('闰月')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '农历命主' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '1990' } });
    fireEvent.change(screen.getByLabelText('月(农历)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('日(初几)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('时(0–23)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('分(0–59)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    // 农历 1990 五月十五 = 公历 1990-06-07：库中存公历年月，若误存农历 5 月则引擎在该月找不到此四柱会报错
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({ birthYear: 1990, birthMonth: 6, nonAiResult: expect.objectContaining({ dayMaster: expect.any(String) }) }));
    expect(screen.queryByRole('alert')).toBeNull();
    vi.useRealTimers();
  });

  it('农历闰月：勾选闰月后按闰月换算，非法农历日期给出中文提示且不落库', async () => {
    vi.useFakeTimers();
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    fireEvent.click(screen.getByRole('button', { name: '农历(夏历)' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '闰命主' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '2023' } });
    fireEvent.change(screen.getByLabelText('月(农历)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('日(初几)'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText('闰月')); // 2023 有闰二月 → 公历 2023-03-22
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({ birthYear: 2023, birthMonth: 3 }));
    vi.useRealTimers();

    // 换一条不存在的闰月(2023 无闰五)：应中文提示、不落库
    cleanup();
    const onSecond = vi.fn();
    render(<ChartPage onRecordCreated={onSecond} />);
    fireEvent.click(screen.getByRole('button', { name: '农历(夏历)' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '错命主' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '2023' } });
    fireEvent.change(screen.getByLabelText('月(农历)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('日(初几)'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText('闰月'));
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); });
    expect(screen.getByRole('alert').textContent).toContain('该农历日期不存在');
    expect(onSecond).not.toHaveBeenCalled();
  });

  it('真太阳时省→市→区联动：有区的市须选到区，按区经度修正改变时柱；缺市/缺区各给提示', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-08T12:34:56.000Z'));
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    // 省市区整表惰性加载：先等微任务把 provinces 填进下拉
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '乌市命主' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '2025' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('出生日'), { target: { value: '21' } });
    fireEvent.change(screen.getByLabelText('时(0–23)'), { target: { value: '10' } });
    // 选了省但未选市 → 提示，不落库
    fireEvent.change(screen.getByLabelText('真太阳时·省'), { target: { value: '新疆维吾尔自治区' } });
    expect(screen.getByLabelText('市')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); });
    expect(screen.getByRole('alert').textContent).toContain('请选择出生所在城市');
    expect(onRecordCreated).not.toHaveBeenCalled();
    // 乌鲁木齐市下有区：只选市不选区 → 提示，不落库
    fireEvent.change(screen.getByLabelText('市'), { target: { value: '乌鲁木齐市' } });
    expect(screen.getByLabelText('区/县')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); });
    expect(screen.getByRole('alert').textContent).toContain('请选择出生所在区/县');
    expect(onRecordCreated).not.toHaveBeenCalled();
    // 选到区 天山区(87.6°E)：10:00 修正后落辰时(北京则巳时)，且不再显示经度数值提示
    fireEvent.change(screen.getByLabelText('区/县'), { target: { value: '天山区' } });
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    expect(screen.queryByText(/°E/)).toBeNull();
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({
      hourPillar: expect.stringMatching(/辰$/),
    }));
    vi.useRealTimers();
  });

  it('真太阳时·直辖市：省级即列区、止于区一级(无独立市下拉)', async () => {
    vi.useFakeTimers();
    const onRecordCreated = vi.fn();
    render(<ChartPage onRecordCreated={onRecordCreated} />);
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '京命主' } });
    fireEvent.change(screen.getByLabelText('出生年'), { target: { value: '2025' } });
    fireEvent.change(screen.getByLabelText('出生月'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('出生日'), { target: { value: '21' } });
    fireEvent.change(screen.getByLabelText('时(0–23)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('真太阳时·省'), { target: { value: '北京市' } });
    // 直辖市第二级标签是「区」，选到区即可，无第三级
    expect(screen.getByLabelText('区')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('区'), { target: { value: '朝阳区' } });
    expect(screen.queryByLabelText('区/县')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '排盘并保存' }));
    await act(async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); });
    // 朝阳 116.5°E，10:00 修正约 09:46 仍巳时(与不修正同为巳)
    expect(onRecordCreated).toHaveBeenCalledWith(expect.objectContaining({ hourPillar: expect.stringMatching(/巳$/) }));
    vi.useRealTimers();
  });
});