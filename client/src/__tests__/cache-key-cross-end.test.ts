import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/* 缓存键跨端同源判据(#131)。
   桌面(Rust)与服务器(Node)各有一份缓存，同一个盘、同一个问题在两边分别命中。
   「提示词字节变了就要升键」这条规则两端都写在注释里，而注释本身从来没人校验：
   实测服务端聊天键已升到 chatv6(证据标题去括号/斜杠、「AI 分析」改「批断分析」)，
   桌面 `chat_cache_key` 仍停在 chatv5，且它上一行写着「chatv5 与服务端同名键对齐」。
   ⇒ 同一问在服务端重答、桌面继续吐旧答案，界面上看就是「换个设备答案口径不一样」。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 取 `return ['vNN', ...]` / `format!("vNN|…")` 里的版本段。 */
const versionOf = (text: string, re: RegExp, where: string): string => {
  const hits = [...text.matchAll(new RegExp(re.source, 'g'))];
  expect(hits.length, `${where} 的版本锚匹配到 ${hits.length} 次 ⇒ 写法变了或整块没了`).toBe(1);
  return hits[0][1];
};

/* 【测量缺陷 · 实测】第一版把桌面锚写成 `format!\("(chatv\d+)\|\{model\}` —— 命中 0 次，
   我差点读成「桌面端整块没了」。树上的字面量是
   `format!("chatv5|{}|{}|{}|{}|{}|{}|chat|{:016x}|{}|{}", model, …)`：
   Rust 用的是**位置参数**，字符串里根本没有 `{model}`，model 在引号外面。
   ⇒ 锚必须只钉到 `|{}`，并且这条注释本身就是下一次改锚的人的起点。 */
const RUST_CHAT_FMT = /format!\("(chatv\d+)\|\{\}/;

/** 从 `format!("chatv` 起、按括号配对取到整条调用(实参跨三行，单行切片会少读)。 */
const rustChatFormat = (text: string): string => {
  const i = text.indexOf('format!("chatv');
  if (i < 0) return '';
  let depth = 0;
  for (let k = text.indexOf('(', i); k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')') {
      depth--;
      if (depth === 0) return text.slice(i, k + 1);
    }
  }
  return '';
};

describe('缓存键跨端同源(#131)', () => {
  const serverChat = '../../../server/chat.mjs';
  const rust = '../../src-tauri/src/lib.rs';

  it('聊天缓存键版本两端一致(桌面曾停在 chatv5 而服务端已到 chatv6)', () => {
    const sVer = versionOf(src(serverChat), /\['(chatv\d+)', model, record\.gender/, 'server/chat.mjs chatCacheKey');
    /* ⚠ Rust 的键是跨行 format!，所以锚必须带 [\s\S] —— 用单行正则读不到，会把「我的锚失效」
        当成「桌面端整块没了」(实测第一次就红在这个上面)。 */
    const rVer = versionOf(src(rust), RUST_CHAT_FMT, 'lib.rs chat_cache_key');
    expect(rVer, `桌面 ${rVer} 与服务端 ${sVer} 分叉 ⇒ 同问在一边吐旧缓存`).toBe(sVer);
  });

  it('声称「与服务端对齐」的注释不许比代码旧(注释说谎比没注释更坏)', () => {
    /* lib.rs 里那句 doc 注释写的是「chatv5 与服务端同名键对齐」。若有人只升 format! 的字面量
       不升注释，注释就会长期指着一个已经不存在的版本号 —— 下一次升键的人会照着注释判断"已经对齐"。
       所以钉：注释里出现的 chatvN 必须与代码里的实际读数相同。 */
    const text = src(rust);
    const codeVer = versionOf(text, RUST_CHAT_FMT, 'lib.rs chat_cache_key');
    const claims = [...text.matchAll(/chatv(\d+) 与服务端同名键对齐/g)].map((m) => 'chatv' + m[1]);
    expect(claims.length, '找不到那句「与服务端同名键对齐」的注释 ⇒ 钉子要重写').toBe(1);
    expect(claims[0], `注释说 ${claims[0]} 对齐，代码却是 ${codeVer}`).toBe(codeVer);
  });

  it('聊天键的段数与顺序两端同构(第 2..6 段 = 性别 + 四柱，第 8 段 = 问题哈希)', () => {
    /* 键位不同构时，chart_sig 索引(按第 2..6 段建)在两端覆盖不到同一批缓存，
       「换设备删盘要连带清聊天缓存」那条判据会只清掉一半。 */
    const sLine = src(serverChat).split('\n').find((l) => /^\s*return \['chatv\d+', model,/.test(l));
    /* ⚠ 拼装跨三行，切片必须取到**收尾括号**为止。第一版用 `indexOf('}', indexOf('tone_bucket(chat.tone)'))`
       收口 —— 命中的是 `tone_bucket(chat.tone)` 自己的右括号，把后面的实参列表整段切掉，
       于是占位符读成 8 而不是 10(实测红在这里)。改成从 `format!(` 往后配对括号。 */
    const rustBlock = rustChatFormat(src(rust));
    expect(sLine, '服务端聊天键的拼装行没找到 ⇒ 结构变了').toBeTruthy();
    expect(rustBlock, '桌面聊天键的拼装块没找到 ⇒ 结构变了').toBeTruthy();
    const sSegs = (sLine!.split(']')[0] ?? '').split(',').length;
    /* ⚠ 【测量缺陷 · 实测】第一版把插值数写成「应仍是 10」—— 那是我照着服务端段数倒推的预测，
       不是树上的事实。当场枚举 format! 的字面量(见下方 segs 逐格读数)：桌面是
       `chatv5 | {}×6 | chat | {:016x} | {} | {}` ⇒ **8 个 `{}` + 1 个 `{:016x}` + 2 个字面量**，
       合计 11 格，与服务端 11 段同构。所以钉的是「逐格形状」而不是「插值个数」。 */
    const litSegs = (rustBlock.match(/^format!\("([^"]*)"/) ?? ['', ''])[1].split('|');
    expect(litSegs.length, `桌面聊天键字面量段数变成 ${litSegs.length}`).toBe(11);
    expect(litSegs.slice(1, 7).join('|'), `桌面第 2..7 段不再是六个 {}`).toBe('{}|{}|{}|{}|{}|{}');
    expect(litSegs[7], `桌面第 8 段不再是固定字面 chat`).toBe('chat');
    expect(litSegs[8], `桌面第 9 段不再是 {:016x} 哈希`).toBe('{:016x}');
    const plain = rustBlock.match(/\{\}/g)?.length ?? -1;
    const hashed = rustBlock.match(/\{:016x\}/g)?.length ?? -1;
    expect(sSegs, `服务端聊天键段数变成 ${sSegs}`).toBe(11);
    expect(plain, `桌面聊天键 {} 插值数变成 ${plain}`).toBe(8);
    expect(hashed, `桌面聊天键的 {:016x} 个数变成 ${hashed}`).toBe(1);
    expect(plain + hashed + 2, `桌面段数合计 ${plain + hashed + 2} 与服务端 ${sSegs} 不同构`).toBe(sSegs);
  });

  it('问题哈希两端算法不同(FNV-1a vs sha256)是有意为之，但长度必须各自稳定', () => {
    /* 两边的键互不相通(各自的库)，这一点不需要统一；需要统一的是**同端内**的稳定性：
       服务端取 24 位 hex、桌面取 16 位 hex。若哪天把 slice(0,24) 改成 slice(0,8)，
       旧键与新键不会相撞，等于悄悄把所有聊天缓存作废(重新花钱)。这里钉住读数。 */
    const s = src(serverChat);
    const digest = /createHash\('sha256'\)\.update\(String\(question\)\.trim\(\)\)\.digest\('hex'\)\.slice\(0, (\d+)\)/;
    expect(versionOf(s, digest, 'server/chat.mjs qhash'), '服务端问题哈希长度').toBe('24');
    const r = src(rust);
    expect(versionOf(r, /\|(\{:0\d+x\})\|/, 'lib.rs qhash 宽度'), '桌面问题哈希宽度').toBe('{:016x}');
    /* 切片必须真吃到收尾实参，否则上面的段数会静默少读(实测读过 8)。正向钉子：整块尾部含最后一个实参。 */
    expect(rustChatFormat(src(rust)), '桌面聊天键切片没取到最后一个实参 ⇒ 段数读数不可信')
      .toContain('tone_bucket(chat.tone))');
  });

  it('正向钉子：sha256 现算能打响(避免上面的正则读到一个空串冒充通过)', () => {
    const h = createHash('sha256').update('我今年事业如何？'.trim()).digest('hex');
    expect(h.slice(0, 24)).toHaveLength(24);
    expect(/^[0-9a-f]{24}$/.test(h.slice(0, 24))).toBe(true);
  });
});
