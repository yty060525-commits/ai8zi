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
