import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toneInstructionText } from '../data/deepseekAdapter';
import { DEFAULT_TONE } from '../data/baziOrchestrator';

/* 语气默认档的跨端同源判据(#129)。
   背景：`DEFAULT_TONE = 80` 是**唯一有测试的**一处(tone.test.ts 钉了它)，而真正决定提示词里
   「语气」那一段的两个兜底表达式各自硬编码字面量 80 —— 把 DEFAULT_TONE 改成 60，界面滑杆的
   「这是默认档」标注(PersonDetail 里 `tone === 80`)与文案会变，模型收到的语气要求却一个字不变。
   §41 同一类缺陷(默认 provider 散在 5 处)已经烧过一次，这次趁只有三处先钉住。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('语气默认档跨端同源(#129)', () => {
  const sites = [
    ['../data/baziOrchestrator.ts', /export const DEFAULT_TONE = (\d+);/],
    ['../data/deepseekAdapter.ts', /Math\.max\(0, Math\.min\(100, Math\.round\(Number\(tone\)\)\)\) : (\d+);/],
    ['../data/chatEngine.ts', /Math\.max\(0, Math\.min\(100, Math\.round\(Number\(input\.tone\)\)\)\) : (\d+);/],
    /* 另两端也是同一个数字，只是写法不同：服务器 ai.mjs 有具名常量，桌面 Rust 写在 clamp_tone 的
       None 分支里(整条 match 挤在一行，所以按「None => 数字」取而不是按整行匹配)。
       ⚠ 路径基准是**本测试文件所在目录**(client/src/__tests__/)，不是仓库根 —— server/ai.mjs 要写
       '../../../server/ai.mjs'，lib.rs 要写 '../../src-tauri/src/lib.rs'(少一级会拼成 src/src-tauri，
       实测 ENOENT)。这条链与 §41「默认通道散在五处」同源，只是那处已有 provider-follow-contract 守着。 */
    ['../../../server/ai.mjs', /export const DEFAULT_TONE = (\d+);/],
    ['../../src-tauri/src/lib.rs', /match tone \{ Some\(n\) => n\.clamp\(0, 100\), None => (\d+) \}/],
  ] as const;

  it('五端兜底都存在且读数相同(判据不能悄悄跑在缺文件的树上)', () => {
    /* 正向钉子：先把「每处都能匹配到一次」钉死。正则没命中不是「读数为空」而是工具失效，
       必须先自证能打响再谈比对。 */
    const readings: Array<[string, string]> = [];
    for (const [file, re] of sites) {
      const text = src(file);
      const hits = [...text.matchAll(new RegExp(re.source, 'g'))];
      expect(hits.length, `${file} 里的语气兜底匹配到 ${hits.length} 次 ⇒ 写法变了或整块没了`).toBe(1);
      readings.push([file, hits[0][1]]);
    }
    for (const [file, value] of readings) {
      expect(Number(value), `${file} 的默认语气档与 DEFAULT_TONE 分叉`).toBe(DEFAULT_TONE);
    }
  });

  it('兜底分支今天走不到(UI 恒传数字)，所以只能靠源码比对来钉', () => {
    /* 这一条交代上面那条为什么必须是字节比对而不是行为断言：把 undefined 喂进去，
       两处兜底都会给出「温和优先」，但这条路径在真实调用链上不可达(ChartChat 传 recordTone()、
       PersonDetail 传 toneRef.current，都是 number)。留着它是为了将来有人放开类型时不静默漂移。 */
    expect(toneInstructionText(undefined)).toBe(toneInstructionText(DEFAULT_TONE));
    expect(toneInstructionText(undefined)).toContain('温和优先');
  });

  it('DEFAULT_TONE 的行尾注释讲的是语气，不是重试间隔(注释错贴会让改值的人失去警告)', () => {
    /* 【实测缺陷 #129 的第二半】baziOrchestrator.ts 里 `export const DEFAULT_TONE = 80;` 后面
       跟的是「检测到失败后尽快重发(太短易被限流，900ms 合适)」—— 那是上一行 DEFAULT_RETRY_DELAY_MS
       的说明，因为两次编辑挤在同一列被粘到了这一行。后果：删掉这句注释的人不会红任何用例
       (MUT-T1 实测存活)，而下一个读到它的人会以为这个常量控制重试节奏。 */
    const lines = src('../data/baziOrchestrator.ts').split('\n');
    const decl = lines.filter((l) => /^export const DEFAULT_TONE = \d+;/.test(l));
    expect(decl.length, 'DEFAULT_TONE 的声明行匹配异常').toBe(1);
    const tail = decl[0].slice(decl[0].indexOf(';') + 1);
    expect(tail, 'DEFAULT_TONE 行尾没有注释 ⇒ 语义只活在文档里').not.toBe('');
    expect(tail).not.toMatch(/900|重试|限流|重发/, '行尾注释在讲重试 ⇒ 会把改值的人引向错误的常量语义');
    expect(tail).toMatch(/语气|档/, '行尾注释没提语气');
  });

  it('重试间隔的注释留在重试间隔那一行上(防止两行注释再次互换)', () => {
    const lines = src('../data/baziOrchestrator.ts').split('\n');
    const retry = lines.filter((l) => /^const DEFAULT_RETRY_DELAY_MS = \d+;/.test(l));
    expect(retry.length, 'DEFAULT_RETRY_DELAY_MS 声明行匹配异常').toBe(1);
    const idx = lines.indexOf(retry[0]);
    /* 上一行的注释若写着「语气」，就是本次错贴的另一半现场。 */
    const prev = lines[idx - 1]?.trim() ?? '';
    if (/^\*?\s*\/?\*?\s*[\u4e00-\u9fff(]/.test(prev) || prev.startsWith('//')) {
      expect(prev, '重试间隔上方的注释在讲语气 ⇒ 两条注释又互换了').not.toMatch(/语气/);
    }
  });
});
