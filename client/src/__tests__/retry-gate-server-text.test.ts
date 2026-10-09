import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyFailure, cnCode, providerLabel, AI_SERVER_UNCONFIGURED } from '../../../server/ai.mjs';
import { isRetryableFailure, ABORTED_MESSAGE } from '../data/baziOrchestrator';

/* 判据空白 #144：「这条失败值不值得再烧一次钱」是一份**跨端契约**，可两端各测各的字符串，
 * 中间那条链从来没人当整条链钉过。
 *
 * 消费方有**四处**(实测 grep，2026-10-09)，全部读同一个 `isRetryableFailure`
 * (client/src/data/baziOrchestrator.ts:81)，而它只认错误文本里的字样：
 * ① :526 任务主跑的再试闸门；② :623 整批跑完后「仍失败」补跑名单的筛选；③ :654 补跑循环内的再试；
 * ④ PersonDetail:557 详情页自动重试的排期早退。生产方有三份实现(浏览器直连 deepseekAdapter.classifyFailure、服务器 server/ai.mjs:329、桌面 lib.rs)。
 * 服务器 runOneTask(ai.mjs:441) 那句「未配置」回执会经 app.mjs:133 → runTaskOnServer(serverClient.ts:106)
 * → analyzeBazi(deepseekAdapter.ts:119) → baziOrchestrator:679-680 一路进到 record.aiError；详情页排
 * 自动重试读的就是 saved.aiError(PersonDetail:666)，而早退闸门只有 scheduleAutoRetry(:557) 那一句 ——
 * 控制器在 stopAnalysis 里已被置 null，所以 :579 那句 `!controllerRef.current?.signal.aborted` 恒真拦不住。
 * ⚠ 订正(实测，2026-10-09)：本文件初稿写的是「消费方只有一处」，那是**错的** —— 我只查了
 * record.aiError 那一条路径就下了全称结论。这个错不只是措辞：它把判据范围收窄了一半，所以下面
 * 专门加了一条用例钉住另外三处的共同前提(#112 的中止句必须过闸门)，而不是让注释替我背书。
 *
 * 实测取证(node --test + vitest，2026-10-09)：把 server/ai.mjs:322 的文案改成
 * 「服务器尚未接入任何通道，请机主补凭据」之后，服务器 133 条与客户端全量**照旧全绿**。
 * 已有的三份邻近判据都看不见这条链：api.test.mjs:100 只断 result.status==='not_configured'(不碰文本)；
 * channel-error-text.test.mjs:123 只断那句回执「不含英文数字」(方向相反)；auto-retry-schedule.test.tsx:25
 * 用的是自造串「未配置访问凭据(not_configured)」，不是任何一端的真实产物。 */

const QUOTA = providerLabel('qwen') + '：' + classifyFailure(200, '{"error":{"message":"insufficient balance"}}');

/* serverClient 必须整模块 mock：analyzeBazi 的服务器分支读的是 runTaskOnServer，而真实现会发 HTTP。
   用 importActual 保住 ServerError / isServerMode 这些同文件导出(deepseekAdapter 直接从那里拿类，
   换成替身类会让 :123 那句 `error instanceof ServerError` 恒假)。 */
vi.mock('../data/serverClient', async (importActual) => {
  const actual = await importActual<typeof import('../data/serverClient')>();
  return { ...actual, runTaskOnServer: vi.fn() };
});
import { runTaskOnServer } from '../data/serverClient';

describe('#144 服务器造的失败文本必须喂得动客户端的重试闸门', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('前提钉子：闸门确实拦得住浏览器直连那份同类文本(否则下面的比对是空转)', () => {
    // 浏览器直连那条路的产物带状态码尾巴「服务返回四零二」，命中闸门第二句。
    expect(isRetryableFailure('通道一千问：余额不足或额度已用完，服务返回四零二')).toBe(false);
    expect(isRetryableFailure('网络超时，请求未完成')).toBe(true);
  });

  it('服务器那句「未配置」回执不许被判成值得重试', () => {
    expect(isRetryableFailure(AI_SERVER_UNCONFIGURED),
      '这句会被当成可重试 ⇒ 对着一个根本没配密钥的中继白烧两轮自动重试：' + AI_SERVER_UNCONFIGURED).toBe(false);
  });

  for (const status of [400, 401, 402, 403, 404]) {
    it(`服务器状态码 ${status} 的说法(带中文数字尾巴)要拦住闸门`, () => {
      const text = providerLabel('qwen') + '：' + classifyFailure(status, '') + '，服务返回' + cnCode(status);
      expect(isRetryableFailure(text), `这句会被当成可重试：${text}`).toBe(false);
    });
  }

  it('反向钉子：五〇三与超时仍须判为值得重试(闸门不是见报错就停)', () => {
    expect(isRetryableFailure(providerLabel('deepseek') + '：' + classifyFailure(503, '') + '，服务返回' + cnCode(503)),
      '服务端故障应当允许重试').toBe(true);
    expect(isRetryableFailure('通道一深思：网络超时或不可达'), '超时应当允许重试').toBe(true);
    expect(isRetryableFailure(undefined), '空错误不该排重试').toBe(false);
  });

  it('现状如实登记 #145：按文案命中的额度句只在带状态码尾巴时才拦得住', () => {
    /* 【缺陷 #145】闸门认的是「HTTP 40x / 服务返回四…」这种**形态**，不认语义。于是同一条「余额不足」
       在两条形态不同的出口上命运不同：
       · callProvider(ai.mjs:411) 拼了「，服务返回」+ 状态码 ⇒ 拦得住；
       · chat.mjs:478 那一类只报分类说法、不带尾巴 ⇒ 拦不住，界面上写着「余额不足」还在自动重试。
       这里钉的是**现状读数**：尾巴在→拦住、尾巴没了→放行。有人想当然把闸门改成
       「含『余额』二字就拦」时，本条第二句会红，逼他先确认那些说法是不是真该停止重试
       (429 限流同样写进 aiError，一刀切会把该重发的限流也掐死)。 */
    expect(isRetryableFailure(QUOTA + '，服务返回四零二')).toBe(false);
    expect(isRetryableFailure(QUOTA)).toBe(true);   // ← 现状读数：裸的那句过不了闸门
  });

  it('网页版这一轮的真实产物：analyzeBazi 服务器分支原样带回服务器文本，且闸门判它不可重试', async () => {
    localStorage.setItem('mingli.server.url', 'http://127.0.0.1:9');
    localStorage.setItem('mingli.server.session', JSON.stringify({ token: 't', username: '甲', role: 'user' }));
    const { analyzeBazi } = await import('../data/deepseekAdapter');
    vi.mocked(runTaskOnServer).mockResolvedValue({ status: 'not_configured', error: AI_SERVER_UNCONFIGURED });
    const rec = { id: 'p144', name: '甲', gender: 'male', birthYear: 1984, birthMonth: 2,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' } as never;
    const result = await analyzeBazi(rec, { taskId: 'task-01', type: 'baseline' } as never);
    expect(result.status).toBe('not_configured');
    const error = (result as { error?: string }).error ?? '';
    expect(error).toBe(AI_SERVER_UNCONFIGURED);
    expect(isRetryableFailure(error), '这一轮的失败会被排成下一次自动重试：' + error).toBe(false);
  });

  it('#112 的机制前提：中止句必须能过闸门(另外三处消费方靠的就是这个读数)', () => {
    /* 上面说的那四处消费方里，:526/:623/:654 三处判的是**单条任务**的 error，不是 record.aiError。
       编排器把一次中止写成 toFailedResult(:422) → ABORTED_MESSAGE(:13)，而 #112 那份注释明确写着
       「ABORTED_MESSAGE 恰好也能过 isRetryableFailure ⇒ 单次调用绝不许抛出」—— 抛出会落到
       PersonDetail 那个 catch，把 aiError 写成这句、进而让自动重试在用户没点任何东西时静默断链。
       也就是说整条 #112 的修复都架在一个**文本层读数**上：这句必须为真。可全仓没有一条用例跨过
       这道边界(auto-retry-schedule:354 钉的是产品码里的三元式，读的是源码而不是闸门输出)。
       所以把 :13 改成「已停止：未配置继续」这种带「未配置」字样的说法，闸门立刻判假，而两套套件
       都不会红 —— 这正是本缺陷(#144)同一类的另一半，只是方向相反：不是该拦的没拦住，
       而是该放行的被一句改写的文案误杀。 */
    expect(isRetryableFailure(ABORTED_MESSAGE), '中止句被闸门误杀 ⇒ #112 那条链路的前提塌').toBe(true);
    /* 反向钉子：这句确实**不含**任何密钥/状态码形态，否则上面那条恒真是因为我抄了条空串。 */
    expect(ABORTED_MESSAGE).not.toMatch(/not_configured|未配置|credential|keyring/i);
    expect(ABORTED_MESSAGE).not.toMatch(/HTTP 40[0-9]|服务返回四[零一二三四五六七八九]/);
  });
});
