import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyFailure as clientCF, cnCode as clientCn } from '../data/deepseekAdapter';
import { classifyFailure as srvCF, cnCode as srvCn, providerLabel } from '../../../server/ai.mjs';
import { isRetryableFailure, orchestrateBaziAnalysis } from '../data/baziOrchestrator';

/* 判据空白 #148：闸门(:81)那句注释写着「密钥类/权限类不盲试」，可**没有任何一条用例读过两端
 * 真实产物在 429 上的读数**。实测取证(vitest 探针，2026-10-09)：
 *   · 全仓与重试相关的判据(auto-retry-schedule / pool-retry-budget / concurrency-pool /
 *     retry-gate-server-text)喂进闸门的全是**自造串**，例如
 *     auto-retry-schedule.test.tsx:25 的「未配置访问凭据(not_configured)」；
 *   · retry-gate-server-text.test.ts:51 的状态码枚举写死 [400,401,402,403,404] —— 恰好跳过 429；
 *   · channel-error-text.test.ts:22 枚举了 429，但它 import 的是展示闸门 enforceChinese，
 *     整文件没有出现 isRetryableFailure。
 * ⇒ 把闸门的中文黑名单从「四[零一二三四五六七八九]」改成只认「四[零一二三]」(即放行 429)，
 *   两套套件照旧全绿，而钱袋子的口径已经悄悄翻面。本文件先钉住**现状读数**，再钉修复。
 *
 * ⚠ 构建期闸门(实测 tsc -b)：`import … from '../../../server/ai.mjs'` 在 `allowJs: false` 下报
 *   TS7016 —— 这条错误**不是我引入的形态**：HEAD 里的 retry-gate-server-text.test.ts:2 用同一句 import、
 *   同样红。⚠ 【缺陷 #149】ab787cf 提交信息里「剩下唯一一条构建期类型错误来自他人未提交文件」那句是错的，
 *   我上一轮照抄了它而没复跑：tsconfig 的 include 是整个 src(只 exclude helpers) ⇒ 用例也在编译范围内，
 *   实测移开他人那份文件后 tsc -b 仍红在这两条上，真实读数是 3 条且 2 条在本会话判据链上(#144 起)。
 *   这里不写 `@ts-expect-error` 把它压掉：那行注释本身就是变异体 —— 谁把 import 改成 any 桩或删掉，
 *   它会立刻红成「unused directive」，等于给跨端契约加了一道会咬人的写法钉子；真要收口应给 ai.mjs
 *   补 .d.ts 或开 allowJs，那是独立决定，不该由一份判据顺手替全站改编译口径。 */

const NO_CRED = '没有可用的通道凭据，请先在设置里配置';
/** 直接读产品源码的字节：闸门那行黑名单的字面量**本身就是判据要读的串**，
 *  用拼接文本去调函数永远读到「改之前」的行为(实测 M2 存活)，所以这条钉子必须碰源文件。 */
const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const directText = (s: number): string => '通道三千问：' + clientCF(s, '') + '，服务返回' + clientCn(s);
const serverText = (s: number): string => providerLabel('qwen') + '：' + srvCF(s, '') + '，服务返回' + srvCn(s);

describe('#148 重试闸门对两端真实产物的读数', () => {
  it('前提钉子：状态码枚举确实覆盖到 429，且两端产物在每一档上逐字相同', () => {
    /* 反向钉子：若哪天分类说法或中文数字写法分叉，这条先红，下面所有「两端同读数」的断言才不至于空转。 */
    for (const s of [400, 401, 402, 403, 404, 429, 500, 503]) {
      expect(serverText(s), `${s} 两端文本分叉 ⇒ 「同一句话」的前提塌了`).toBe(directText(s));
    }
    expect(clientCF(429, ''), '分类说法没提限流 ⇒ 下面的闸门读数测的不是限流这句话').toContain('限流');
    expect(clientCn(429)).toBe('四二九');
    /* 跨端契约：两端 classifyFailure 在 429 上必须给出同一句话，否则「同一句限流文本」在两端口径不同。 */
    expect(srvCF(429, '')).toBe(clientCF(429, ''));
    /* 反向钉子(实测教训)：本文件初稿在这里只调 directText(429)，而那句是**拼出来**的 ——
       把闸门的中文黑名单从「四[零一二三四五六七八九]」收窄成「四[零一二三]」时，四条断言照旧全绿。
       原因是 baziOrchestrator:102 那行：被改的字符序列本身就是判据要读的字节，注释与代码共用它，
       所以拿拼接串去调闸门，永远读到「改之前」的行为。这里直接钉那一行的字面量。 */
    const src = srcOf('../data/baziOrchestrator.ts');
    expect(src).toContain('if (/HTTP 40[0-9]|服务返回四[零一二三四五六七八九]/.test(error)) return false;');
  });

  it('429 限流判为不可重试 —— 有意的口径，冷却重发归并发池管', () => {
    /* 并发池 fixedMapLimit(baziOrchestrator:137，冷却重发条件 :194)已经用 isRateLimited 在冷却
       COOLDOWN_MS(:124)后就地重发过一次；这一条不再进 step 的即时重试(:543)与补跑名单(:640)，
       否则同一条限流任务最多花四口(首发+即时+退队+补跑) —— #108/#117/#121 那批实测换来的封顶口径就是这么定的。
       代价如实登记在下面第三条：整轮被限流时详情页 PersonDetail.tsx:557 的排期闸门读同一个字符串、判假，
       整轮级别的自动重试不排期。改任何一侧都必须同时复核另一侧。 */
    expect(isRetryableFailure(directText(429)), '直连这句被放行了 ⇒ 与池子的冷却重发叠成四口封顶').toBe(false);
    expect(isRetryableFailure(serverText(429))).toBe(false);
    /* 对照：五〇三不在黑名单里，仍须放行，否则闸门就成了「见报错就停」。 */
    expect(isRetryableFailure(directText(503)), '服务端故障被判死 ⇒ 该重发的也不发了').toBe(true);
    expect(isRetryableFailure(serverText(503))).toBe(true);
  });

  it('【修复】兜底句「没有可用的通道凭据」不再被判成值得重试', async () => {
    /* 实测缺陷 #148：这句只在 errors 为空时顶上来，而 errors 为空恰恰意味着「一条都没发出去」——
       两条真实出口都能走到(status 却是 failed，绕过了 not_configured 分诊)：
       ① opts.secret 传空串：browserDirect:308 的 anyCredential 只比 undefined !==，空串算「已配置」，
          循环里 :315 的 if (!secret) 对每个通道 continue 掉 ⇒ :351 兜底；
       ② chatDirect(:471) 根本没有凭据预检，一个都没填即整圈 continue ⇒ :502 兜底。
       旧读数 true ⇒ 界面上写着「去设置里配密钥」，后台却对着一个根本没密钥的通道连排两轮自动重试，
       正是 :80 注释承诺的「密钥类不盲试」被自己的兜底文案打穿。
       ⚠ 这里钉的是**闸门读数**，不是 status 本身：status 仍是 failed，所以详情页 :756 的分诊展示不变。 */
    expect(NO_CRED).toContain('没有可用的通道凭据');
    expect(isRetryableFailure(NO_CRED), '这句仍会被排进下一次自动重试 ⇒ 白烧钱').toBe(false);
    /* 反向钉子：闸门不得变成「见『凭据』二字就拦」—— 超时/服务端故障这两类仍要放行，
       它们同样不含上述字样，若有人按关键词扩黑名单会先把这条打成红。 */
    expect(isRetryableFailure('通道三千问：网络超时或不可达')).toBe(true);
    expect(isRetryableFailure(directText(500))).toBe(true);
  });

  it('【机制判据】恒限流的整盘读数：本命一条只发一口、aiError 落在这句上、排期闸门判假', async () => {
    /* 三条读数一起钉，是因为单独钉闸门挡不住「有人改池子不改闸门」那一类分叉：
       这里驱动真编排器(不发请求，桩注入)，取的都是产品自己算出来的值。
       实测(jsdom 2026-10-09)：task-01 调用数 = 1、record.aiStatus = failed、
       record.aiError = 那句限流原文、isRetryableFailure(aiError) = false。
       对照形态「本命限流 + 其余五〇三」同样只发一口 —— 首发的额度被自己的扣账花光(:540)，
       所以「429 判假」并没有让本命多挨一次，它决定的是**补跑名单(:640)不收这条**与详情页排期(PersonDetail.tsx:557)早退。 */
    const rec = {
      id: 'p148', name: '甲', gender: 'male', birthYear: 1984, birthMonth: 6,
      createdAt: '2026-01-01T00:00:00.000Z', aiStatus: 'pending',
      yearPillar: '甲子', monthPillar: '庚午', dayPillar: '壬寅', hourPillar: '庚子',
    } as never;
    const t429 = directText(429);
    /* 闸门读数与编排器行为当场各取一份：这句必须**确实**被判假，否则下面那条
       isRetryableFailure(aiError)=false 只是恒真(我把期望写成了产品恰好给的东西)。 */
    expect(isRetryableFailure(t429), '夹具本身没被判假 ⇒ 整条机制判据在测另一件事').toBe(false);
    const calls: Record<string, number> = {};
    const result = await orchestrateBaziAnalysis(rec, async (task) => {
      calls[task.taskId] = (calls[task.taskId] ?? 0) + 1;
      return { task, status: 'failed', error: t429 };
    }, undefined, { retries: 1 });
    expect(calls['task-01'], '恒限流下本命被发了不止一口 ⇒ 池子退队与 step 即时重试叠账(#121)').toBe(1);
    expect(result.aiStatus).toBe('failed');
    expect(result.aiError, 'aiError 不是限流那句 ⇒ 排期闸门读的对象变了').toBe(t429);
    expect(isRetryableFailure(result.aiError), '详情页会为整轮限流排第二次自动重试 ⇒ 与池内冷却重发叠加').toBe(false);
  });
});
