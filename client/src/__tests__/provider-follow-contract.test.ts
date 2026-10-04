import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 「当前使用通道」要真的跟随设置，靠的是一条编译器完全看不见的链：
     浏览器写 localStorage['mingli.provider'] → runTaskOnServer / chat 把它读出来塞进请求体
     → 服务器 providerOrder(db, preferred) 拿它当首选。
   键名、载荷字段名、服务端校验名单分别住在四个文件里，任何一环改名都不会报错 ——
   表现是「界面显示在用通道三千问，实际跑的还是默认那条」(实测这条链此前无任何判据)。
   storage-key-contract 只钉了三个客户端读侧(adapter/serverClient/chatEngine)各读一次这一键，
   没钉「读出来之后有没有放进发给服务器的请求」，也没钉服务器认不认这个名字。这里补齐。 */

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const SERVER_CLIENT = '../data/serverClient.ts';
const CHAT_ENGINE = '../data/chatEngine.ts';
const AI_MJS = '../../../server/ai.mjs';
const PROVIDER_KEY = "'mingli.provider'";

/** 取产品真正发给服务器那一次的请求体行。
 *  serverClient 里有五条带 body 的 POST(注册/登录/改密/清缓存/批断)，聊天侧只有一条，
 *  所以用「路径 + body」定位而不是第一条命中 —— 定位不到就当链断了，判据必须读的是
 *  发出去的那一行，不是注释里的描述。
 *  批断那一行的 URL 是拼出来的('/records/' + id + '/ai/task' 在上一行，body 单独占一行)，
 *  所以允许从锚点行向后看两行找 body。 */
const requestBodyLine = (rel: string, pathPattern: RegExp): string => {
  const lines = src(rel).split('\n');
  const at = lines.findIndex((l) => pathPattern.test(l));
  if (at < 0) throw new Error(`${rel} 里找不到 ${pathPattern.source} 那条请求 —— 写法被改走了`);
  const line = lines.slice(at, at + 3).find((l) => /body: \{/.test(l));
  if (!line) throw new Error(`${rel} 的 ${pathPattern.source} 请求附近找不到请求体`);
  return line;
};

describe('当前使用通道跟随设置的完整链', () => {
  /* 判据取自产品真正发出的那两行，而不是另抄一份形状：把 `provider` 从 body 里删掉，本条必须红。
     实测两轮变异教来的一条教训：只写「body 里有 provider 这个词」( /\bprovider\b/ )时，
     把字段改成 `preferred: provider` 的变异**存活**了 —— 词还在，但发出去的键名服务器不认，
     等于每条批断都退回服务器自己的顺序。所以这里钉的是速记属性写法本身(`provider,`)。 */
  it('批断与聊天都把本机选中的通道以 provider 这个键发出去', () => {
    for (const [rel, pathPattern] of [[SERVER_CLIENT, /\/ai\/task/], [CHAT_ENGINE, /'\/chat'/]] as Array<[string, RegExp]>) {
      const body = requestBodyLine(rel, pathPattern).match(/body: \{([^}]*)\}/);
      if (!body) throw new Error(`${rel} 的请求体不是可读的对象字面量`);
      expect([rel, body[1]]).toEqual([rel, expect.stringMatching(/(?:^|,\s*)provider\s*(?:,|$)/)]);
    }
    // 读侧各读且只读这一处(storage-key-contract 也数过一遍；重复计数是为防有人只留注释里的引用)
    expect(count(src(SERVER_CLIENT), PROVIDER_KEY)).toBe(1);
    expect(count(src(CHAT_ENGINE), PROVIDER_KEY)).toBe(1);
  });

  /* 服务器收到 preferred 后先按 PROVIDERS 名单校验，不在名单上的值会被静默丢掉、
     退回服务器自己的 ai.provider —— 用户这边选了个服务器没有的通道时不会有任何提示。
     所以「名单」是三端一致性的落点：客户端能写的值必须是它的子集。 */
  it('服务器按 id 白名单校验 preferred，且三条通道的 id 与客户端枚举逐字节相同', () => {
    const ai = src(AI_MJS);
    expect(ai).toContain('preferred && PROVIDERS.some((p) => p.id === preferred)');
    const ids = [...ai.matchAll(/^  \{ id: '(deepseek|kimi|qwen)',/gm)].map((m) => m[1]);
    expect(ids).toEqual(['deepseek', 'kimi', 'qwen']);
  });

  /* 桌面端把同一个选择存在 keyring，读回来时要能认出这三个 id；
     漏一条就等于桌面版选了那条通道却永远回落到默认值(而且 unwrap_or 会静默兜住，不报错)。 */
  it('桌面端 selected_provider 能解析全部三个通道 id，缺省同样是 qwen', () => {
    const rust = src('../../src-tauri/src/lib.rs');
    const at = rust.indexOf('fn selected_provider()');
    if (at < 0) throw new Error('lib.rs 里找不到 selected_provider() —— 桌面端读取方式被挪走了');
    const body = rust.slice(at, at + 900);
    for (const id of ['deepseek', 'kimi', 'qwen']) {
      expect([id, count(body, '"' + id + '"')]).toEqual([id, 1]);
    }
    expect(body).toContain('unwrap_or(AiProvider::Qwen)');
  });

  /* 缺省回退值散在五处(server/ai.mjs、aiSettings、deepseekAdapter、serverClient 不含缺省、lib.rs)。
     项目记忆里定过「以后默认 qwen」，这里把三端缺省一次性钉成同一个值：
     任何一处单独改成别的通道，就会出现「设置页显示千问、直连跑深思、服务器另有偏好」。 */
  it('三端的缺省通道都是同一条(qwen)', () => {
    const settings = src('../data/aiSettings.ts');
    expect(settings).toContain("as AiProvider) ?? 'qwen'");
    expect(src('../data/deepseekAdapter.ts')).toContain("localStorage.getItem('mingli.provider') ?? 'qwen'");
    expect(src(AI_MJS)).toContain("getSetting(db, 'ai.provider', 'qwen')");
    expect(src('../../src-tauri/src/lib.rs')).toContain('unwrap_or(AiProvider::Qwen)');
  });
});
