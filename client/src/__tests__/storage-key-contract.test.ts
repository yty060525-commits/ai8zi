import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 本机存储的键名是「跨模块隐式契约」：写入方和读取方不在同一个文件里，编译器一个字都不会报。
   实测这个仓库里有四组这样的配对(下面逐条钉住)，任何一次「顺手改个键名」都会造成：
     - 通道漂移：设置页存了 A 键、批断读 B 键 ⇒ 用户选了通道二，实际跑的仍是默认那条；
     - 数据看不见：命名空间前缀变了 ⇒ 老用户的盘仍在设备上，列表却显示「暂无记录」。
   这类缺陷在界面上都不像 bug(没有报错)，所以判据只能放在源码层面：直接读真实文件、比对字面量。 */

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const AI_SETTINGS = '../data/aiSettings.ts';
const ADAPTER = '../data/deepseekAdapter.ts';
const SERVER_CLIENT = '../data/serverClient.ts';
const CHAT_ENGINE = '../data/chatEngine.ts';
const REPO = '../data/clientRepository.ts';

/** 从真实模块的源码里读出它写死的那个 localStorage 键名，**不在本文件抄第二份字面量**：
 *  判据要比的是「A 文件写的键」和「B 文件读的键」是不是同一个名字 —— 若这里写死字符串，
 *  两处一起改名就测不出来了(实测：K_SESSION 改名后 settings-page 三条用例红，而写死字面量的
 *  扫描照旧绿)。读不到定义就当契约断了，因为下一个分支就是「有人新抄了一份」。 */
const keyLiteralFromSource = (rel: string, decl: RegExp): string => {
  const hit = src(rel).match(decl);
  if (!hit) throw new Error(`${rel} 里找不到 ${decl.source} —— 键名定义被挪走或删掉了`);
  return hit[1];
};
const K_URL = keyLiteralFromSource(SERVER_CLIENT, /const K_URL = '([^']+)'/);
const K_SESSION = keyLiteralFromSource(SERVER_CLIENT, /const K_SESSION = '([^']+)'/);

describe('本机存储键的跨模块契约', () => {
  it('「当前使用通道」这一键：写侧与三个读侧用的是同一串字面量', () => {
    const KEY = "'mingli.provider'";
    // 写侧在 aiSettings：setAiProvider 落这一键、getAiProviderStatus 读它、测试复位删它，共三处。
    const settings = src(AI_SETTINGS);
    expect(count(settings, KEY)).toBe(3);
    // 三个读侧各读且只读这一处；任何一处换成别的键，本条立刻红。
    for (const rel of [ADAPTER, SERVER_CLIENT, CHAT_ENGINE]) {
      expect([rel, count(src(rel), KEY)]).toEqual([rel, 1]);
    }
  });

  it('浏览器直连的默认回退值必须与设置页同源(都回退 qwen)', () => {
    // 设置页缺省值：localStorage 没这一键时界面显示「通道三千问」在用。
    expect(src(AI_SETTINGS)).toContain("as AiProvider) ?? 'qwen'");
    // 批断通道排序的缺省值：同一条件下必须排到同一条通道，否则「显示千问、跑的是深思」。
    expect(src(ADAPTER)).toContain("?? 'qwen'");
  });

  it('凭据键前缀 + 账号命名空间前缀各自只有一处定义', () => {
    const cred = src(AI_SETTINGS);
    expect(count(cred, "'mingli.cred.'")).toBe(2);           // credKey() 定义 + 测试复位
    const repo = src(REPO);
    // 共享命名空间只许有**一处字面量**(SHARED_NS 的定义)：记录列表、待推送名单、换账号认领
    // 三处都从它派生。旧版这里是 3(nsKey 的两个分支 + 认领逻辑各抄一份)，那正是这个键最危险
    // 的形态 —— 任何一次「顺手改前缀」只会改掉其中一处，老用户的盘仍在设备上、列表却空了。
    expect(count(repo, "'mingli.pwa.records'")).toBe(1);
    expect(repo).toMatch(/const sharedDirtyKey = \(\): string => SHARED_NS \+ '\.dirty'/);
    expect(repo).toMatch(/const dirtyKey = \(\) => nsKey\(\) \+ '\.dirty'/);
    expect(count(repo, "'mingli.records.'")).toBe(1);         // 账号命名空间前缀，只有 nsKey 一处
    expect(count(repo, "'mingli.record.owners'")).toBe(1);
  });

  it('待推送清单的键由命名空间派生，不许再抄一份字面量', () => {
    // dirtyKey() = nsKey() + '.dirty'。曾经有人把 'mingli.pwa.records.dirty' 写死第二份：
    // 登录后本机视图按账号命名空间读写，脏标记却落在共享键上 —— 补推永远找不到待推的那几条。
    const repo = src(REPO);
    expect(repo).not.toContain("'mingli.pwa.records.dirty'");
    expect(repo).toMatch(/const dirtyKey = \(\) => nsKey\(\) \+ '\.dirty'/);
  });

  /* 登录态与服务器地址这两个键决定两件事：设置页重启后还认不认得出「已登录」，以及
     clientRepository 把本机数据放进哪一份命名空间(nsKey() 读 getServerSession())。
     键名只许在 serverClient 定义一次；测试与界面若各抄一份，改了产品那份就等于把老用户的
     登录态和盘一起留在设备上、界面上却什么都看不见。 */
  it('服务器地址与会话键只在 serverClient 定义一处，测试与界面都从它派生', () => {
    const sc = src(SERVER_CLIENT);
    expect(count(sc, "'mingli.server.url'")).toBe(1);
    expect(count(sc, "'mingli.server.session'")).toBe(1);
    // 读写两侧都走常量，不许出现裸字面量(那正是「顺手改一处」会漏掉的第二份)
    expect(sc).toMatch(/const getServerUrl[\s\S]{0,80}safeStorage\.get\(K_URL\)/);
    expect(sc).toMatch(/const getServerSession[\s\S]{0,80}safeStorage\.get\(K_SESSION\)/);
    // 上面两个常量就是从这份源码里读出来的；读不到就直接抛错，所以这里断言的是「名字仍是那一串」
    expect([K_URL, K_SESSION]).toEqual(['mingli.server.url', 'mingli.server.session']);
    // 测试侧(settings-page)写的会话键必须与产品读的是同一个：它写的是字面量，所以拿真实模块比对
    const settingsTest = src('../__tests__/settings-page.test.tsx');
    expect(count(settingsTest, "'" + K_SESSION + "'"), '测试里另抄了一份会话键 → 改名时两边不会一起红').toBeGreaterThan(0);
  });

  /* 中文读法词表(chineseReadAloud)的文件注释里写着它存在的理由：三处各抄一份时出现过
     「已配置 零 条」这种空格分词与连写混着来的脏文案。实测详情页仍有两处复发
     (自动重试第 N 次、清掉服务器 N 条缓存)，所以这里加一条源码层扫描：
     拼接中文计数两侧不许留空格(模板串里的 ${} 本来就没有引号，不受影响)。 */
  it('界面正文里的中文计数一律连写，不留「第 三 次」这种空格', () => {
    const files = ['../features/person/PersonDetail.tsx', '../features/records/RecordsPage.tsx', '../features/settings/SettingsPage.tsx', '../data/chatEngine.ts'];
    /* 判据只看中文串内部：闭合式写法「服务器上' + cnCount(n) + '条」两侧都没有空格，
       而脏文案是「服务器上 ' … ' 条」—— 空格紧贴着汉字。引号与加号不参与匹配
       (上一版拿 "' +" 当模式，把每一条正确写法都扫成了违规)。
       注释里也不许留这种形状 —— 它本身就会被自己的判据扫到，所以整行跳过注释。 */
    const spaced = /[\u4e00-\u9fff] ' \+ cnCount|cnCount\([^)]*\) \+ ' [\u4e00-\u9fff]/;
    for (const rel of files) {
      const hits = src(rel).split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(String(line)))
        .filter(([, line]) => spaced.test(String(line)));
      expect([rel, hits]).toEqual([rel, []]);
    }
  });
});
