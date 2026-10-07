/* 判据空白：「任务清单说做完了」这件事本身从来没有校验器。

   实测到的事故(2026-10-05)：任务 #64「逐条结果加点评留言」标着 completed，提交说明还写着
   「新增 19 条用例、全量 504 通过」，但 main 的树里压根没有 client/src/data/scopeNotes.ts，
   也没有那两份用例 —— 整个功能连同它的判据都不在当前分支上。原因是仓库里有两条互不相干的
   历史(git merge-base main <那条提交> 为空)，其中一条被一次回退从分支指针上摘掉，
   reflog 也查不到它；只剩 tag 和悬空对象还留着。

   这条判据不试图恢复功能(那是产品决定，见任务 #93)，只保证一件事：
   **凡是账目标成已完成的功能，它的实现文件必须在当前树里**。少了这道闸，下一次同样的
   摘枝回退照样会让界面少一个按钮而测试全绿 —— 因为被测的东西已经不在了，判据也就没东西可判。 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* vitest 的 cwd 是 client 目录，但斜杠结尾并不稳定(实测本机 process.cwd() 不带尾斜杠)：
   按「剥掉 /client」去推仓库根会得到同一个目录，git 照样能跑(子目录里也能查 HEAD)，
   于是这条判据悄悄在 client 子树里比对路径 —— 所有断言都变红却看不出为什么。
   这里跟仓库里其余 git 类判据用同一套写法(本文件向上三级)，并当场自证拿到的确实是仓库根。
   ⚠ new URL('.', import.meta.url) 在这份配置下会抛「The URL must be of scheme file」(实测)，
     必须走 dirname(fileURLToPath(import.meta.url))。 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const git = (args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

/** 有些 git 子命令用退出码表达结论(merge-base 找不到祖先就是 exit 1 + 空输出)，
 *  execFileSync 会把它当失败抛出。这类判断必须读「状态码 + 输出」两者，不能只读输出。 */
const gitRaw = (args: string[]): { status: number; out: string } => {
  try {
    return { status: 0, out: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: typeof err.status === 'number' ? err.status : -1, out: String(err.stdout ?? '') };
  }
};

/** 账本：标称「已交付」的功能 → 它在当前树里必须存在的实现文件。
 *  只登记**有唯一落盘文件**的那类(整块功能的新增文件)，纯改行为没有新文件的不在这里钉。
 *  ⚠ 新增功能时应在此追加一行；漏登记的代价就是本次这种「标记完成但代码不在」。 */
const DELIVERED: Array<{ label: string; file: string }> = [
  { label: '本地对话 A 层(规则问答通道)', file: 'client/src/data/chatEngine.ts' },
  { label: '调候用神查表', file: 'client/src/data/elementKnowledge.ts' },
  { label: '浏览器端 SQL 镜像', file: 'client/src/data/offlineSql.ts' },
  { label: '导入(.sqlite/.json/.sql)', file: 'client/src/data/sqlImport.ts' },
  { label: '导出(.sqlite/.sql 四格式互通)', file: 'client/src/data/sqliteExport.ts' },
  { label: '存储统计与缓存清理', file: 'client/src/data/storageInfo.ts' },
  { label: '服务器地址与会话', file: 'client/src/data/serverClient.ts' },
  { label: '三通道 AI 适配', file: 'client/src/data/deepseekAdapter.ts' },
  { label: '批断编排', file: 'client/src/data/baziOrchestrator.ts' },
];

/** 当前 HEAD 的树里有哪些路径(不读工作副本：未提交的临时文件不算数)。 */
function trackedPaths(): Set<string> {
  return new Set(git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean));
}

describe('账目闭合：标称已交付的功能，其实现文件必须在当前树里', () => {
  it('仓库根定位自证(判据不能悄悄跑在 client 子树里)', () => {
    /* 反向钉子：这条红说明 repo 指错了目录，那么下面所有路径断言都不可信。 */
    expect(existsSync(resolve(repo, 'client', 'package.json')), 'repo 下没有 client/package.json').toBe(true);
    expect(existsSync(resolve(repo, '.gitignore')), 'repo 不是仓库根(缺 .gitignore)').toBe(true);
    expect(git(['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/'))
      .toBe(repo.replace(/\\/g, '/'));
  });

  it.each(DELIVERED)('$label → $file 存在于 HEAD 树', ({ file }) => {
    expect([...trackedPaths()], `HEAD 树里没有 ${file}`).toContain(file);
  });

  it('这份判据自己也在树上，且树上那份真带着缺口登记', () => {
    /* 判据被摘枝丢掉比功能被丢掉更难发现：没人会去点一个不存在的按钮，而全绿的构建看着一切正常。
       光「文件存在」不算数 —— 文件在、里面的登记表被人删空，同样等于没闸门。 */
    const self = 'client/src/__tests__/delivered-files-in-tree.test.ts';
    expect([...trackedPaths()], `${self} 还没提交，闸门只在本地生效`).toContain(self);
    const inTree = git(['show', `HEAD:${self}`]);
    expect(inTree.includes('scopeNotes.ts'), '树上的版本里没有缺口登记的文件名').toBe(true);
    expect(inTree.includes('GAPS'), '树上的版本里没有缺口登记表').toBe(true);
    /* 三本账的条数下限：只查「有没有 GAPS 这个词」太松 —— 把 DELIVERED/MARKERS/CRITERIA 里
       任意一本掏空，其余断言照样绿(it.each 遇空数组是零条通过)。这里按**当场实测**的条数钉下限，
       留 3~5 条余量给正常增删；低于下限就是有人删了整块登记。 */
    expect(DELIVERED.length, '功能→实现文件账本被掏空了').toBeGreaterThanOrEqual(8);
    expect(MARKERS.length, '特征串账本被掏空了').toBeGreaterThanOrEqual(10);
    expect(CRITERIA.length, '判据账本被掏空了').toBeGreaterThanOrEqual(15);
    /* ⚠ 这一句读的是**树上的那份字节**，不是内存里的 const 数组 —— 否则本地加一条登记就会让
       「HEAD 自己」红(实测踩过：本地 CRITERIA 到 20 条后，`GAPS.length === 3` 拿工作副本比，
       而树上还是 3 条以外的旧值，红的其实是「还没提交」而不是「闸门被掏空」)。
       缺口登记表要等代码取回、这条转绿，所以它必须钉在树上的字节上。 */
    /* 【判据缺陷 #124 · 实测，踩了两次】切片锚点撞在同名子串上，读数就是错的：
       · 第一版拿 `indexOf('const GAPS')` 起切 —— 命中的是注释里那句同名子串，切片从判据区就开始数，
         把别处的 `{ task:` 也算进来 ⇒ 树上的表明明还是三条，读数却是 14、红在正确代码上。
       · 第二版把锚点换成带类型标注的声明行，照样红在 14 —— 因为**解释这条缺陷的注释里引用了那行代码**，
         字面量锚点又被自己撞了一次。indexOf 返回的是**最早**那次命中，不是唯一那次。
       结论：只要注释会引用代码，任何字面量锚点都可能被撞。改成「整行匹配 + 当场证明只有一行」，
       让锚点失效时直接红在闸门上，而不是悄悄切出一段别的东西冒充读数。 */
    const declLines = inTree.split('\n').filter((l) => /^\s*const GAPS: Array/.test(l));
    expect(declLines.length, '缺口登记表的声明行匹配到 0 或 >1 行 ⇒ 锚点不可信，下面的条数读数无意义')
      .toBe(1);
    const gapsStart = inTree.indexOf(declLines[0]);
    /* 收尾锚也必须**从起点往后找**：DELIVERED 的 `];` 在文件更前面，不带第二参的 indexOf('\n];')
       会命中它 ⇒ 切片塌成空段、条数读 0(#124 第三层，同一次改动里连错三口)。 */
    const gapsEnd = inTree.indexOf('\n];', gapsStart);
    expect(gapsEnd, '缺口登记表找不到收尾的 ] ⇒ 整块被人摘掉或结构变了').toBeGreaterThan(gapsStart);
    const gapsOnHead = inTree.slice(gapsStart, gapsEnd);
    expect(gapsOnHead.split('\n').filter((l) => /^\s*\{ task:/.test(l)).length,
      '树上的缺口登记表条数变了(整块摘掉就是 #64 当初静默丢失的形态)').toBe(3);
    /* 反向钉子(#124 的第二层)：当场证明「字面量子串锚」为什么不可信 —— 子串形态命中多处、
       整行形态只命中一处，两者必须同时成立。
       ⚠ 【判据缺陷 #128 · 实测】这里曾经钉的是「宽松行首锚比顶格锚命中更多」。基线上就红了
       (expected 1 to be greater than 1)：注释里引用那行代码时带着反引号前缀，行首并不裸露。
       树上字节的实测矩阵(三档行首锚全部命中同一行 242)：
         'const GAPS' 子串        → 7 处(91, 97, 112, 114, 117, 118, 242)
         /^\s*const GAPS/         → 1 处(242)
         l.startsWith('const GAPS') → 1 处(242)
       ⇒ 真正多命中的只有**子串**形态，而它正是第一版切片的锚；把行首锚放松一档读数不变，
       所以任何「行首锚命中数」的比对都杀不掉 MUT-D 那类放宽。据此撤掉顶格锚那条空判据。 */
    const substringHits = inTree.split('\n').filter((l) => l.includes('const GAPS')).length;
    expect(substringHits, '子串锚只剩一行 ⇒ 注释里的同名引用没了，下面的比对失去意义').toBeGreaterThan(1);
    expect(declLines.length, '整行锚与子串锚命中数相同 ⇒ 本条判据要重写(见 #128)').not.toBe(substringHits);
    /* #124 第三层的结构性后果，可杀(实测)：把起点退回第一个子串命中(即有人改回 indexOf('const GAPS'))，
       切片会越过声明直接撞上更前面的 DELIVERED 收尾 `];` ⇒ gapsEnd < gapsStart。这条红就是那个改动的回执。 */
    expect(inTree.indexOf('\n];'),
      '第一个 ] 出现在声明之后 ⇒ 收尾锚不再依赖 fromIndex，#124 第三层的教训失效了').toBeLessThan(gapsStart);
    /* 工作副本与树上必须一致：否则「本地红、CI 绿」会让人把这条当成不稳定判据关掉。 */
    expect(readFileSync(resolve(repo, self), 'utf8').replace(/\r\n/g, '\n'))
      .toBe(inTree.replace(/\r\n/g, '\n'));
  });

  it('仓库里确实存在两条互不相干的历史(解释功能为何会「凭空消失」)', () => {
    /* merge-base 找不到共同祖先时是 exit 1 + 空输出，execFileSync 会把非零状态当失败抛出，
       所以必须读 gitRaw 的状态码；只看输出会在「两条历史其实已合并」时也拿到空串而误报绿灯。 */
    const base = gitRaw(['merge-base', 'HEAD', 'lost-scope-notes']);
    expect(base.status, 'merge-base 应以退出码 1 表达「没有共同祖先」，实际: ' + base.status).toBe(1);
    expect(base.out.trim(), '两条独立历史 ⇒ 不该有共同祖先提交').toBe('');
  });

  it('防丢失标签还在(删了它，那段历史就只剩悬空对象，gc 之后永久不可恢复)', () => {
    const tags = git(['tag', '-l']).split('\n');
    expect(tags, '缺少指向那条历史的标签').toContain('lost-scope-notes');
    expect(tags, '缺少回退前的快照标签').toContain('snap-20260928-2022-pre-rollback');
  });

  it('两个标签各自都真带着 scopeNotes.ts(证明代码仍可取回，不是口头承诺)', () => {
    for (const tag of ['lost-scope-notes', 'snap-20260928-2022-pre-rollback']) {
      const paths = git(['ls-tree', '-r', '--name-only', tag]).split('\n');
      expect(paths, `${tag} 的树里没有 scopeNotes.ts`).toContain('client/src/data/scopeNotes.ts');
    }
  });

  /* 特征串账本：纯改行为的功能没有新文件可登记(比如「大运段覆盖十年窗口」只是把已有函数改了判据)，
     于是钉在它**留在源码里的那句人话**上。这些串都是先逐条在 HEAD 树里实测过才登记的 ——
     没核实过的串会把闸门写成永红，下次改动时被人当成噪音直接删掉，闸门就废了。 */
  const MARKERS: Array<{ task: string; file: string; text: string }> = [
    { task: '#79 大运段覆盖未来十年窗口', file: 'client/src/data/baziOrchestrator.ts', text: '与十年窗口有交集' },
    { task: '#34 大运「覆盖年」检索', file: 'client/src/features/chart/nonAiCalculator.ts', text: '覆盖年' },
    { task: '#36 小节检索兜底收紧', file: 'client/src/data/chatEngine.ts', text: 'sliceSections' },
    { task: '#41 默认通道=通道三千问', file: 'client/src/data/aiSettings.ts', text: '通道三千问' },
    { task: '#92 详情页勾选式复制入口', file: 'client/src/features/person/PersonDetail.tsx', text: '复制勾选内容' },
    { task: '#91 记录页全选入口', file: 'client/src/features/records/RecordsPage.tsx', text: '全选当前' },
    { task: '#59/#60 早子时换日', file: 'client/src/features/chart/nonAiCalculator.ts', text: '早子时' },
    { task: '#42 农历/闰月输入', file: 'client/src/features/chart/ChartPage.tsx', text: '闰月' },
    /* #78「网页版连通自检如实说明」的落点在 storageInfo.ts，但那句中文文案后来被改写过(实测：
       按原话登记会红)。这里钉的是**仍然在树上的**函数名而不是文案 —— 特征串必须是当场核实过的，
       否则这条闸门会在下一次正常改动里被当成噪音删掉。 */
    { task: '#78 AI 连通自检入口', file: 'client/src/data/storageInfo.ts', text: 'runAiSelfTest' },
    { task: '#83 wiki 知识库', file: 'docs/wiki/README.md', text: '#' },
    { task: '#16/#81 gh-pages 发布脚本', file: 'scripts/deploy-pages2.mjs', text: 'gh-pages' },
  ];

  it.each(MARKERS)('任务 $task 的特征串必须在 $file 里', ({ task, file, text }) => {
    const inTree = git(['show', `HEAD:${file}`]);
    expect(inTree, `HEAD 上 ${file} 里找不到「${text}」—— $task 的实现可能已不在当前分支`).toContain(text);
  });

  it('特征串账本非空且每条都真能在树上取到(防止登记被掏空后全绿)', () => {
    /* 反向钉子，实测有效：it.each 遇到空数组会「零条通过」而整块变绿。把 MARKERS 清空后，
       上面那组一条都不生成，只有这一句红(14 passed / 3 failed)。 */
    expect(MARKERS.length, '特征串账本被掏空了').toBeGreaterThanOrEqual(8);
    for (const m of MARKERS) {
      expect(git(['show', `HEAD:${m.file}`]), `树上取不到 ${m.file}`).toContain(m.text);
    }
  });

  /* 判据自身也要进账本 —— 否则「实现没了、用例也没了」就是完美的静默丢失。
     #64 那次丢的不止 scopeNotes.ts：它 accompanying 的两份用例(scope-notes.test.ts /
     scope-notes-ui.test.tsx)同样不在 HEAD 上，所以全量构建照样绿。
     ⚠ 新增一份**专门守某个功能**的用例时，在这里登记它的文件名；不登记的代价就是本次这种
        「闸门跟着功能一起消失」。 */
  const CRITERIA: Array<{ guards: string; file: string }> = [
    { guards: '#92 复制回执计数', file: 'copy-receipt-count.test.tsx' },
    { guards: '联网删除走 DELETE 通道', file: 'delete-online-sync.test.ts' },
    { guards: '详情页全选/清空两组开关', file: 'copy-chips-select-all.test.tsx' },
    { guards: '记录页全选范围(#91)', file: 'records-select-all-scope.test.tsx' },    { guards: '导出面板勾选不带入(#90)', file: 'export-panel-inclusion.test.tsx' },
    { guards: '语气进度条本机按盘', file: 'tone-local-scope.test.ts' },
    { guards: '北京口径全空间扫描(#87)', file: 'beijing-caliber-scan.test.ts' },
    { guards: 'wiki 链接可达(#83/#84/#89)', file: 'wiki-links-reachable.test.ts' },
    { guards: '五行配比唯一口径(#9/#11)', file: 'element-ratio-display.test.ts' },
    { guards: '默认通道三端跟随(#41)', file: 'provider-follow-contract.test.ts' },
    { guards: 'Qwen 前缀缓存打标', file: 'qwen-cache-mark.test.ts' },
    { guards: 'SW 缓存版本号', file: 'sw-cache-version.test.ts' },
    { guards: 'gh-pages 旧 chunk 保留规则(#16/#80)', file: 'deploy-retain-rule.test.ts' },
    { guards: '存储键命名契约', file: 'storage-key-contract.test.ts' },
    { guards: '闸门口径单一来源', file: 'gate-single-source.test.ts' },
    { guards: '固定池退队重发的口数账(#104/#108/#110/#117/#120)', file: 'pool-retry-budget.test.ts' },
    /* ⚠ CRITERIA 的 `file` 会拼进 `client/src/__tests__/`，所以**只能登记用例文件名**。
       实测教训(本轮)：把实现落点写成 '../features/person/PersonDetail.tsx' 也照样能过 ——
       HEAD 树里确实存在 client/src/features/person/PersonDetail.tsx，于是「红转绿」被误读成
       「路径写错了」。改参照 '..' 等于把闸门挪到另一棵子树上比对，自己把它解除。 */
    { guards: '#100 详情页失败后自动排期重试', file: 'auto-retry-schedule.test.tsx' },
    { guards: '#129 语气默认档三处同源', file: 'tone-default-single-source.test.ts' },
    { guards: '#131 聊天缓存键跨端版本对齐', file: 'cache-key-cross-end.test.ts' },
    { guards: '#132 natal 键序三端同序', file: 'natal-key-order-cross-end.test.ts' },
    { guards: '#113/#116/#119 进度条占位与分母同源', file: 'progress-bar-count.test.tsx' },
  ];

  it.each(CRITERIA)('守「$guards」的用例 $file 必须在 HEAD 树里', ({ file }) => {
    const dir = 'client/src/__tests__/';
    expect([...trackedPaths()], `HEAD 树里没有 ${dir}${file}`).toContain(dir + file);
  });

  it('判据账本只许录用例目录内的文件名(防止用 .. 把闸门挪到别的子树)', () => {
    /* 反向钉子：上面那条对 '../features/person/X.tsx' 这种写法是**通得过**的，
       也就是说有人可以不改代码、只改登记里的路径，就把一道闸门换成一颗无关的树。
       这一句把这类写法当场钉红。 */
    for (const c of CRITERIA) {
      expect(c.file, `判据账本里的 ${c.file} 指向用例目录之外`).not.toContain('..');
      expect(c.file, `判据账本里的 ${c.file} 不是用例文件名`).toMatch(/\.test\.(ts|tsx)$/);
    }
  });

  it('判据账本非空(掏空它就等于把所有闸门一次性摘掉)', () => {
    /* 与 MARKERS 同一形态的反向钉子：CRITERIA 为空时上面那条 it.each 会零条通过而全绿。 */
    expect(CRITERIA.length, '判据账本被掏空了').toBeGreaterThanOrEqual(10);
  });
});

/* ============================================================================
   缺口登记表 —— 下面这个 describe **预期是红的**，它是唯一一处把「账目标了完成、
   代码却不在树上」写进构建的地方。三条反直觉的设计，动手前请先读完：

   1) 不许删这一行。删掉等于又一次静默丢失：#64 当初就是这么消失的 —— 界面上少一个按钮，
      测试却全绿，因为被测的文件压根不存在(实测：把整项摘掉后其余 13 条照旧全绿)。
   2) 不许改成 xit / it.skip。跳过不参与构建，等于自己把闸门拆了。
   3) 不许把断言反写成 not.toContain 让它变绿。那样它会永远绿，而且分不清「代码取回来了」
      和「判据被人摘掉了」。

   补齐路径：从 tag lost-scope-notes(→ 8fb8d03)或 snap-20260928-2022-pre-rollback 取回文件，
   确认它出现在 HEAD 树里 ⇒ 这一条自然转绿 ⇒ 再把它移进 DELIVERED 并撤掉这条登记。
   ========================================================================== */
const GAPS: Array<{ task: string; claimedDone: boolean; code: string; file: string }> = [
  { task: '#64', claimedDone: true, code: 'scopeNotes.ts', file: 'client/src/data/scopeNotes.ts' },
  /* 「本地系统 / 第四路离线批断」整块都不在当前分支上：#49-58、#67、#70、#72-74、#77 全标着已完成，
     #77 甚至还挂着 in_progress。实测取证(不是推断)：
       · HEAD 的 client/src/data/aiSettings.ts 里没有 OFFLINE_STORAGE_KEY / isOfflineMode ——
         而 lost-scope-notes 那份的第 79-84 行就有它们；
       · HEAD 的 types/domain.ts 里 BaziTaskResult 没有 source?: 'cloud' | 'local'(第 137 行整行缺失)，
         lost-scope-notes 那份有，注释还写着「界面对本地结果打绿点标注」；
       · HEAD 与工作副本都搜不到 localAnalysis.ts / localSystem.ts 这两个文件名。
     所以这不是「某个文件没提交」，而是**一次回退把整条链从指针上摘掉了**，连带它的判据一起。 */
  { task: '#49-52/#67/#70/#72-74', claimedDone: true, code: 'localAnalysis.ts', file: 'client/src/data/localAnalysis.ts' },
  { task: '#49/#77', claimedDone: true, code: 'localSystem.ts', file: 'client/src/data/localSystem.ts' },
];

describe('【已知缺口，红灯是预期状态】标称已完成但实现不在当前树里', () => {
  it.each(GAPS)('任务 $task 的实现 $code 必须在 HEAD 树里(现在不在 ⇒ 本条为红)', ({ task, claimedDone, code, file }) => {
    /* claimedDone 不是装饰：它把「任务清单上的标记」变成判据的输入。
       若有人为了消掉红灯把 claimedDone 改成 false(谎称任务没做完)，这句会立刻红，
       逼他同时去改任务清单 —— 两处不一致就过不了构建。 */
    expect(claimedDone, `任务 ${task} 已不再标称完成，请把这条缺口登记整项撤掉`).toBe(true);
    expect([...trackedPaths()], `HEAD 树里没有 ${file}`).toContain(code);
  });

  it('登记的每一项确实还不在树上(防止换一句改参照就把闸门关掉)', () => {
    /* 反向钉子，实测有效：把 trackedPaths 的参照从 HEAD 换成 lost-scope-notes，
       上面那条会被动转绿(那个标签的树里当然有这个文件)，而这一句会红。
       没有这一句，闸门可以在不换分支、不删代码的情况下被一句改参照解除。 */
    for (const gap of GAPS) {
      expect([...trackedPaths()], `${gap.code} 其实已在树上，请把这条登记移进 DELIVERED`).not.toContain(gap.file);
    }
  });
});
