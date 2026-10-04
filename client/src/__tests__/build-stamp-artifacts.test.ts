import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 发版后手机「停在旧版本」修过两轮(见 sw-cache-version.test.ts)，但那条链上还有两个环节
   从来没被断过，而且它们断了不会报错、只会「看起来一切正常」：
     1) UI 底部那个构建戳是用户唯一的判据。若 vite 的 define 没把 __BUILD_ID__ 换掉，
        buildInfo 会静默回退成 'unknown' —— 缓存其实每版都在变，界面上却永远显示同一个值，
        「手机是不是旧版」重新变成不可判定(项目记忆里专门记着这条)。
     2) 设置页「已缓存版本」拿界面显示的缓存号与 SW 实际用的缓存名比相等；这两个串由两个
        不同注入点各自生成(define / closeBundle 改写 dist/sw.js)，任一处漏替换就恒为假。
   实测形态(2026-10-05，dist/assets/index-*.js)：esbuild 把 JSON.stringify 出来的单引号串
   折成反引号，所以产物里是 var La=\`1791137193028\`；判据因此只认「引号包住的定长数字串」
   这一种形状，两种引号都收 —— 不把工具写法当契约。 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../') + '/';
const read = (p: string): string => readFileSync(root + p, 'utf8').replace(/\r\n/g, '\n');
const DIST_SW = 'client/dist/sw.js';
const DIST_HTML = 'client/dist/index.html';
const ASSETS = 'client/dist/assets/';

/* 注入后的构建号在产物里的形状。实测(esbuild 2026-10-05)：JSON.stringify 出的单引号串会被
   折成反引号(var La=`…`)，所以判据按「三种引号都算」写；这里用真实字节把这条测出来，
   而不是把工具写法当契约 —— 哪天压缩器改回单引号，本条会先红在这里，而不是让上面那条空转。
   注意字符类必须显式列出双引号、单引号与反引号：写成 ["`] 时它实际只是「双引号或反引号」，
   单引号形态的样例永远匹配不上(实测害我连出两次假失败)。 */
const STAMP = /["'`]\d{10,}["'`]/;
const QUOTED = (s: string): Array<[string, string]> => [["'" + s + "'", 'single'], ['`' + s + '`', 'backtick']];

/** dist 里入口 bundle 的内容；未构建返回 null，用例按既有口径如实跳过。 */
function entryBundle(): { name: string; text: string } | null {
  if (!existsSync(root + DIST_HTML)) return null;
  const hit = /src="\.\/assets\/(index-[^"]+\.js)"/.exec(read(DIST_HTML));
  if (!hit) throw new Error('dist/index.html 里没有 ./assets/index-*.js 入口引用 —— 打包方式变了');
  if (!existsSync(root + ASSETS + hit[1])) throw new Error(`index.html 指向 ${hit[1]}，但 dist/assets 里没有它`);
  return { name: hit[1], text: read(ASSETS + hit[1]) };
}

describe('构建产物里的版本戳必须真的落进去', () => {
  it('dist/sw.js 的 CACHE 是数字时间戳，且与入口 bundle 里注入的构建号同源同值', () => {
    if (!existsSync(root + DIST_SW)) return; // 未构建
    const sw = read(DIST_SW);
    expect(sw).not.toContain('__BUILD_ID__');
    const cache = /const CACHE = 'mingli-(\d{10,})';/.exec(sw);
    if (!cache) throw new Error('dist/sw.js 的 CACHE 不是 mingli-<时间戳> 形状');
    const bundle = entryBundle();
    if (!bundle) return;
    expect(bundle.text, '入口 bundle 里根本没有构建号 —— define 注入没生效，界面会退回 unknown')
      .toMatch(STAMP);
    // 同源判据：SW 用的缓存号那串裸 id，必须以带引号的形式出现在界面代码里(两个注入点同值)。
    // 实测当前产物用反引号形态；两种引号都接受，命中哪一种由下面那条「压缩器写法」用例当场报出。
    const forms = QUOTED(cache[1]).filter(([q]) => bundle.text.includes(q));
    expect(forms.length, 'UI 显示的构建号与 SW 缓存号不同源，设置页「已缓存版本」那行永远说不一致').toBeGreaterThan(0);
  });

  it('入口 bundle 不残留占位符，也不带写死的旧缓存号', () => {
    const bundle = entryBundle();
    if (!bundle) return;
    expect(bundle.text).not.toContain('__BUILD_ID__');
    /* 「mingli-v2」那一版让已装 PWA 的手机永远拿不到新版，它不许回到产物里。
       判据必须限定在缓存名这一形态：全文里本来就有 mingli-local(IndexedDB 库名)、
       mingli-export-(导出文件名)、mingli-server(服务自检回包标识)，宽匹配会把正常代码判成脏。 */
    expect(bundle.text).not.toMatch(/mingli-v\d/);
    expect(bundle.text).toMatch(STAMP);
  });

  /* 反钉(记忆教训：否定式判据必须配正向钉子)：上面靠正则扫产物，
     这里用「未替换」的假形态证明扫描确实会拒绝，再用真实形态证明它接受。 */
  it('扫描本身能识别未替换的产物形态', () => {
    const fakeSw = "const CACHE = 'mingli-__BUILD_ID__';";
    expect(fakeSw).toContain('__BUILD_ID__');
    expect(/const CACHE = 'mingli-(\d{10,})';/.test(fakeSw)).toBe(false);
    for (const fake of ['var La=`unknown`;', "var La='unknown';", 'var La=void 0;', 'var La=`179113`;']) {
      expect([fake, STAMP.test(fake)]).toEqual([fake, false]);
    }
    // 三种引号都要放行：产物里到底是哪一种由「观测值」那条报出，判据本身不押写法
    for (const ok of ['var La=`1791137193028`;', "var La='1791137193028';", 'var La="1791137193028";']) {
      expect([ok, STAMP.test(ok)]).toEqual([ok, true]);
    }
    // 旧缓存号的正/反例：v2 必须被拒，时间戳形态必须放行
    expect(/mingli-v\d/.test("caches.open('mingli-v2')")).toBe(true);
    expect(/mingli-v\d/.test('var a=`mingli-local`,b="mingli-export-"')).toBe(false);
  });

  /* 记录压缩器的实际写法(不是契约，是观测)：上面的同源判据接受两种引号，
     这条把「到底是哪一种」钉出来 —— 若哪天 esbuild 换了写法，本条先红，
     提醒去看 sw.js / buildInfo 两侧是否仍同值，而不是让同源判据悄悄失去意义。 */
  it('当前产物里构建号的引号形态(观测值，随压缩器写法变化)', () => {
    const bundle = entryBundle();
    if (!bundle || !existsSync(root + DIST_SW)) return;
    const cache = /const CACHE = 'mingli-(\d{10,})';/.exec(read(DIST_SW));
    if (!cache) return;
    const forms = QUOTED(cache[1]).filter(([q]) => bundle.text.includes(q)).map(([, kind]) => kind);
    expect(forms, '产物里构建号的引号形态应当至少有一种(且都是带引号的定长数字串)').toEqual(['backtick']);
  });

  it('dist/assets 至少有一个 index-*.js，且文件名带内容哈希', () => {
    if (!existsSync(root + ASSETS)) return;
    const names = readdirSync(root + ASSETS).filter((f) => /^index-.+\.js$/.test(f));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).toMatch(/^index-[A-Za-z0-9_-]{6,}\.js$/);
  });
});
