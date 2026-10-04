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
    expect(count(repo, "'mingli.pwa.records'")).toBe(3);      // nsKey 回退 / catch 回退 / 共享键认领
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
