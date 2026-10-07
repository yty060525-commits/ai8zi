import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 凭据空白口径三端同源判据(#134)。
   aiSettings.ts:29 注释写着「与另两端同口径：桌面端 save_ai_credential 见空密钥直接报『密钥不能为空』，
   服务器 saveProviderKey 要求 key.trim()」；ai-settings-browser-creds.test.ts 第 69–70 行更把这句话抄进用例注释。
   但两处都只测了浏览器支路 —— Rust 那条从未被任何校验器读过。实测缺陷：Rust 原写 `if secret.is_empty()`，
   纯空白("   ")在 .is_empty() 下为 false ⇒ 桌面把空白串当有效密钥落进 keyring、界面报「已配置」，
   而这份串发给上游必失败(正是那句注释承诺要防的事)。修复：Rust 改先 trim 再判空、存 trimmed。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const rust = src('../../src-tauri/src/lib.rs');
const server = src('../../../server/ai.mjs');
const settings = src('../data/aiSettings.ts');

describe('凭据空白口径三端同源(#134)', () => {
  it('尺子能打响：三端各自读到保存凭据那一行的空白处理', () => {
    // 浏览器：saveAiCredential 里对入参做 trim。
    const browserFn = /export async function saveAiCredential[\s\S]*?\n}/.exec(settings);
    expect(browserFn, 'saveAiCredential 函数体没找到 ⇒ 写法变了').toBeTruthy();
    expect(browserFn?.[0], '浏览器侧不再对 secret 做 trim').toMatch(/secret[^;\n]*\.trim\(\)/);
    // 服务端：saveProviderKey 用 key.trim() 作真值判据。
    const serverLine = server.split('\n').find((l) => /saveProviderKey\s*=/.test(l)) ?? '';
    expect(serverLine, 'saveProviderKey 定义行没找到').toContain('key.trim()');
    // 桌面：save_ai_credential 里对 secret 做 trim。
    const rustFn = /pub fn save_ai_credential[\s\S]*?\n}/.exec(rust);
    expect(rustFn, 'save_ai_credential 函数体没找到').toBeTruthy();
    expect(rustFn?.[0], '桌面侧不再对 secret 做 trim').toMatch(/secret\.trim\(\)/);
  });

  it('三端都在 trim 之后才判空/存储(纯空白一律拒绝)', () => {
    /* 关键判据：不是「有没有 trim」，而是「判空用的是不是 trim 后的值」。
       桌面曾 `if secret.is_empty()`(trim 前) —— trim 存在却没用上，正是 #134 的形态。 */
    const rustBody = (/pub fn save_ai_credential[\s\S]*?\n}/.exec(rust) ?? ['', ''])[0];
    // 拒绝分支必须判 trim 后的变量(trimmed)，而不是原始 secret.is_empty()。
    expect(rustBody, '桌面仍对原始 secret 判空 ⇒ 纯空白会绕过拒绝(#134)').not.toMatch(/if\s+secret\.is_empty\(\)/);
    expect(rustBody, '桌面没有「trim 后判空」的拒绝分支').toMatch(/trimmed\.is_empty\(\)/);
    // 落库也必须存 trimmed，否则存的仍是带空白的脏串。
    expect(rustBody, '桌面仍把未 trim 的 secret 存进 keyring').toMatch(/set_password\(\s*trimmed\s*\)/);
    // 服务端：写入 setSetting 的是 key.trim() 而非原始 key。
    const serverLine = server.split('\n').find((l) => /saveProviderKey\s*=/.test(l)) ?? '';
    expect(serverLine, '服务端存的是未 trim 的原始 key').toMatch(/setSetting\([^)]*key\.trim\(\)/);
    // 浏览器：!trimmed 拒绝 + 存 trimmed。
    const browserBody = (/export async function saveAiCredential[\s\S]*?\n}/.exec(settings) ?? ['', ''])[0];
    expect(browserBody, '浏览器没有对 trim 后的值判空').toMatch(/if\s*\(!trimmed\)/);
    expect(browserBody, '浏览器存的是未 trim 的原始 secret').toMatch(/setItem\([\s\S]*?trimmed/);
  });

  it('正向钉子：读的确实是那三份源码', () => {
    expect(rust).toContain('pub fn save_ai_credential');
    expect(server).toContain('export const saveProviderKey');
    expect(settings).toContain('export async function saveAiCredential');
  });
});
