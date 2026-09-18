import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserDirect } from '../data/deepseekAdapter';

/**
 * 回归：网页直连必须尊重“当前使用通道”，而不是写死 DeepSeek。
 * 曾经 browserDirect 硬编码 DeepSeek 端点与凭据，导致设置里切到 Qwen 也毫无作用。
 */
const record = {
  id: 'r1', name: '测试', gender: 'male', birthYear: 1990, birthMonth: 6,
  yearPillar: '庚午', monthPillar: '壬午', dayPillar: '甲子', hourPillar: '甲子',
  createdAt: '2026-01-01T00:00:00.000Z', aiStatus: 'not_started',
  nonAiResult: { dayMaster: '甲', zodiac: '马', solarDate: '1990-06-15', elements: {}, tenGods: [], hiddenStems: [], relationships: {} },
} as never;
const task = { taskId: 'task-01', type: 'baseline' } as never;
const okReply = { choices: [{ message: { content: JSON.stringify({ pattern: '正印格', strength: '身强', usefulElements: ['火'], avoidElements: ['水'], explanation: '【健康】1. 好。' }) } }] };

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  try { localStorage.clear(); } catch { /* ignore */ }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => okReply } as never; }));
});
afterEach(() => { vi.unstubAllGlobals(); try { localStorage.clear(); } catch { /* ignore */ } });

describe('网页直连按当前使用通道路由', () => {
  it('选中 qwen 时打 DashScope 端点并带 qwen3.8-flash', async () => {
    localStorage.setItem('mingli.provider', 'qwen');
    localStorage.setItem('mingli.cred.qwen', 'qwen-key');
    const res = await browserDirect(record, task);
    expect(res.status).toBe('completed');
    expect(calls[0]).toContain('dashscope.aliyuncs.com');
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe('qwen3.8-flash');
    expect(body.enable_thinking).toBe(false); // 关闭思考，实测快约 3.8 倍
  });

  it('选中 deepseek 时打官方端点', async () => {
    localStorage.setItem('mingli.provider', 'deepseek');
    localStorage.setItem('mingli.cred.deepseek', 'ds-key');
    await browserDirect(record, task);
    expect(calls[0]).toContain('api.deepseek.com');
  });

  it('当前通道未配凭据时自动回退到其它已配置通道', async () => {
    localStorage.setItem('mingli.provider', 'qwen'); // 使用中但未配
    localStorage.setItem('mingli.cred.kimi', 'kimi-key');
    const res = await browserDirect(record, task);
    expect(res.status).toBe('completed');
    expect(calls[0]).toContain('moonshot.cn');
  });

  it('所有通道都未配置时给出可读原因', async () => {
    localStorage.setItem('mingli.provider', 'qwen');
    const res = await browserDirect(record, task);
    expect(res.status).toBe('failed');
    expect(String((res as { error?: string }).error)).toContain('未配置凭据');
  });

  it('后天调整任务会带上本命结论与资料库(离线备用通道不再凭空发挥)', async () => {
    localStorage.setItem('mingli.provider', 'deepseek');
    localStorage.setItem('mingli.cred.deepseek', 'ds-key');
    const task = { taskId: 'task-30', type: 'adjustment', baseline: { summary: '格局：正印格 · 强弱：身强　喜：火、土　忌：水、木' }, guide: { element: '火', lifestyle: '多接触温暖环境' } } as never;
    await browserDirect(record, task);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    const content = String(body.messages[1].content);
    expect(content).toContain('本命结论');
    expect(content).toContain('正印格');
    expect(content).toContain('资料库');
    expect(content).toContain('多接触温暖环境');
    expect(content).toContain('后天调整与职业适配');
  });

  it('大运任务不带年龄推算字段', async () => {
    localStorage.setItem('mingli.provider', 'deepseek');
    localStorage.setItem('mingli.cred.deepseek', 'ds-key');
    const task = { taskId: 'task-24', type: 'decade', year: 2026, baseline: { summary: '格局：正印格' } } as never;
    await browserDirect(record, task);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    const content = String(body.messages[1].content);
    expect(content).not.toContain('年龄约');
    expect(content).toContain('本时段数据');
  });
});

describe('网页直连的时段数据与全盘总结(回归)', () => {
  /** 真实存储是瘦身的：三个数组落库即清空。此前 browserDirect 只读数组 → 离线通道发出空的「本时段数据」。 */
  it('瘦身记录 + 任务内联行：仍把本期干支与命中发给模型', async () => {
    localStorage.setItem('mingli.provider', 'deepseek');
    localStorage.setItem('mingli.cred.deepseek', 'ds-key');
    const slim = Object.assign({}, record, { nonAiResult: { dayMaster: '甲', zodiac: '马', solarDate: '1990-06-15', elements: {}, tenGods: [], hiddenStems: [], relationships: {}, shenSha: { auspicious: ['天乙'], inauspicious: [], items: [{ name: '驿马', pillarIndex: 1, position: '地支', basis: '年支' }] }, greatFortunes: [], annualFortunes: [], monthlyFortunes: [] } }) as never;
    const task = { taskId: 'task-03', type: 'annual', year: 2027, baseline: { summary: '格局：正印格' }, annual: { year: 2027, ganZhi: '丙午', relationshipDetails: [{ type: 'liuHe', sourcePillar: '丙午', targetPillar: '甲子', status: 'complete' }] }, decade: { ganZhi: '丁卯', startYear: 2020, endYear: 2029 } } as never;
    await browserDirect(slim, task);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    const content = String(body.messages[1].content);
    expect(content).toContain('丙午');           // 流年干支必须带上(旧版为空)
    expect(content).toContain('丁卯');           // 所处大运
    expect(content).toContain('六合(甲子)');      // 刑冲克害命中串
    expect(content).toContain('驿马@月支');       // 神煞压缩口径与服务器一致
    expect(content.indexOf('# 本命事实数据')).toBeLessThan(content.indexOf('# 本时段数据'));
    expect(content.lastIndexOf('# 当前分析目标')).toBeGreaterThan(content.indexOf('# 本时段数据'));
  });

  it('全盘总结任务携带各时段要点，并要求按三段输出', async () => {
    localStorage.setItem('mingli.provider', 'deepseek');
    localStorage.setItem('mingli.cred.deepseek', 'ds-key');
    const task = { taskId: 'task-31', type: 'overview', baseline: { summary: '格局：正印格 · 强弱：身强　喜：火、土　忌：水、木' }, findings: { horizon: { from: 2026, to: 2035 }, decades: [], annuals: [{ key: 'a', heading: '2027年(丙午)', text: '【事业】1. 有升迁机会。' }], monthlies: [] } } as never;
    await browserDirect(record, task);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    const content = String(body.messages[1].content);
    expect(content).toContain('值得关注的时间节点');
    expect(content).toContain('核心结论');
    expect(content).toContain('行动建议');
    expect(content).toContain('各时段分析要点');
    expect(content).toContain('有升迁机会');
    expect(content).toContain('正印格');
    expect(body.reasoning_effort).toBe('high'); // 判断类任务用高思考力度
    expect(content.lastIndexOf('# 当前分析目标')).toBeGreaterThan(content.indexOf('# 各时段分析要点'));
  });
});
