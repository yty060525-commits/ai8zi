/* 判据：scripts/deploy-pages2.mjs 的「旧 chunk 保留」规则。
 * 这是踩过线上事故的那条链(截图记录：删光旧哈希 chunk ⇒ 已加载未刷新的旧页面动态 import 404)。
 * 本文件不碰 GitHub —— 只把脚本里那条纯规则抠出来跑，并钉住「抠出来的就是产品那份」。
 * 配套变异电池：scripts/mutation-deploy-retain.cjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const src = readFileSync(resolve(repo, 'scripts/deploy-pages2.mjs'), 'utf8').replace(/\r\n/g, '\n');

/** 从产品源码里取「字面量原文」，取不到直接抛错，绝不返回 undefined。 */
function literal(decl: RegExp): string {
  const m = decl.exec(src);
  if (!m) throw new Error('deploy-pages2.mjs 里找不到声明：' + decl.source);
  return m[1];
}

/** 按行取原文：找到以 prefix 开头的那一行，剥掉前缀和结尾分号。
 *  用整行贪婪正则容易读空，所以走「唯一前缀 + 行首匹配」。 */
function line(prefix: string): string {
  const l = src.split('\n').map((x) => x.trim()).find((x) => x.startsWith(prefix));
  if (!l) throw new Error('脚本里找不到以 ' + prefix + ' 开头的行 —— 规则被改写或删掉了');
  return l.slice(prefix.length).replace(/;$/, '');
}

/* 保留规则的产品实现：HASHED 判定 + KEEP_PER_BASE 上限 + byBase 分组 + slice(-KEEP_PER_BASE)。
   两份常量都从产品源码抠出来，规则本体在测试里按同一步序复现；下面的「逐字等价」判据
   把复现体和真实脚本对齐 —— 真实脚本改了步序而这里没改，那条判据当场红。
   (不用 new Function 去执行读来的源码：把文件内容当代码编译既不安全也没必要。) */
const HASHED = new RegExp(literal(/const HASHED = \/(.+)\/;/), '');
const KEEP = Number(literal(/const KEEP_PER_BASE = (\d+);/));

function retain(prevKept: { path: string }[], keep: number): string[] {
  const byBase = new Map<string, string[]>();
  for (const e of prevKept) {
    const base = e.path.split('/').pop()!.replace(HASHED, '');
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base)!.push(e.path);
  }
  return [...byBase.values()].flatMap((list) => list.slice(-keep));
}

describe('gh-pages 部署的旧 chunk 保留规则', () => {
  it('规则本身：只留上一版、每个基名有上限、当前版不误留、非哈希文件不参与', () => {
    // 落地自证：注入的常量必须真是产品那份(否则下面测的是我自己写的表达式)
    expect(HASHED.source, 'HASHED 不是从产品源码抠的').toContain('-[A-Za-z0-9_-]');
    expect(Number.isFinite(KEEP) && KEEP > 0, 'KEEP_PER_BASE 读出来不是正整数：' + KEEP).toBe(true);

    const blob = (path: string, sha = path) => ({ type: 'blob', path, sha });
    const currentPaths = ['assets/index-new12345678.js'];
    const tree = [
      // 同一基名 5 份历史版本(含一份与当前同名的，必须被 current 排除)
      blob('assets/index-old12345678.js'),
      blob('assets/index-old22345678.js'),
      blob('assets/index-old32345678.js'),
      blob('assets/index-old42345678.js'),
      blob('assets/index-new12345678.js'),
      // 另一个基名只有 1 份
      blob('assets/Chart-aaaa1111.js'),
      // 不带哈希的文件：不参与保留(入口只留最新一份)
      blob('index.html'),
      blob('assets/index.js'),
      // 目录节点不该被当成 blob 保留
      { type: 'tree', path: 'assets/index-old52345678.js', sha: 'x' },
    ];
    const kept = retain(
      tree.filter((e) => e.type === 'blob' && HASHED.test(e.path) && !currentPaths.includes(e.path)).map((e) => ({ path: e.path })),
      KEEP);

    // 上限生效：第一个基名 5 份候选(去掉当前版剩 4 份)只留最后 KEEP 份
    const firstBase = kept.filter((p) => p.startsWith('assets/index-'));
    expect(firstBase.length, '同一基名保留数不等于 KEEP_PER_BASE').toBe(KEEP);
    // 留的是「最近的那几份」(slice(-N) 语义)，不是最老的。
    // KEEP=3 时候选 [old1,old2,old3,old4] 应留 old2..old4；期望值由同一份候选列表算出，不写死。
    const firstBaseCandidates = ['assets/index-old12345678.js', 'assets/index-old22345678.js',
      'assets/index-old32345678.js', 'assets/index-old42345678.js'];
    expect(firstBase).toEqual(firstBaseCandidates.slice(-KEEP));
    // 当前版不重复保留
    expect(kept).not.toContain('assets/index-new12345678.js');
    // 另一基名的那一份照常保留
    expect(kept).toContain('assets/Chart-aaaa1111.js');
    // 非哈希与目录节点都不在
    expect(kept).not.toContain('index.html');
    expect(kept).not.toContain('assets/index.js');
    expect(kept).not.toContain('assets/index-old52345678.js');
    // 反向钉子：规则不能退化成「全留」或「全删」
    expect(kept.length, '保留数等于候选数 ⇒ 上限没生效').toBeLessThan(
      tree.filter((e) => e.type === 'blob' && !currentPaths.includes(e.path)).length);
    expect(kept.length, '一个都没留 ⇒ 旧页面必 404').toBeGreaterThan(0);

    /* 「一个都没留」这一类光靠上面那句不够：产品里 kept 是常量，把它清空不会碰到任何被比对的行。
       所以把消费端也钉住 —— 建树请求的 tree 字段必须真的带着保留条目上去。 */
    const req = literal(/const tree = await gh\(([\s\S]*?)\);/);
    expect(req, '部署树不再把保留条目并进去(旧页面动态 import 会 404)')
      .toContain("...kept.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha }))");
    // 落地自证：上面确实读到了那一行的正文，而不是抠到空串后恒等
    expect(req.length, '抠到的建树请求过短').toBeGreaterThan(60);
    expect(src.match(/kept\.length = 0|kept = \[\]/g)?.length ?? 0, '脚本里出现了清空 kept 的代码')
      .toBe(0);
  });

  it('parent 指向 gh-pages 自身而不是 main（按历史判龄的前提）', () => {
    // 写成 main 会让分支祖先链断成源码快照，既无法按历史判龄，也让每次部署像「第一次引入」。
    // 只扫代码行：注释里那句「写成 main 会…」是解释性文字，历史上真判据就红在这种注释上。
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const parents = literal(/parents: \[(.+)\]/);
    expect(parents.trim(), 'parents 不再是 gh-pages 的上一个提交').toBe('ref.data.object.sha');
    expect(code, '部署目标分支写错了').toContain("refs/heads/gh-pages'");
    expect(code.match(/\bmain\b/g)?.length ?? 0, '代码里不该再出现 main 引用(注释已排除)').toBe(0);
  });

  it('测试复现的规则与真实脚本逐字等价（产品改步序时本文件必须变红）', () => {
    // 抠出产品里「筛 prevKept → 取基名 → slice」三行的原文，与本文件的实现逐段比对。
    // 不这么做的后果很典型：测试自己重抄一遍规则，产品改了、测试没改，就永远测不出回归。
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(norm(line('const prevKept =')), '筛选条件与判据不一致(哈希判定/当前版排除)')
      .toBe("(treeInfo.data?.tree || []).filter((e) => e.type === 'blob' && HASHED.test(e.path) && !current.has(e.path))");
    // 基名提取：产品那行把正则**内联**写了(replace(/-[A-Za-z…]{8,}\.(js|css)$/, ''))，
    // 而本文件复用 HASHED 常量。所以判据不能比字面量，要比「两个正则对同一批路径给出同一个基名」。
    const inlineRe = new RegExp(literal(/\.replace\(\/(.+?)\/,\s*''\)/), '');
    const samples = ['assets/index-a1b2c3d4e5.js', 'assets/Chart-9f8e7d6c5b.css', 'assets/plain.js',
      'nested/dir/Bazi-view1234567890.js', 'index.html'];
    for (const p of samples) {
      expect(p.split('/').pop()!.replace(inlineRe, ''), '内联正则与 HASHED 在 ' + p + ' 上给出的基名不同')
        .toBe(p.split('/').pop()!.replace(HASHED, ''));
    }
    // 反向钉子：上面这组样本必须真的能区分两种写法(全给同名 = 样本没覆盖到差异)
    expect(samples.some((p) => /-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(p)), '样本里得有带哈希的文件').toBe(true);
    expect(norm(line('const kept =')), '截断方式与判据不一致')
      .toBe('[...byBase.values()].flatMap((list) => list.slice(-KEEP_PER_BASE))');
  });
});
