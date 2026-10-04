/* =============================================================================
 * wiki 相对链接可达性扫描器
 *
 * 为什么存在：docs/wiki/*.md 里每条 `[文字](../../path)` 都指向真实源码文件，
 * 重构改名后这些链接会静默失效，而 README 与任务记录曾声称「已校验全部相对链接可达」——
 * 实测仓内没有任何判据脚本做这件事(grep "wiki" 于 client/src/__tests__、scripts、server/test 全空)。
 * 没有可执行判据的承诺等于没承诺，故补此扫描器 + vitest 用例。
 *
 * 判据口径(有意保守)：只断言**目标路径存在**。锚点(#缓存键 之类)不校验，因为
 * markdown 锚点由渲染器现算，钉它会因标题措辞变动产生假红，得不偿失。
 *
 * 输出协议(供测试解析，勿改字样)：
 *   OK <文件数> <链接总数> <坏链数>
 *   BAD <md文件>:<行号> <原始链接>
 * 退出码：0 全绿；1 有坏链；2 环境类故障(目录缺失/一条 md 都没扫到)，避免空扫描伪装成通过。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const WIKI_DIR = path.join(repo, 'docs', 'wiki');

/* Markdown 链接语法是 `](target)`，不是裸 `(target)`：后者会把正文里的中文括注
   「（见 (./x.md)）」也算进去，制造误报。只认 `](` 前缀。 */
const LINK_RE = /\]\((\.\.?\/[^)#\s]+)(#[^)]*)?\)/g;

function main() {
  if (!fs.existsSync(WIKI_DIR)) {
    console.log('ERR docs/wiki 不存在: ' + WIKI_DIR);
    return 2;
  }
  const mdFiles = fs.readdirSync(WIKI_DIR).filter((f) => f.endsWith('.md')).sort();
  /* 非空自证：扫不到文件就报 0 坏链，是一条永真的空判据。宁可当环境故障红掉。 */
  if (mdFiles.length === 0) {
    console.log('ERR docs/wiki 下没有 .md 文件，扫描面为空');
    return 2;
  }

  let total = 0;
  const bad = [];
  for (const f of mdFiles) {
    const text = fs.readFileSync(path.join(WIKI_DIR, f), 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      LINK_RE.lastIndex = 0;
      let m;
      while ((m = LINK_RE.exec(line))) {
        total += 1;
        const rel = m[1];
        const target = path.resolve(WIKI_DIR, path.normalize(rel));
        if (!fs.existsSync(target)) bad.push({ file: f, line: i + 1, rel });
      }
    });
  }

  /* 曾加过一条「散文里出现 ]( … ) 省略号路径」的 PREFLIGHT 闸门，实测后删除：
     `path.normalize` 会把 `…` 当普通目录名，任何含省略号的路径都必然解析不到真实文件
     (逐一验过 ../../scripts/…/x、../../…/scripts/x、../../scripts/.…/x 等五种写法，全部 false)，
     ⇒ BAD 恒会先抓到它，PREFLIGHT 是**冗余判据**。按「删掉应红才算必要」的纪律不保留摆设。
     散文若真用链接语法讲路径，红的是 BAD —— 同样能拦，只是归因不同。 */
  for (const b of bad) console.log(`BAD ${b.file}:${b.line} ${b.rel}`);
  console.log(`OK ${mdFiles.length} ${total} ${bad.length}`);
  return bad.length > 0 ? 1 : 0;
}

process.exit(main());
