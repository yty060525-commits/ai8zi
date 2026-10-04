import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 这一层此前完全没有判据：设置页拿 getServiceStatus() 回的四格状态渲染「使用中 / 已配置」，
   而 aiSettings 的浏览器分支被 isProdBrowser() 挡在 MODE==='test' 之外 —— 测试里它永远走 invoke，
   于是「localStorage 里的键名/值 ↔ 界面显示的状态」这条映射从没被执行过一次。
   真实用户会撞上的形态有两个：
     - 键名漂移：credKey 前缀或 provider id 改了，保存的密钥读不回来 ⇒ 界面说「未配置」，
       但本机实际存着一份密钥(白占存储，且用户以为没配)。
     - 空串当已配置：clearAiCredential 只删自己的键；若某处留下 ''，truthiness 判断会把它
       报成「未配置」(正确)，而写成 `!== undefined` 就报成「已配置」(错)——实测后者能过全部用例。
   这里用 vite 的 env 接缝(import.meta.env.MODE 是可写属性)把浏览器分支打开，
   测的是产品真正的读写，而不是注释里的承诺。 */

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 把模块求值时的 MODE 换成 production：isProdBrowser() 即为真，走 localStorage 那几条路。 */
async function loadAsProdBrowser(): Promise<typeof import('../data/aiSettings')> {
  vi.stubEnv('MODE', 'production');
  vi.resetModules();
  return import('../data/aiSettings');
}

const CRED_PREFIX = 'mingli.cred.';
const PROVIDER_KEY = 'mingli.provider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe('浏览器版凭据与通道状态(aiSettings 的 localStorage 支路)', () => {
  it('前提自证：浏览器分支真的可达，且不碰 Tauri invoke', async () => {
    const invoke = vi.fn(async () => { throw new Error('不该走桌面路'); });
    // 桌面标记必须是「不存在」而不是值为 undefined：inTauri() 用 `in window` 判断，
    // 显式赋 undefined 时键仍在，会把模块骗到桌面路上(实测害我第一次红在这里)。
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const m = await loadAsProdBrowser();
    expect(m.getBrowserCredential('qwen')).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    // 反向钉子：不设任何键时 getAiProviderStatus 也必须能在浏览器路走通(靠默认值，不抛错)
    expect(await m.getAiProviderStatus()).toEqual({ selectedProvider: 'qwen', deepseek: 'not_configured', kimi: 'not_configured', qwen: 'not_configured' });
    expect(invoke).not.toHaveBeenCalled();
  });

  /* 键名是写入方与读取方之间的隐式契约：saveServiceCredential('serviceTwo') 存的键，
     必须正好是 getBrowserCredential('kimi') 读的那一个。改名不会有任何报错，只会让
     「已配置」变「未配置」而密钥仍躺在存储里。 */
  it('三条服务各自的凭据落在正确的键上，读回来自同一个键', async () => {
    const m = await loadAsProdBrowser();
    await m.saveServiceCredential('serviceOne', 'sk-one');
    await m.saveServiceCredential('serviceTwo', 'sk-two');
    await m.saveServiceCredential('serviceThree', 'sk-three');
    expect(localStorage.getItem(CRED_PREFIX + 'deepseek')).toBe('sk-one');
    expect(localStorage.getItem(CRED_PREFIX + 'kimi')).toBe('sk-two');
    expect(localStorage.getItem(CRED_PREFIX + 'qwen')).toBe('sk-three');
    expect(m.getBrowserCredential('deepseek')).toBe('sk-one');
    expect(m.getBrowserCredential('kimi')).toBe('sk-two');
    expect(m.getBrowserCredential('qwen')).toBe('sk-three');
    // 清空一条只影响那一条
    await m.clearServiceCredential('serviceTwo');
    expect(localStorage.getItem(CRED_PREFIX + 'kimi')).toBeNull();
    expect(m.getBrowserCredential('qwen')).toBe('sk-three');
  });

  /* 空值在两端都被拒(Rust save_ai_credential 见空直接 Err「密钥不能为空」，服务器 saveProviderKey
     要求 key.trim())；网页版这条支路此前没有任何校验 —— 实测粘贴时多带一个空格就存成
     「已配置」，而那份串发给上游必失败。这里钉的是三端同一口径。 */
  it('空白凭据不算已配置：保存与读取两侧都拒绝', async () => {
    const m = await loadAsProdBrowser();
    expect(await m.saveServiceCredential('serviceOne', '   '), '纯空白必须报未配置(桌面端此时报错)').toBe('not_configured');
    expect(localStorage.getItem(CRED_PREFIX + 'deepseek'), '空白不该落进存储').toBeNull();
    // 读取侧兜住历史脏值(改动前存下的 '')：truthiness 已经把它判成未配置
    localStorage.setItem(CRED_PREFIX + 'deepseek', '');
    expect((await m.getServiceStatus()).serviceOne).toBe('not_configured');
    localStorage.setItem(CRED_PREFIX + 'deepseek', '   ');
    expect((await m.getServiceStatus()).serviceOne, '纯空白也不算已配置(发给上游必失败，却提示用户已就绪)').toBe('not_configured');
    localStorage.setItem(CRED_PREFIX + 'deepseek', 'sk-real');
    expect((await m.getServiceStatus()).serviceOne).toBe('configured');
    /* 读取侧必须与写入侧同一条规则，否则「显示」和「真正发请求用的串」会分叉：
       deepseekAdapter / chatEngine 拿的是 getBrowserCredential() 的返回值，设置页亮灯依据的是
       它的 truthiness。存量脏值(带首尾空白)若原样读出，界面报「已配置」而那份串发出去必失败。 */
    localStorage.setItem(CRED_PREFIX + 'kimi', '  sk-dirty-pasted\n');
    expect(m.getBrowserCredential('kimi'), '读取侧要 trim 掉首尾空白(发给上游的那份必须是干净串)').toBe('sk-dirty-pasted');
    expect((await m.getServiceStatus()).serviceTwo, 'trim 后非空仍算已配置').toBe('configured');
    // 反向钉子：真密钥绝不能被 trim 逻辑吃掉(判据不能是「一律返回 undefined」)
    localStorage.setItem(CRED_PREFIX + 'qwen', 'sk-keep-me');
    expect(m.getBrowserCredential('qwen')).toBe('sk-keep-me');
  });

  /* getServiceStatus 是设置页四格灯的唯一数据来源：三格的键各自独立，别串。 */
  it('getServiceStatus 如实报出三条服务各自的配置状态', async () => {
    const m = await loadAsProdBrowser();
    await m.saveServiceCredential('serviceThree', 'sk-three');
    expect(await m.getServiceStatus()).toEqual({ selectedService: 'serviceThree', serviceOne: 'not_configured', serviceTwo: 'not_configured', serviceThree: 'configured' });
    await m.saveServiceCredential('serviceOne', 'sk-one');
    expect(await m.getServiceStatus()).toEqual({ selectedService: 'serviceThree', serviceOne: 'configured', serviceTwo: 'not_configured', serviceThree: 'configured' });
  });

  it('保存时去掉首尾空白再落库(粘贴常带空格/换行)', async () => {
    const m = await loadAsProdBrowser();
    await m.saveAiCredential('kimi', '  sk-pasted\n');
    expect(localStorage.getItem(CRED_PREFIX + 'kimi')).toBe('sk-pasted');
    expect(m.getBrowserCredential('kimi')).toBe('sk-pasted');
    expect((await m.getServiceStatus()).serviceTwo).toBe('configured');
  });

  /* 选定通道同时决定两件事：设置页显示哪条「使用中」，以及批断/聊天优先走哪条。
     写入方(setSelectedService→setAiProvider)与读取方(serverClient/chatEngine/deepseekAdapter)
     不在同一文件，键名对不上就是「显示千问、跑的是深思」——见 provider-follow-contract。 */
  it('切换服务会把选中项写进三个读侧共用的那一键', async () => {
    const m = await loadAsProdBrowser();
    expect(await m.setSelectedService('serviceTwo')).toBe('serviceTwo');
    expect(localStorage.getItem(PROVIDER_KEY)).toBe('kimi');
    expect((await m.getServiceStatus()).selectedService).toBe('serviceTwo');
    expect(await m.setSelectedService('serviceOne')).toBe('serviceOne');
    expect(localStorage.getItem(PROVIDER_KEY)).toBe('deepseek');
    expect((await m.getServiceStatus()).selectedService).toBe('serviceOne');
  });

  it('没设过选择时默认是通道三千问(项目定过的口径)，认不出的存量值原样透出由读侧兜底', async () => {
    const m = await loadAsProdBrowser();
    expect((await m.getServiceStatus()).selectedService).toBe('serviceThree');
    // 反钉：清掉之后回到默认，而不是停在上一条
    await m.setSelectedService('serviceOne');
    localStorage.removeItem(PROVIDER_KEY);
    expect((await m.getServiceStatus()).selectedService).toBe('serviceThree');
  });

  /* 桌面/网页两条路的通道中文名必须是同一份口径(记忆里记着「三端同步」)。
     这里是源码层比对：Rust 那份 label() 与 TS 那份 PROVIDER_LABEL 一旦分叉，
     同一条通道在两端界面上会显示成两个名字。 */
  it('中文通道名与桌面端 lib.rs 的 label() 逐条一致', () => {
    const ts = src('../data/aiSettings.ts');
    const rust = src('../../src-tauri/src/lib.rs');
    const at = rust.indexOf('fn label(&self)');
    if (at < 0) throw new Error('lib.rs 里找不到 label() —— 桌面端通道名换了地方');
    const body = rust.slice(at, at + 400);
    for (const zh of ['通道一深思', '通道二克米', '通道三千问']) {
      expect([zh, ts.includes("'" + zh + "'")]).toEqual([zh, true]);
      expect([zh, body.includes('"' + zh + '"')]).toEqual([zh, true]);
    }
    // 协议层英文名不许混进面向用户的映射表(那是「只能中文」闸门的已知泄漏源)
    expect(ts).toMatch(/PROVIDER_LABEL: Record<AiProvider, string> = \{[^}]*\}/);
    const table = /PROVIDER_LABEL: Record<AiProvider, string> = \{([^}]*)\}/.exec(ts)?.[1] ?? '';
    expect(table).not.toMatch(/DeepSeek|Kimi\(Moonshot\)|Qwen3/);
  });

  /* 这条测的是**产品代码之间**的接线，不是两份测试各写各的字面量：
     channel-routing / chat-engine 那些用例是手工 localStorage.setItem('mingli.cred.qwen', …)，
     键名换掉它们照样全绿；真正会被撞坏的是 deepseekAdapter 与设置页共用的 getBrowserCredential。
     所以这里用产品自己的写入方 saveServiceCredential 存，再用发送方的读取方取，
     并断言发出去的那份 Authorization 就是它 —— 两头必须落在同一个键上。 */
  it('设置页存的密钥就是直连请求实际使用的那一份(两端共用 getBrowserCredential)', async () => {
    vi.resetModules();
    const m = await loadAsProdBrowser();
    const { browserDirect } = await import('../data/deepseekAdapter');
    localStorage.setItem('mingli.provider', 'kimi');
    await m.saveServiceCredential('serviceTwo', 'sk-from-settings');
    // 前提自证：写入侧确实落到了读取侧要用的那个键上(否则下面的 fetch 断言会因为「没密钥」而空转)
    expect(m.getBrowserCredential('kimi')).toBe('sk-from-settings');
    let sent = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ pattern: '正印格', strength: '身强', explanation: '【健康】1. 好。' }) } }] }) } as never;
    }));
    await browserDirect(recordForWiring(), { secret: undefined } as never);
    expect(sent, '请求头里的密钥必须来自设置页存的那个键').toBe('Bearer sk-from-settings');
    // 反向钉子：清掉这条通道的凭据后，同一套读写必须一起变成「没有密钥」
    await m.clearServiceCredential('serviceTwo');
    expect(m.getBrowserCredential('kimi')).toBeUndefined();
  });
});

/** 只给到 browserDirect 会用到的字段；此处关心的是密钥接线，不是命局内容。 */
function recordForWiring(): never {
  return {
    id: 'wire-1', name: '接线', gender: 'male', birthYear: 1990, birthMonth: 6,
    yearPillar: '庚午', monthPillar: '壬午', dayPillar: '甲子', hourPillar: '甲子',
    createdAt: '2026-01-01T00:00:00.000Z', aiStatus: 'not_started',
    nonAiResult: { dayMaster: '甲', zodiac: '马', solarDate: '1990-06-15', elements: {}, tenGods: [], hiddenStems: [], relationships: {} },
  } as never;
}
