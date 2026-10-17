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
  { label: '逐条点评存储', file: 'client/src/data/scopeNotes.ts' },
  { label: '本地批断引擎', file: 'client/src/data/localAnalysis.ts' },
  { label: '本地系统开关', file: 'client/src/data/localSystem.ts' },
  { label: '非AI原位编辑控件', file: 'client/src/features/person/NonAiInlineEditor.tsx' },
  { label: '人工有效事实逐叶契约', file: 'client/src/shared/manualNonAi.ts' },
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
    const tableBody = (name: string) => {
      const lines = inTree.split('\n');
      const starts = lines.map((line, index) => /^\s*const (DELIVERED|CRITERIA): Array/.test(line) && line.includes(name) ? index : -1).filter((index) => index >= 0);
      expect(starts.length, `HEAD 中 ${name} 表声明不唯一`).toBe(1);
      const end = lines.findIndex((line, index) => index > starts[0] && /^\s*\];\s*$/.test(line));
      expect(end, `HEAD 中 ${name} 表无收尾`).toBeGreaterThan(starts[0]);
      return lines.slice(starts[0], end + 1).join('\n');
    };
    const deliveredOnHead = tableBody('DELIVERED');
    const criteriaOnHead = tableBody('CRITERIA');
    for (const gap of GAPS) {
      expect(deliveredOnHead, `HEAD 的 DELIVERED 未登记 ${gap.file}`).toContain(gap.file);
      for (const testFile of gap.criteria) {
        expect(criteriaOnHead, `HEAD 的 CRITERIA 未登记 ${testFile}`).toContain(`file: '${testFile}'`);
      }
    }
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
    /* 【缺陷 #149】构建口径：`npm run build` 的第一步是 `tsc -b`(package.json 里写死)，而 tsconfig
       的 include 是整个 `src` —— **测试文件也在编译范围内**，所以任何一份用例的类型错误都会挡住整站构建。
       这条不是猜测：实测把另一会话未提交的 stop-analysis-recovery.test.tsx 移开后 `npx tsc -b` 仍红在
       两条 TS7016 上，而我上一轮的提交信息据此写了「唯一一条构建期错误来自他人文件」——那句当场就是错的。
       钉住这两个字符串，是为了让「有人收窄 include/exclude(测试从此不进构建)」这件事必须留下读数：
       真要把 __tests__ 排除掉是个独立决定(得同时回答「判据还跑不跑」)，不该被一次顺手改配置静默带过。 */
    { task: '#149 tsc -b 把用例编进构建(测试类型错误会挡住发布)', file: 'client/tsconfig.json', text: '"include": ["src"]' },
    { task: '#149 同上：build 脚本第一步就是 tsc -b', file: 'client/package.json', text: 'tsc -b && vite build' },
    /* 【#150 非 AI 侧新功能】大运「顺排/逆排」这句读数：引擎一直算得出来(fortuneDirection)，
       展示层从来没有说过它 —— grep「顺排|逆排」在产品代码里命中 0 处，页面上只有九步运的干支。
       特征串取**函数名**而不是那句中文文案(#78 的教训：登记文案会在下一次正常改写时变成噪音红)。 */
    { task: '#150 详情页说出大运排法方向', file: 'client/src/features/person/PersonDetail.tsx', text: 'luckDirectionText' },
    /* 【#151 非 AI 侧**可修改**功能】用户能在详情页改四柱并让整张盘重排。
       特征串取函数名 applyPillarEdit(同上：不登记中文文案)，BirthInputModal 那条取新增的预填参数。 */
    { task: '#151 详情页修正四柱走引擎重算', file: 'client/src/features/person/PersonDetail.tsx', text: 'saveNonAiEdits' },
    { task: '#151 原位控件支持当前命盘草稿', file: 'client/src/features/person/PersonDetail.tsx', text: 'sourceDraftOf(loadedRecord)' },
    /* 【#152 构建期类型闸门收口】钉的是**声明文件里那行通配形**，因为它是唯一能生效的写法：
       兄弟位置的 ai 声明文件、按整条 specifier 写的 declare module 两种「直觉写法」实测都仍红两条 TS7016。
       这条串一旦不在树上(改名、换成那两种写法之一、或整份删掉)，tsc -b 立刻回到 3 条错误 ——
       而 vitest 完全不做类型检查，所以只有登记进特征串账本才有人守着。 */
    { task: '#152 server/ai.mjs 的通配类型声明(清掉两条 TS7016)', file: 'client/src/types/server-ai.d.ts', text: "declare module '*.mjs'" },
    /* 【#153 语气滑杆刻度】钉产品侧那一行的**绑定**而不是数字：`tone === DEFAULT_TONE` 是这次收口的实体，
       改回裸数字 80 就等于把标注与常量脱钩(#129 的注释把它当后果描述过，却没有判据绑住)。
       ⚠ MARKERS 读的是 HEAD 树字节 ⇒ 本条必须等这次改动提交后才可能绿。 */
    { task: '#153 「这是默认档」的比较对象绑定到常量', file: 'client/src/features/person/PersonDetail.tsx', text: 'tone === DEFAULT_TONE' },
    /* 【#154 采纳闸门】钉的是「谁算本账号」不再靠字符串兜底：`const me = getServerSession()?.username;`
       (不带 `?? ''`)是这次收口的实体。旧取值式在账号名为空时把无标签盘一律判成自己的 ⇒ 整份敞开采纳。
       ⚠ 这条登记只盯**取值式**；那道 `if (!me) return;` 由 adopt-after-account-switch.test.ts 的用例守，
       MARKERS 读 HEAD 树字节 ⇒ 必须等本次改动提交后才可能绿。 */
    { task: '#154 采纳闸门的账号名口径不再兜底成空串', file: 'client/src/data/clientRepository.ts', text: 'const me = getServerSession()?.username;' },
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
    { guards: '#64 逐条点评存储契约', file: 'scope-notes.test.ts' },
    { guards: '#64 逐条点评详情 UI 与隐私边界', file: 'scope-notes-ui.test.tsx' },
    { guards: '本地批断规则引擎', file: 'local-analysis.test.ts' },
    { guards: '本地系统开关与存储', file: 'local-system.test.ts' },
    { guards: '本地系统设置入口', file: 'local-system-entry.test.tsx' },
    { guards: '本地系统设置界面契约', file: 'local-system-design.test.tsx' },
    { guards: '本地批断编排与结果来源', file: 'local-orchestration.test.ts' },
    { guards: '#129 语气默认档三处同源', file: 'tone-default-single-source.test.ts' },
    { guards: '#131 聊天缓存键跨端版本对齐', file: 'cache-key-cross-end.test.ts' },
    { guards: '#132 natal 键序三端同序', file: 'natal-key-order-cross-end.test.ts' },
  { guards: '#133 通道端点/模型/温度三端同源(Qwen 温度)', file: 'provider-spec-cross-end.test.ts' },
  { guards: '#134 凭据空白口径三端同源(桌面曾漏 trim)', file: 'credential-blank-caliber-cross-end.test.ts' },
  { guards: '#135 语气指令正文三端逐字节同源(浏览器曾缩写)', file: 'tone-text-cross-end.test.ts' },
  { guards: '本轮出生时刻、节气边界、起运、扫描与三合事实', file: 'chart-time-accuracy.test.ts' },
  { guards: '本轮出生时刻缓存签名跨端与SQLite往返', file: 'birth-time-cache-cross-end.test.ts' },
    /* #136 不是一份新判据文件，而是钉在既有聊天用例里的：askChat 通道分流那条「云端答了、
       但正文没过纯中文闸门 → 就地拦下报错，绝不静默改走本机通道」。登记整文件是为了让
       「删掉这一句」和「删掉整个文件」撞同一道闸门 —— 上一轮踩过的是后者无声通过。 */
    { guards: '#136 云端正文不合格不得静默绕本机直连', file: 'chat-engine.test.ts' },
    /* #137 的两条各进了既有文件(chat-engine 的「服务器报错且本机没配」措辞判据、
       provider-follow-contract 的通道顺序读点同源)，登记号沿用被改文件，不再单开条目。 */
    /* #138 是产品缺陷(ChartChat 迟到回包)，判据在 chart-chat.test.tsx 里新增两条用例；
       同类的 abort 竞态详情页早在缺陷 #114 就用 signalAbortedRef 修过，聊天区是漏掉的兄弟路径。 */
    { guards: '#138 已停止/已清空的问不得把迟到回包写进会话', file: 'chart-chat.test.tsx' },
    /* #142/#143 是桌面(Tauri)那两条本机通道的中止接线：任务支把 Rust 的 "cancelled" 读成普通失败批断、
       聊天支压根没读 signal。判据独立成一个文件，摘掉任何一句闸门这里立刻红。 */
    { guards: '#142/#143 桌面通道要接住「立即停止」', file: 'tauri-task-abort.test.ts' },
    /* #144 是跨端契约(服务器造的失败文本 → 客户端那唯一一道重试闸门)，判据两端各一份：
       客户端这份 import server/ai.mjs 读真实产物，服务器那份起真 HTTP 路由走整条链。只留一边
       就等于「另一端改了没人报」—— 这正是本缺陷能活到今天的成因。 */
    { guards: '#144 服务器的失败文本要喂得动重试闸门', file: 'retry-gate-server-text.test.ts' },
    /* #146 是**取证型**判据，不是修复：换设备删除在本机不生效(mergeRemoteRecords 只做「更新+追加」，
       没有第三条分支)。这条语义此前没有任何用例读过。变异验证：把 :788 那个 `!remoteIds.has` 翻成
       `remoteIds.has`(即改成「替换式合并」)，邻近的 unsynced-badge-ui + sync-admin-ghost 共 23 条照旧全绿，
       只有本文件红 —— 所以谁以后真要把合并语义改掉，必须过这份明说的读数，不能悄悄改。 */
    { guards: '#146 换设备删除在本机不生效(取证)', file: 'cross-device-delete-propagation.test.tsx' },
    /* #147 钉的是任务缓存键这一半的跨端契约(#131/#132 只覆盖了聊天键与 natal 序)。三个变异体实测：
       C1 删掉桌面 BaziRecord 的 camelCase 声明 → 只有 #147d 红；C2 服务端删除侧少拼时柱 → 只有 #147b 红；
       C3 桌面任务键把「性别/年柱」换位 → 只有 #147c 红，而**同文件那条老的结构判据照旧绿**(它只数 {} 个数)。
       另有一个 B2(服务端语气档改成向下取整)当场**存活**并查明是中性变异体：滑杆 step=5、两端都先取整，
       真实输入空间里三种写法逐点相同 ⇒ 不是缺陷，已如实记在这里而不是假装杀掉了它。 */
    { guards: '#147 任务缓存键的段序/签名派生/线上字节驼峰三处跨端契约', file: 'task-cache-key-cross-end.test.ts' },
    /* #148 一半是**修复**：闸门兜底句「没有可用的通道凭据，请先在设置里配置」旧读成可重试 ⇒
       对着一个根本没配密钥的通道连排两轮自动重试白烧钱(:350/:502 两条出口都发得这句)。
       另一半是**有意的口径登记**：429 限流判假不是缺陷 —— 并发池 fixedMapLimit(baziOrchestrator:137，
       冷却重发条件 :194)已用 isRateLimited 在 COOLDOWN_MS(:124)后就地重发一次，闸门不再让它进
       step 即时重试(:543)与补跑名单(:640)，否则同一条最多四口；
       代价(整轮限流时详情页 PersonDetail.tsx:557 不排期)如实钉在机制判据那条用例里，两侧不许各自改。
       三个变异体实测(jsdom 2026-10-09)：M1 删掉兜底句分支 → 红在【修复】那条；M3 改生产方 429 措辞
       (掺进 keyring 字样) → 红在前提钉子的两端同文本断言；**M2(把中文黑名单收窄成「四[零一二三]」，
       即放行 429)初稿四条断言全绿** —— 被改的字面量本身就是判据要读的串，拼接文本永远读到「改之前」的
       行为，补上直接碰 baziOrchestrator 源字节的钉子后才红在「黑名单整行」。
       「判据杀不掉自己针对的变异」是本轮最值钱的读数，写法教训已记进注释。 */
    { guards: '#148 闸门对两端真实产物的读数+兜底句修复+源字节钉子', file: 'retry-gate-real-texts.test.ts' },
    /* #150 是**非 AI 侧的新增读数**(大运顺排/逆排)，判据分两份、各守一段链路：
       · luck-direction-display —— 引擎真值(十干×两性别穷举，方向从首步运干支**反推**而不是另算一遍)
         + 文案与引擎同源 + 两端源字节钉子；
       · luck-direction-rendered —— 真实渲染 PersonDetail，钉这一行确实铺在「大运」小节里。
       变异实测(jsdom/node 2026-10-10)：M1 删掉 <p className="luck-direction"> → rendered 三条全红；
       M2 展示层把 `=== (gender === 'male')` 翻成 female → 两份共 5 条红；M3 整句硬编码成顺排 → 4 条红；
       ⚠ **M4(改的是引擎 fortuneDirection，界面不动)有一个重要读数**：那条「穷举比对文案 vs 引擎」的
       同源判据**照旧绿**(两边一起翻面当然还一致)，只有十条真值用例和源字节钉子红。所以这里必须留下
       源字节那一句 —— 结果型比对挡不住整体翻转，同类教训见 [[feedback-pin-assertion-on-formula-not-outcome]]。 */
    { guards: '#150 大运方向的引擎真值与文案同源(+源字节钉子)', file: 'luck-direction-display.test.ts' },
    { guards: '#150 大运方向必须渲染在详情页大运小节', file: 'luck-direction-rendered.test.tsx' },
    /* #151 是**可修改**功能，判据也分两份：
       · pillar-edit-recompute —— 引擎语义(改柱⇒日主/生肖/大运序列跟着变、三类非法输入各抛其错、
         birthDay 丢了公历日就漂一天)+ 源字节钉子(修正确实调 calculateNonAi、写库带 ...pillars)；
       · pillar-edit-rendered —— 真实点击「修正四柱」→ 改四栏 → 「保存修正」→ 读回「贰」的四柱/日主/五行、
         存储里的 nonAiResult、以及「壹」那张格不分叉。
       变异实测(jsdom/node 2026-10-10，四条全部被杀，还原后 md5 与基线一致)：
       M1 只写四柱不重算(nonAiResult 沿用旧值)→ 3 failed；M2 丢 birthDay → 2 failed；
       M3 保存后不走 refreshRecord 而就地塞视图 → 3 failed；M4 弹窗取消预填 → 4 failed。
       ⚠ 两条踩过的夹具坑已写进测试顶部：日柱不能孤立改(时柱受五鼠遁校验)、
       「贰」那张格渲染的是 fields.slice(1)，四柱只在 .chart-columns 的 dt=四柱里。 */
    { guards: '#151 修正四柱的引擎语义与源字节钉子', file: 'pillar-edit-recompute.test.ts' },
    { guards: '#151 修正四柱的真实交互路径(弹窗→保存→读回)', file: 'pillar-edit-rendered.test.tsx' },
    /* #152 声明文件自身的判据。⚠ 这里有一条**如实登记的存活变异**，别把它写成「四条全杀」：
       · M1 整份删掉声明文件 → 套件 import 失败(no tests) ⇒ 被杀；
       · M3 把声明里的 classifyFailure 改名 → 2 failed ⇒ 被杀；
       · M4 通配形改成整条 specifier 的 declare module → 1 failed ⇒ 被杀；
       · M5 把 ai.mjs 真实形参表改成单对象入参 → 2 failed ⇒ 被杀；
       · M6 声明里多写一个参数 → 1 failed ⇒ 被杀；
       · M2 把 cnCode 的返回类型 string 改成 number → **3 passed，两个闸门都没读数**。
         vitest 不查类型可以理解；限定这 6 个文件的 `npx tsc -p` 同样读到 0 错误 ——
         这不是判据失灵，是机制问题：对 tsc 来说 .d.ts 就是事实源，它没有实现可比。
         所以类型面无法自证，只能靠 M5/M6 那条「声明 vs 真实形参表」的字节比对兜住签名分叉；
         纯返回类型的漂移目前仍在无人区，要覆盖它得让判据去跑一次真实构建(成本另计)。 */
    { guards: '#152 server/ai.mjs 声明与真实导出同源(含参数个数)', file: 'server-ai-declaration.test.ts' },
    /* #153 语气滑杆的刻度与档位语义。电池 10 条**全杀**(2026-10-10，单文件 --pool=forks --maxWorkers=1，
       每条单独跑、跑完按 md5 回读 PersonDetail.tsx 与 baziOrchestrator.ts 均逐字一致)：
       · T1 `v <= 5`→`v <= 4` / T2 `v < 45`→`v < 46` / T3 `v <= 90`→`v <= 95` / T5 `v <= 55`→`v <= 56`
         → 各 1 failed(边界逐位点名)。这四条是本次的核心收获：旧判据只有 toneLabel(0)/(50)/(100) 三个点，
         离四条边界都远，**整体平移一档在 HEAD 上全绿存活**；补的是边界而不是第五套文案。
       · T4 `tone === DEFAULT_TONE`→`tone === 80` → 1 failed(字节钉子)。
       · T6 注释「语气档(0 犀利 .. 50 中立 .. 100 温柔夸夸)」改成「语气档(0..100)」→ 1 failed。
       · T7 整条删掉偏犀利分支 → 1 failed(反向钉子：证明解析式真在读五条分支，不是空表自洽)。
       · T8 aria-valuetext 改 String(tone) / T9 写死 toneLabel(80) → 各 1 failed，且**只有用例7 红**。
         这两条正是「断言必须碰被测组件」的现场：可见那句 `<span>` 完全不变，纯函数级判据(T1–T7 那几条)
         一条都不会红，只有真实渲染 + fireEvent.change 读组件发出的那个属性才抓得到。
       · T10 max={100}→max={50} → 3 failed(前提/可达档位/渲染三条同时红)。
       ⚠ 未覆盖处如实记下：滑杆 step=5 让 45/55 之外的中间值不可达，所以「非可达档位上的边界」
       (如 T2 的 45→46 只在直接调用 toneLabel 时可见)靠的是函数级穷举而非界面路径；界面那条只走可达档位。 */
    { guards: '#153 语气滑杆刻度、档位边界与无障碍文本同源', file: 'tone-slider-scale.test.tsx' },
    /* #154 「视图空着先采纳本机存储」(ensureViewLoaded) 的账号名口径。电池 5 条**全杀**
       (2026-10-10，adopt-after-account-switch + sync-admin-ghost 两文件，--pool=forks --maxWorkers=1，
       基线冒烟闸门读到 0 failed/22 passed 才开跑；跑完按 cmp 回读 clientRepository.ts 逐字一致)：
       · U1 只删 `if (!me) return;`(保留旧取值式) / U2 整段改回旧实现(删门 + `?? ''`)
         / U3 门改成「有 token 才放行」 → 各 2 failed(前提钉子 + 如实登记那条)。
       · U4 mineOnDevice 恒真 → 1 failed，红的是 sync-admin-ghost「待推送名单里的『别人的盘』不会被补推到服务器」，
         **不是本文件的反向钉子** —— 这条要如实说明：本文件对「无标签一律算自己的」这种宽松判据本身没有独立杀伤力，
         它靠的是既有那份跨账号用例。
       · U5 ensureViewLoaded 不再赋值视图 → 4 failed。
       ⚠ 两处必须跟着这段一起读的诚实账：
       ① **这是一处防御性收紧，不是已复现的线上缺陷**。null 会话走不到那道门(isServerMode() 为假时
          pullAndMergeLocal:693 在门口就 return)，而 server/app.mjs:61 把注册用户名限成 2–24 位、
          SettingsPage.tsx:177/189 直抄服务器回的 username ⇒ 当前两端都造不出空账号名。
       ② **第一版夹具是空转的**：用 setServerSession(null) 时「删掉整道门」仍 4 passed，
          我据此差点把它报成「修复无效」。A/B(username 取空串的会话 vs null 会话)才分辨出是夹具不可达。
       ③ 换账号那两条是**当前读数登记**而非期望：storageBackedBaziRepository 的写入侧不按账号分键
          (saveBaziRecord 用固定 storageKey，只有 saveView 分流到 namespacePrefix+owner)，
          所以换账号后上一账号的无标签盘仍会整份进新账号视图；账号名为空那一轮则把本机存储整体覆盖成
          只剩新建那条(旧盘从这台设备的存储里消失)。真要改语义得先把这两条改写成新语义并交代
          「本机自建、从没带过标签的盘为什么不会被抹掉」。 */
    { guards: '#154 采纳闸门的账号名口径(含换账号/空账号名两条当前读数)', file: 'adopt-after-account-switch.test.ts' },
    /* #139 的判据在服务器侧(server/test/chat-abort.test.mjs，node --test)，不是 vitest 用例文件，
       所以不能进上面那张表(表的 file 会拼进 client/src/__tests__/，且反向钉子要求 .test.ts(x))。
       丢在这里钉：客户端「停止」发的是真 AbortSignal(chatEngine 把 controller.signal 交给 fetch)，
       一旦有人把它摘掉，服务器就再也收不到断连 —— #139 那套判据会照样全绿却守不住东西。 */
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

  it('#139/#140 的服务器判据必须在 HEAD 树里(它们不是 vitest 用例，不能进 CRITERIA 那张表)', () => {
    /* 上面那张表的 file 会拼进 client/src/__tests__/，反向钉子又要求 .test.ts(x) 结尾，
       所以 server/test/*.mjs 一律登记不进去 —— 但不登记就等于「闸门跟着功能一起消失」没人报。
       ⚠ trackedPaths() 只列 HEAD 树，新文件在 git add 之前这条必红(踩过：先跑测后提交)。
       这一句单独钉 server 侧那两份：删掉文件、改名、或把它们挪出 test/ 都会红。 */
    expect([...trackedPaths()]).toContain('server/test/chat-abort.test.mjs');
    /* #140 是 #139 同一类缺陷的兄弟路径（批断任务路由），客户端早就发真 signal，
       服务器那侧却既不 abort 上游也不拦缓存。判据独立成一个文件，摘掉它同样没人报。 */
    expect([...trackedPaths()]).toContain('server/test/task-abort.test.mjs');
    /* #144 的服务器半边(真 HTTP 路由 → 回执文本 → 闸门)同样不是 vitest 用例，得单独钉。 */
    expect([...trackedPaths()]).toContain('server/test/retry-gate-unconfigured.test.mjs');
  });

  it('判据账本非空(掏空它就等于把所有闸门一次性摘掉)', () => {
    expect(CRITERIA.length, '判据账本被掏空了').toBeGreaterThanOrEqual(10);
  });

/* ============================================================================
   历史恢复义务 —— 保留三条原始 GAPS 身份，证明已完成账目与核心行为判据同时进入 HEAD。

   1) 不许删这一行。删掉等于又一次静默丢失：#64 当初就是这么消失的 —— 界面上少一个按钮，
      测试却全绿，因为被测的文件压根不存在(实测：把整项摘掉后其余 13 条照旧全绿)。
   2) 不许改成 xit / it.skip。跳过不参与构建，等于自己把闸门拆了。
   三条原始任务、claimedDone 与路径必须保留；每条都需在 DELIVERED、HEAD 与 CRITERIA/HEAD 正向闭合。
   ========================================================================== */
const GAPS: Array<{ task: string; claimedDone: boolean; code: string; file: string; criteria: string[] }> = [
  { task: '#64', claimedDone: true, code: 'scopeNotes.ts', file: 'client/src/data/scopeNotes.ts', criteria: ['scope-notes.test.ts', 'scope-notes-ui.test.tsx'] },
  /* 「本地系统 / 第四路离线批断」整块都不在当前分支上：#49-58、#67、#70、#72-74、#77 全标着已完成，
     #77 甚至还挂着 in_progress。实测取证(不是推断)：
       · HEAD 的 client/src/data/aiSettings.ts 里没有 OFFLINE_STORAGE_KEY / isOfflineMode ——
         而 lost-scope-notes 那份的第 79-84 行就有它们；
       · HEAD 的 types/domain.ts 里 BaziTaskResult 没有 source?: 'cloud' | 'local'(第 137 行整行缺失)，
         lost-scope-notes 那份有，注释还写着「界面对本地结果打绿点标注」；
       · HEAD 与工作副本都搜不到 localAnalysis.ts / localSystem.ts 这两个文件名。
     所以这不是「某个文件没提交」，而是**一次回退把整条链从指针上摘掉了**，连带它的判据一起。 */
  { task: '#49-52/#67/#70/#72-74', claimedDone: true, code: 'localAnalysis.ts', file: 'client/src/data/localAnalysis.ts', criteria: ['local-analysis.test.ts', 'local-orchestration.test.ts'] },
  { task: '#49/#77', claimedDone: true, code: 'localSystem.ts', file: 'client/src/data/localSystem.ts', criteria: ['local-system.test.ts', 'local-system-entry.test.tsx', 'local-system-design.test.tsx'] },
];

describe('历史功能恢复义务：实现与行为判据均在 HEAD', () => {
  it.each(GAPS)('任务 $task 的实现 $code 与核心判据在 HEAD 闭合', ({ task, claimedDone, file, criteria }) => {
    /* claimedDone 不是装饰：它把「任务清单上的标记」变成判据的输入。
       若有人为了消掉红灯把 claimedDone 改成 false(谎称任务没做完)，这句会立刻红，
       逼他同时去改任务清单 —— 两处不一致就过不了构建。 */
    expect(claimedDone, `任务 ${task} 已不再标称完成，请把这条缺口登记整项撤掉`).toBe(true);
    expect(DELIVERED.map((entry) => entry.file), `${file} 未登记在 DELIVERED`).toContain(file);
    expect([...trackedPaths()], `HEAD 树里没有 ${file}`).toContain(file);
    for (const testFile of criteria) {
      expect(CRITERIA.map((entry) => entry.file), `${testFile} 未登记在 CRITERIA`).toContain(testFile);
      expect([...trackedPaths()], `HEAD 树里没有核心判据 ${testFile}`).toContain(`client/src/__tests__/${testFile}`);
    }
  });

  it('历史义务表三条均保持正向闭合', () => {
    for (const gap of GAPS) {
      expect(DELIVERED.some((entry) => entry.file === gap.file), `${gap.file} 未登记在 DELIVERED`).toBe(true);
      expect([...trackedPaths()], `${gap.file} 不在 HEAD`).toContain(gap.file);
      for (const testFile of gap.criteria) {
        expect(CRITERIA.some((entry) => entry.file === testFile), `${testFile} 未登记在 CRITERIA`).toBe(true);
        expect([...trackedPaths()], `${testFile} 不在 HEAD`).toContain(`client/src/__tests__/${testFile}`);
      }
    }
  });
});
});
