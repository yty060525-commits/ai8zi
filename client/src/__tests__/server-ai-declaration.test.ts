import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyFailure as srvCF, cnCode as srvCn, providerLabel, AI_SERVER_UNCONFIGURED } from '../../../server/ai.mjs';

/* 判据空白 #152：上面那份声明文件(client/src/types/server-ai.d.ts)是**为了让构建过**而写的，
 * 它本身从来没有判据 —— 实测两种「坏法」都不会红：
 *   D1 整份删掉 ⇒ 4 passed（tsc -b 会红两条 TS7016，但 vitest 不做类型检查，照跑）；
 *   D2 把里面 cnCode 的返回类型改成 number ⇒ 4 passed（运行时形状没变）。
 * 也就是说「声明与服务器真实导出是否同源」这件事完全没人钉：将来谁在 ai.mjs 里改了
 * classifyFailure 的签名或把 providerLabel 改名，这份 .d.ts 不会给出任何读数，
 * 而它一旦与实际字节分叉，跨端契约的两条判据(#144/#148)就生活在我自己编的形状里。
 * 这一条不试图校验类型(那要跑 tsc，成本另计)，只钉两件当场可读的事：
 *   ① 声明文件里出现的每个符号名，都必须在 server/ai.mjs 的真实导出里存在（防止声明幽灵符号）；
 *   ② 用例确实**调用**了服务器的函数并拿到中文回执（防止有人把它换成 any 桩后全绿）。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const DECLARATION = src('../types/server-ai.d.ts');
const SERVER = src('../../../server/ai.mjs');

/** 从声明文件里取出 `export function X` / `export const X` 的名字集合。
 *  ⚠ 必须容忍缩进：这些行在 declare module 块内，实际字节前面有两个空格 ——
 *  第一版按 `^export` 写，读数是空数组，于是「前提」那条红在自己的解析式上(不是产品问题)。 */
const declaredNames = (text: string): string[] =>
  [...text.matchAll(/^\s*export\s+(?:function|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);

describe('#152 服务器 mjs 声明文件与真实导出同源', () => {
  it('前提：声明文件确实用的是通配形，且列出了判据依赖的四个符号', () => {
    /* 反向钉子(实测 A/B)：只有 `declare module '*.mjs'` 这种通配形对 tsc 生效 ——
       兄弟位置的 ai.d.ts、以及按整条 specifier 写的 declare module 两种写法，
       实测 npx tsc -b 仍红在两条 TS7016 上。哪天有人把它「整理」成那两种之一，这条先红。 */
    expect(DECLARATION).toContain("declare module '*.mjs'");
    for (const name of ['classifyFailure', 'cnCode', 'providerLabel', 'AI_SERVER_UNCONFIGURED']) {
      expect(declaredNames(DECLARATION), `声明文件里没有 ${name}`).toContain(name);
    }
  });

  it('声明里的每个符号都真在 server/ai.mjs 的导出上（不许声明幽灵符号）', () => {
    const names = declaredNames(DECLARATION);
    expect(names.length, '声明文件被掏空 ⇒ 这条闸门会变成零条断言的空转').toBeGreaterThanOrEqual(4);
    for (const name of names) {
      const exported = new RegExp('^export\\s+(?:async\\s+)?(?:function|const)\\s+' + name + '\\b', 'm');
      expect(SERVER, `server/ai.mjs 并不导出 ${name} ⇒ 声明与实现已分叉`).toMatch(exported);
    }
  });

  it('跨端契约这一侧真的落在服务器函数上，不是本地重算的副本', () => {
    /* 这条专门对付「把 import 换成 any 桩」：桩能给任意答案，所以判据要钉住
       服务器实现独有的行为细节 —— 状态码在这里**绝不出现阿拉伯数字**（ai.mjs:326 注释写死了
       这个口径，因为展示层那道「只能中文」闸门会把带数字的整句判空）。 */
    expect(srvCF(429, ''), '限流回执变了形 ⇒ 下面那句无数字断言就没意义').toContain('限流');
    expect(srvCF(503, '')).toBe('服务端故障');
    expect(srvCF(503, '')).not.toMatch(/[0-9]/);
    expect(srvCn(429)).toBe('四二九');
    expect(providerLabel('qwen'), '通道名取自 PROVIDER_LABEL，改字要同时动三端').toBe('通道三千问');
    expect(AI_SERVER_UNCONFIGURED).toContain('未配置');
    /* 运行时的入参形状也要钉：声明文件写的是 classifyFailure(status: number, bodyText: string)。
       若哪天服务器把它改成单对象参数，仅靠上面这些返回值断言可能照旧全绿(它仍会走状态码分支)，
       而调用方按两参传就拿到 undefined。length/arity 是当场可读的字节级事实。 */
    expect(srvCF.length, '服务器 classifyFailure 的参数个数与声明不符').toBe(2);
    expect(typeof srvCn).toBe('function');
    expect(typeof providerLabel).toBe('function');
  });

  it('声明里的参数个数 = server/ai.mjs 真实形参表的个数（防止声明自己说谎）', () => {
    /* 这一条是本次实测换来的：类型面**没法**校验声明文件本身 ——
       把 cnCode 的返回类型从 string 改成 number，`npx tsc -p`(限定这 6 个文件的最小工程)
       读到 0 错误、vitest 也 3 passed，两个闸门都毫无读数，因为对 tsc 来说声明文件就是事实源。
       唯一能验的是「声明 vs 实现」的字节比对，所以这里比参数个数：
       将来谁把 classifyFailure(status, bodyText) 改成单对象入参，这条先红，
       而不是让 #144/#148 那两条跨端契约继续按两参调用、在运行时静默拿到 undefined。 */
    const declParams = (name: string): number => {
      const m = DECLARATION.match(new RegExp('^\\s*export function ' + name + '\\(([^)]*)\\)', 'm'));
      /* ⚠ expect(...).not.toBeNull() 不会收窄类型(tsc 实测 TS18047: 'm' is possibly 'null')，
         必须用显式守卫再 throw，否则下一行就是编译期错误。 */
      if (!m) return expect.fail(`声明文件里找不到 ${name} 的函数形状`);
      return m[1].split(',').map((p) => p.trim()).filter((p) => p !== '').length;
    };
    /* ⚠ ai.mjs 里三种导出形状混着用：classifyFailure/providerLabel 走 function，
       cnCode 走 `export const cnCode = (status) => …`(实测第一版只匹配 function，
       这条就红在「找不到形参表」上 —— 那是我的解析式漏形态，不是产品分叉)。
       所以下面把两种形状都认。 */
    const implParams = (name: string): number => {
      const patterns = [
        new RegExp('export function ' + name + '\\(([^)]*)\\)', 'm'),
        new RegExp('export const ' + name + '\\s*=\\s*\\(([^)]*)\\)\\s*=>', 'm'),
        new RegExp('export const ' + name + '\\s*=\\s*async\\s*\\(([^)]*)\\)', 'm'),
      ];
      for (const re of patterns) {
        const m = SERVER.match(re);
        if (m) return m[1].split(',').map((p) => p.trim()).filter((p) => p !== '').length;
      }
      expect.fail(`server/ai.mjs 里取不到 ${name} 的形参表(三种导出形状都没命中)`);
    };
    for (const name of ['classifyFailure', 'cnCode', 'providerLabel']) {
      expect(declParams(name), `${name} 的声明参数数与 ai.mjs 真实形参数分叉`).toBe(implParams(name));
    }
    expect(implParams('classifyFailure'), '形参表解析式自己失效 ⇒ 上面三条比的是空对空').toBe(2);
  });
});
