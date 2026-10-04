/** 版本号链路判据：scripts/version.sh ↔ client/vite.config.ts ↔ buildInfo ↔ 设置页
 *
 * 为什么本文件里所有「动态正则」都要特殊构造（实测教训，改动前请先读）：
 *   在本机 Qoder 的写文件通道里，字符串字面量中的反斜杠会被静默吞掉一层甚至整层，
 *   于是 new RegExp 收到的模式可能悄悄变成行首锚，对目标串恒不命中；
 *   而**同样内容的正则字面量**不受影响。两种失效都是静默失配(split 只剩一段、
 *   模式永不命中)，测试看起来像「通过」。
 *   对策：① 能用正则字面量就用字面量；② 必须动态拼时，转义一律取自 String.fromCharCode(92)；
 *   ③ 每条动态模式都配一条「必须命中 N 次/段」的落地自证判据，红在当场而不是悄悄通过。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cnVersion } from '../utils/buildInfo';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../') + '/';
const read = (p: string) => readFileSync(root + p, 'utf8').replace(/\r\n/g, '\n');

/** 从源码里抠出某个声明对应的**字面量原文**(含定界符)。取不到直接抛错，绝不返回 undefined。 */
function rawLiteral(src: string, decl: RegExp): string {
  const m = decl.exec(src);
  if (!m) throw new Error('找不到声明：' + decl.source);
  return m[1];
}

const BS = String.fromCharCode(92);                 // 反斜杠：全文件唯一的「手写转义」来源

/** 匹配 vite.config 模板里的 `${git([…])}` 取值位，捕获组是参数串原文。
 *  片段全部由字符码 BS 提供；类内「非右方括号」要写成 [^ + BS + ']]* ——
 *  转义右括号后紧跟一个裸右括号收尾才等价于字面量写法，只写 [^ + BS + '] 会让类不闭合。 */
function gitCallRe(): RegExp {
  const parts = [BS + '$', '{git', BS + '(', BS + '[', '([^' + BS + ']]*', ')', BS + ']', BS + ')', '}'];
  return new RegExp(parts.join(''));
}

describe('版本号链路(version.sh ↔ vite.config ↔ buildInfo ↔ 设置页)', () => {
  /* 两端各自 exec 一次 git 再拼串，注释里写着「与 scripts/version.sh 的快照名同源」。
     这句承诺此前没有任何判据：任一端改格式(加前缀、换分隔符、调顺序)，快照名就对不上 UI 读数，
     照着界面上的版本号去 `version.sh restore` 会找不到文件。这里用同一份真实提交跑两端比对，
     而不是比字面量 —— 比字面量只能证明「两处写法像」，跑一次才能证明「结果相同」。 */
  it('version.sh 与 vite.config 对同一次提交产出同一个版本号', () => {
    const cfgSrc = read('client/vite.config.ts');
    // 前提自证：配置里那一条 git 助手被调了两次(序号 + 短哈希)，否则下面的拼装是在测我自己写的表达式
    expect(cfgSrc.match(/execFileSync\('git'/g)?.length ?? 0).toBe(1);
    const calls = [...cfgSrc.matchAll(/git\(\[([^\]]*)\]\)/g)].map((m) => m[1]);
    expect(calls.length, 'vite.config 里取 git 值的调用不是两处').toBe(2);
    const argsOf = (t: string) => t.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, ''));
    expect(argsOf(calls[0])).toEqual(['rev-list', '--count', 'HEAD']);
    expect(argsOf(calls[1])).toEqual(['rev-parse', '--short', 'HEAD']);
    const joined = rawLiteral(cfgSrc, /return\s*(`[^`]*`)/);
    // 前提自证：抠到的必须是带反引号的模板本身(两端各留一个 ${git(…) })
    expect(joined.startsWith('`') && joined.endsWith('`'), '没取到模板串：' + joined).toBe(true);
    expect(joined.match(/\$\{git\(/g)?.length ?? 0).toBe(2);

    // 动态模式的落地自证：先在真模板上确认能切出 5 段(2 个取值位 + 3 段固定文本)。
    // 少了这一步，模式静默失配时 parts 只有 1 段，后面的相等比对会拿「模板原文」当结果蒙过去。
    const body = joined.slice(1, -1);
    expect(body.split(gitCallRe()).length, 'gitCallRe() 没在模板上命中 2 处').toBe(5);

    // 把模板里的两处 git 取值按「取的是哪个子命令」替换成实际值，再求值 —— 测的是配置那行拼装式本身。
    const runVite = (count: string, short: string): string => {
      const parts = body.split(gitCallRe());
      const vals = parts.map((p, i) => (i % 2 === 1 ? (argsOf(p)[0] === 'rev-list' ? count : short) : p));
      return vals.join('');
    };
    // 反向钉子：拼装式必须真的用到两个取值(写成常量、或只留一个，这一步就拦下)
    expect(runVite('7', 'abc1234')).toBe('7-abc1234');

    /* version.sh 那份：current_version 的 echo 模板 + bare_version 剥掉的前缀。
       这里不写死「build-」(那等于把格式抄进测试当第二份实现)，从脚本自己读出来。
       注意别处还有 echo "(无)" 之类的文案和好几处 sed，所以模板行只认「同时含序号与哈希的那条 echo」，
       sed 则按语义挑(见下)而不是按位置取第一条 —— 上一版取到的是 's|$SNAP_DIR/||'，
       于是「剥前缀」实际剥成了删斜杠，V2(给快照名再加一层前缀)当场存活。 */
    const sh = read('scripts/version.sh');
    expect(sh.match(/rev-list --count HEAD/g)?.length ?? 0, 'version.sh 不再取 rev-list 序号').toBeGreaterThanOrEqual(1);
    expect(sh.match(/rev-parse --short HEAD/g)?.length ?? 0, 'version.sh 不再取 rev-parse 短哈希').toBeGreaterThanOrEqual(1);
    const bareLine = sh.split('\n').map((l) => l.trim()).find((l) => l.startsWith('bare_version()'));
    if (!bareLine) throw new Error('找不到 bare_version 的定义行');
    const tmplLine = sh.split('\n').map((l) => l.trim()).find((l) => /^echo\s*"/.test(l) && l.includes('$n') && l.includes('$sha'));
    if (!tmplLine) throw new Error('找不到含序号与哈希的 echo 模板行');
    const tmpl = rawLiteral(tmplLine, /echo\s*"([^"]*)"/);
    expect(tmpl.includes('$n') && tmpl.includes('$sha'), 'current_version 的 echo 模板没同时含序号与哈希：' + tmpl).toBe(true);

    /* sed 表达式不是带引号的字面量(引号就是它的定界符)，取原文再自己拆。
       脚本里有多处 sed(list 去目录、给每行加缩进…)，判据按语义挑：必须**恰好一条**sed 把模板串
       剥成界面读数那一串 —— 取第一条会栽在 's|$SNAP_DIR/||'，写死 bare_version 那行则改个函数名就假红，
       命中数同时钉住「只有一条能对上」。
       拆分规则：s + 分隔符 + 模式 + 分隔符 + 替换值(+ 可选标志) —— 是三个分隔符，不是两个。
       上一版把「第二个分隔符之后到结尾」整段当替换值，'s/^build-//' 就读出 '/'，
       剥前缀变成塞斜杠(实测红在拼接判据上)。也不能用贪婪匹配或 lastIndexOf。 */
    const seds: string[] = [...sh.matchAll(/sed\s+'([^']*)'/g)].map((m) => m[1]);
    const parseSed = (expr: string): { pat: string; rep: string } | null => {
      if (!/^s(.)/.test(expr)) return null;
      const d = expr[1];
      const end = expr.indexOf(d, 2);
      if (end < 0) return null;
      const after = expr.slice(end + 1);
      const next = after.indexOf(d);
      if (next < 0) return null;
      return { pat: expr.slice(2, end), rep: after.slice(0, next) };
    };
    const anchored = tmpl.replace(/\$n/g, '7').replace(/\$sha/g, 'abc1234');
    // sed 的两种锚定语义用字符串运算复现(不经 new RegExp —— 本环境动态拼的转义会在解析层静默失效)
    const applySed = (parsed: { pat: string; rep: string }, s: string): string => {
      if (parsed.pat.startsWith('^')) {
        const body = parsed.pat.slice(1);
        return s.startsWith(body) ? parsed.rep + s.slice(body.length) : s;
      }
      return s.split(parsed.pat).join(parsed.rep);
    };
    const stripping = seds.map(parseSed).filter((p): p is { pat: string; rep: string } => p !== null)
      .filter((p) => applySed(p, anchored) === runVite('7', 'abc1234'));
    expect(stripping.length, 'version.sh 里没有一条 sed 能把版本号剥成界面读数(共读到 ' + seds.length + ' 条表达式)').toBe(1);
    const runSh = (count: string, short: string): string =>
      applySed(stripping[0], tmpl.replace(/\$n/g, count).replace(/\$sha/g, short));
    // 反向钉子：剥前缀必须真的剥掉了东西(而不是原样返回或整串替空)
    expect(runSh('7', 'abc1234')).not.toMatch(/^build-/);
    expect(runSh('7', 'abc1234')).not.toBe('');

    /* 快照名里那一段必须是「裸版本号」(口径：UI 显示什么就照着敲 restore)。
       只比「两端相等」杀不掉这一类改动，实测 V2(把 sed 的替换值从空改成 'v')就是这样存活的：
       脚本内部仍自洽，只是文件名多了一层前缀。所以判据分两步钉在**消费端**：
       ① 文件名 = 前缀 + 版本号段 + 后缀，且版本号段逐字等于 bare_version 的输出；
       ② bare_version 的输出又必须逐字等于 vite 端(UI)那一串 —— 两条合起来才杀得掉 V2。 */
    const save = rawLiteral(sh, /file="\$SNAP_DIR\/([^"]*)"/);
    // 名字不写死：按出现顺序读全文件名里的变量引用(stamp/ver/safe_note)，逐个追赋值行，
    // 认「哪个变量的来源是 bare_version」，而不是认死变量名。
    // 用字面量正则(不用 new RegExp 拼转义)：本环境里动态拼出的 \(...\) 类模式会被引擎判成 Unmatched ')'，实测过。
    const refRe = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
    const names: string[] = [];
    for (const m of save.matchAll(refRe)) if (!names.includes(m[1])) names.push(m[1]);
    expect(names.length, '文件名里读不出变量引用：' + save).toBeGreaterThan(0);
    const assignOf = (n: string) => sh.split('\n').map((l) => l.trim()).find((l) => l.startsWith(n + '='));
    const verNames = names.filter((n) => String(assignOf(n)) === n + '="$(bare_version)"');
    expect(verNames.length, '文件名里没有由 bare_version 赋来的变量(或该赋值行被改写)：' + save).toBe(1);
    const usedVar = verNames[0];
    const varRef = '$' + usedVar;
    // 落地自证：文件名里必须恰好出现一次该变量引用(split 不命中只会给 1 段，看不出异常)
    expect(save.split(varRef).length - 1, '文件名里 ' + varRef + ' 的出现次数不是 1：' + save).toBe(1);
    const segs = save.split(varRef);
    // 其它占位符换成哨兵，钉住「版本号独占一段、前后没有多余前缀」。
    // 替换一律走 split/join：String.replace 的替换串里 $ 是特殊序列，直接塞 '$stamp' 会替换成捕获组。
    const norm = (t: string) => t.split('${' + usedVar + '}').join(runSh('7', 'abc1234')).split(varRef).join(runSh('7', 'abc1234'))
      .split('$' + 'stamp').join('#').split('${stamp}').join('#')
      .split('$' + 'safe_note').join('@').split('${safe_note}').join('@');
    const [head, tail] = segs.map(norm);
    expect([head, tail], '快照名的前后缀变了(版本号段必须独占一段)：' + save).toEqual(['#-', '-@.tar.gz']);
    // ① 整名逐字等于「前缀 + bare_version 的输出 + 后缀」(把 norm 里的变量引用换成 runSh 的结果再比)
    expect(head + runSh('7', 'abc1234') + tail, '快照名拼出来不是「前缀+版本号段+后缀」：' + save)
      .toBe(norm(save));
    // ② 而那一串又逐字等于界面读数(照着它敲 restore)；整名不许残留 build-
    expect(runSh('7', 'abc1234'), '快照名里的版本号段必须逐字等于 UI 上那一串(照着它敲 restore)').toBe(runVite('7', 'abc1234'));
    expect(head + runSh('7', 'abc1234') + tail).not.toMatch(/build/);

    // 边界形态比对：序号一位/两位/三位时两端必须给出同一串。
    // 这里不写死期望值(那等于把「格式」抄进测试当第二份实现)，只钉「两端相等」。
    for (const [c, s] of [['1', 'abc1234'], ['24', 'a38f10d'], ['107', 'deadbee']] as const) {
      expect([c, runSh(c, s), runVite(c, s)]).toEqual([c, runVite(c, s), runVite(c, s)]);
    }
  });

  it('vite 注入的 git 号形状与 cnVersion 认得的形状一致', () => {
    const cfg = read('client/vite.config.ts');
    // 定义处必须是 JSON.stringify(GIT_VERSION)，改成裸变量会让注入值变成标识符而不是串
    expect(cfg).toMatch(/__GIT_VERSION__:\s*JSON\.stringify\(GIT_VERSION\)/);

    // 解析规则取自产品源码(buildInfo.ts)里那条正则原文，不在测试里重抄一遍
    const src = read('client/src/utils/buildInfo.ts');
    const lit = rawLiteral(src, /(\/[^\n]+\/[a-z]*)\.exec/);
    const between = /^\/(.+)\/([a-z]*)$/.exec(lit);
    if (!between) throw new Error('cnVersion 的正则字面量形状变了：' + lit);
    const re = new RegExp(between[1], between[2]);
    // 落地自证：这条正则确实认得「序号-短哈希」，并拒绝变形
    expect(re.test('24-a38f10d'), '产品解析式不认 24-a38f10d').toBe(true);
    expect(re.test('24_a38f10d'), '产品解析式不该认下划线分隔').toBe(false);
    expect(cnVersion('24-a38f10d')).toMatch(/^第/);
    expect(cnVersion('a38f10d'), '只有哈希没有序号时应回退原样').toBe('a38f10d');
  });

  it('构建产物里的版本号经产品读法上屏后不含拉丁字母与数字', () => {
    let html = '';
    try {
      html = read('client/dist/index.html');
    } catch {
      return; // 尚未构建：如实跳过，不用假数据凑绿
    }
    // 入口脚本在 index.html 里是相对路径(./assets/index-xxxx.js)
    const entrySrc = /<script[^>]*src="([^"]+\.js)"/.exec(html)?.[1];
    expect(entrySrc, 'dist/index.html 里找不到入口 bundle').toBeTruthy();
    const entry = String(entrySrc).startsWith('./') ? String(entrySrc).slice(2) : String(entrySrc);
    const code = read('client/dist/' + entry);
    const ver = /(\d+-[0-9a-f]{7,})/.exec(code)?.[1];
    expect(ver, '产物里没有注入的 git 版本号').toBeTruthy();
    const shown = cnVersion(ver as string);
    expect(shown, '版本号上屏仍含拉丁字母或数字：' + shown).not.toMatch(/[A-Za-z0-9]/);
    expect(shown.startsWith('第')).toBe(true);
  });
});
