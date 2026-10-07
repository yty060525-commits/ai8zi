import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 通道参数跨端同源判据(#133)。
   deepseekAdapter.ts 第 141 行写着「通道定义：端点/模型/参数与服务器端、桌面端保持一致」，
   但这句话此前没有任何校验器 —— provider-follow-contract 钉的是「首选通道有没有跟着设置走」，
   prompt-parity 钉的是提示词文本，都没比过 endpoint/model/temperature。
   实测读数：Qwen 的 temperature 浏览器直连(CHANNELS)与服务端(ai.mjs 第 376 行 body.temperature = 0.3)
   都是 0.3(服务端注释还写明「已关闭思考的 Qwen 用低温度更稳定」)，桌面 provider_temperature 却是 Some(1)。
   同一命盘同一个问题在网页和桌面上得到不同温度的答案，而三端注释都声称一致。修复：桌面改 Option<f64>=Some(0.3)。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const adapter = src('../data/deepseekAdapter.ts');
const server = src('../../../server/ai.mjs');
const rust = src('../../src-tauri/src/lib.rs');

const IDS = ['deepseek', 'kimi', 'qwen'] as const;
/* Rust 枚举变体是首字母大写(Deepseek/Kimi/Qwen)，JS 侧 id 是小写。早先按小写拼正则命中 0 次，
   于是把「锚没打上」误报成「分支不存在」—— 这里统一做大小写映射。 */
const cap = (id: string): string => id[0].toUpperCase() + id.slice(1);

/** CHANNELS 里某通道的字段(单行对象字面量)。 */
const channelField = (id: string, field: string): string => {
  const line = adapter.split('\n').find((l) => new RegExp(`\\{ id: '${id}',`).test(l));
  expect(line, `CHANNELS 里没有 ${id} 这一行 ⇒ 结构变了`).toBeTruthy();
  const m = new RegExp(`${field}: ([^,}]+)`).exec(line ?? '');
  expect(m, `CHANNELS 的 ${id} 没有 ${field} 字段`).toBeTruthy();
  return (m?.[1] ?? '').trim().replace(/^'/g, '').replace(/'$/g, '');
};

/** PROVIDERS 行里的字段(endpoint/model 在同一行)。 */
const serverField = (id: string, field: string): string => {
  const line = server.split('\n').find((l) => new RegExp(`\\{ id: '${id}',`).test(l));
  expect(line, `PROVIDERS 里没有 ${id} 这一行 ⇒ 结构变了`).toBeTruthy();
  const m = new RegExp(`${field}: ([^,}]+)`).exec(line ?? '');
  expect(m, `PROVIDERS 的 ${id} 没有 ${field} 字段`).toBeTruthy();
  return (m?.[1] ?? '').trim().replace(/^'/g, '').replace(/'$/g, '');
};

/**
 * Rust `match provider { … }` 表里某个 provider 的取值。fnRe 命中的那一行可能只是函数签名，
 * 真正的 match 表在下一行(如 provider_model/provider_temperature)，所以从命中行往下扫，
 * 取第一条含 `AiProvider::` 的行作为表体。
 */
const rustArm = (fnRe: RegExp, id: string, where: string): string => {
  const lines = rust.split('\n');
  const start = lines.findIndex((l) => fnRe.test(l));
  expect(start, `${where} 的函数没找到 ⇒ 写法变了`).toBeGreaterThanOrEqual(0);
  // match provider 用 AiProvider::X，match self(label/key) 用 Self::X —— 两种前缀都接受。
  const tableLine = lines.slice(start, start + 6).find((l) => /(?:AiProvider|Self)::/.test(l));
  expect(tableLine, `${where} 附近没有 match 表`).toBeTruthy();
  const m = new RegExp(`(?:AiProvider|Self)::${cap(id)}\\s*=>\\s*([^,}]+)`).exec(tableLine ?? '');
  expect(m, `${where} 里没有 ${id} 分支`).toBeTruthy();
  return (m?.[1] ?? '').trim();
};

describe('通道参数跨端同源(#133)', () => {
  it('尺子能打响：三端各自读到三个通道的端点/模型，服务端与桌面读到温度', () => {
    for (const id of IDS) {
      expect(channelField(id, 'endpoint'), `${id} 端点读空`).toContain('https://');
      expect(serverField(id, 'endpoint'), `${id} 服务端端点读空`).toContain('https://');
      expect(rustArm(/let endpoint = match provider/, id, `lib.rs endpoint(${id})`)).toContain('"https://');
      expect(channelField(id, 'model'), `${id} 模型读空`).toContain('-');
      expect(serverField(id, 'model'), `${id} 服务端模型读空`).toContain('-');
      expect(rustArm(/pub\(crate\) fn provider_model/, id, `lib.rs provider_model(${id})`)).toContain('"');
      // 服务端/桌面的温度都能读到(整数或小数)；deepseek 例外见下方温度用例。
    }
  });

  it('端点三端逐字一致', () => {
    for (const id of IDS) {
      const a = channelField(id, 'endpoint');
      const s = serverField(id, 'endpoint');
      const r = rustArm(/let endpoint = match provider/, id, `lib.rs endpoint(${id})`).replace(/^"|"$/g, '');
      expect(s, `${id} 的服务端端点与浏览器直连不同`).toBe(a);
      expect(r, `${id} 的桌面端点与另两端不同`).toBe(a);
    }
  });

  it('模型名三端逐字一致', () => {
    for (const id of IDS) {
      const a = channelField(id, 'model');
      const s = serverField(id, 'model');
      const r = rustArm(/pub\(crate\) fn provider_model/, id, `lib.rs provider_model(${id})`).replace(/^"|"$/g, '');
      expect(s, `${id} 的服务端模型名与浏览器直连不同`).toBe(a);
      expect(r, `${id} 的桌面模型名与另两端不同`).toBe(a);
    }
  });

  it('温度三端同源(Qwen 曾停在桌面的 1，另两端是 0.3)', () => {
    /* 温度来源各不相同，必须各读各处再比：
       - 浏览器直连：CHANNELS 行内 temperature 字段(deepseek 无此字段 ⇒ 不发温度)。
       - 服务端：不在 PROVIDERS 行，而是 ai.mjs 里 `if (provider.id === '<id>') body.temperature = X;`。
       - 桌面：provider_temperature 的 match 表(Some(x)/None)。
       ⚠ Rust 原签名是 Option<i32> 写不出 0.3，本次改成 Option<f64>；若有人把它退回整数，
          本条会红在「桌面 1 vs 另两端 0.3」而不是静默通过。 */
    const serverTemp = (id: string): string | null => {
      const line = server.split('\n').find((l) => new RegExp(`provider\\.id === '${id}'`).test(l) && /body\.temperature\s*=/.test(l));
      if (!line) return null;
      return /body\.temperature\s*=\s*([0-9.]+)/.exec(line)?.[1] ?? null;
    };
    const channelTemp = (id: string): string | null => {
      const line = adapter.split('\n').find((l) => new RegExp(`\\{ id: '${id}',`).test(l)) ?? '';
      if (!/temperature:/.test(line)) return null;
      return /temperature:\s*([0-9.]+)/.exec(line)?.[1] ?? null;
    };
    const rustTemp = (id: string): string | null => {
      const raw = rustArm(/pub\(crate\) fn provider_temperature/, id, `lib.rs temperature(${id})`);
      if (raw === 'None') return null;
      const m = /^Some\(([0-9.]+)\)$/.exec(raw);
      expect(m, `桌面 ${id} 的温度不是 None/Some(数字)：${raw}`).toBeTruthy();
      // 归一化 "1"/"1.0" 为同一数值串，避免纯格式差异造成假分叉。
      const n = Number(m?.[1]);
      return Number.isNaN(n) ? null : String(n);
    };
    const norm = (v: string | null): string | null => (v === null ? null : String(Number(v)));

    for (const id of IDS) {
      const c = norm(channelTemp(id));
      const s = norm(serverTemp(id));
      const r = norm(rustTemp(id));
      // 三端要么都不发温度(null)，要么数值完全相等。
      expect(s, `${id} 服务端温度与浏览器直连分叉`).toBe(c);
      expect(r, `${id} 桌面温度与另两端分叉 ⇒ 同一问在桌面拿到另一种温度的答案`).toBe(c);
    }
    // 关键回归钉子：Qwen 必须是低温度 0.3，且三端同源(不是被 null==null 蒙过去)。
    expect(norm(channelTemp('qwen')), 'Qwen 浏览器直连温度不再是 0.3').toBe('0.3');
    expect(norm(serverTemp('qwen')), 'Qwen 服务端温度不再是 0.3').toBe('0.3');
    expect(norm(rustTemp('qwen')), 'Qwen 桌面温度不再是 0.3(#133 复发)').toBe('0.3');
  });

  it('对外中文通道名三端同一份口径(闸门白名单，名字里不许有中点)', () => {
    /* 进正文/报错的是「面向用户的中文通道名」，三端各有一份：
       - 服务端 PROVIDER_LABEL、客户端 aiSettings.PROVIDER_LABEL、桌面 AiProvider::label()。
       这三处必须逐字相同，否则用户看到的通道归属在三端间漂移；且不能带「·」(闸门会静默删字)。
       ⚠ CHANNELS/PROVIDERS 里的 label 字段是另一回事(展示名，允许各端不同)，不在本条比对范围。 */
    const zh = (text: string, re: RegExp, where: string): Record<string, string> => {
      const m = re.exec(text);
      expect(m, `${where} 的中文通道名表没找到`).toBeTruthy();
      return Object.fromEntries([...(m?.[1] ?? '').matchAll(/(\w+):\s*'([^']+)'/g)].map((x) => [x[1], x[2]]));
    };
    const s = zh(server, /export const PROVIDER_LABEL = \{([^}]*)\}/, 'server PROVIDER_LABEL');
    const settings = src('../data/aiSettings.ts');
    const c = zh(settings, /PROVIDER_LABEL[^{]*\{([^}]*)\}/, 'aiSettings PROVIDER_LABEL');
    const rustLabel = (id: string): string =>
      rustArm(/fn label\(&self\)/, id, 'lib.rs label').replace(/^"|"$/g, '');
    for (const id of IDS) {
      expect(c[id], `${id} 的中文名在 aiSettings 与服务端之间分叉`).toBe(s[id]);
      expect(rustLabel(cap(id)), `${id} 的中文名在桌面与服务端之间分叉`).toBe(s[id]);
    }
    for (const name of Object.values(s)) {
      expect(name, `通道名「${name}」带中点 ⇒ 会被中文闸门静默删字`).not.toContain('·');
    }
  });

  it('正向钉子：读的确实是那三份源码', () => {
    expect(adapter).toContain('const CHANNELS: ChannelSpec[]');
    expect(server).toContain('export const PROVIDERS = [');
    expect(rust).toContain('pub(crate) fn provider_temperature');
    expect(rust).toContain('Option<f64>'); // #133：温度类型已从 i32 改为 f64 才能表达 0.3
  });
});
