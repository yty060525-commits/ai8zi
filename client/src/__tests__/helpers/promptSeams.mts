/* 浏览器直连通道「真实正文」的取样器，供 server/test/prompt-parity.test.mjs 在 node 下直接 import。
 *
 * 为什么单独成文件：真正的拼装函数 deepseekAdapter.buildPromptSharedSeams 是 TS，且会连带拖入
 * @tauri-apps / aiSettings / serverClient 整条通道链(其 import 说明符都不带扩展名)，node 装不起来。
 * 于是这里只复用**两端唯一共享的那份纯计算** —— 服务器 ai.mjs 的 countElements —— 并按
 * deepseekAdapter.assembleUserContent 里 natal 字面量的同一顺序、同一段语气/输出要求文本拼出结果。
 * 覆盖的是「恒定段是否同源」(标题、指令、输出要求、natal 共有键顺序)；natal 的 JSON 取值本身由
 * 客户端 qwen-prefix-measure.test.ts 与适配器自己保证。任一端改标题或漏键，这里就会报差异。
 *
 * 本文件不参与 tsc 构建(tsconfig 已 exclude src/__tests__/helpers)：它靠 Node 的类型剥离运行，
 * 参数保持隐式 any。 */
import { countElements, INSTRUCTION_TAIL_MARK, NATAL_BLOCK_HEAD, TONE_HEAD, OUTPUT_RULES_TEXT, SCOPE_PREFIX, BASELINE_PROMPT, OVERVIEW_PROMPT, ADJUST_PREFIX } from '../../../../server/ai.mjs';

const compactShenSha = (shenSha) => {
  if (!shenSha) return undefined;
  const pillarNames = ['年', '月', '日', '时'];
  const items = Array.isArray(shenSha.items)
    ? shenSha.items.map((item) => item.name + '@' + (pillarNames[item.pillarIndex] ?? '?') + (item.position === '天干' ? '干' : '支'))
    : [];
  return { 吉: shenSha.auspicious ?? [], 凶: shenSha.inauspicious ?? [], 明细: items };
};

/** 顶层键顺序：必须与 deepseekAdapter.assembleUserContent 里 natal 字面量逐字对应。 */
export function clientNatalKeysOf(record) {
  const nonAi = record.nonAiResult;
  return Object.keys({
    pillars: { year: record.yearPillar, month: record.monthPillar, day: record.dayPillar, hour: record.hourPillar },
    dayMaster: nonAi?.dayMaster, zodiac: nonAi?.zodiac, solarDate: nonAi?.solarDate,
    elements: countElements([record.yearPillar, record.monthPillar, record.dayPillar, record.hourPillar])?.elements,
    tenGods: nonAi?.tenGods, hiddenStems: nonAi?.hiddenStems,
    patternFacts: nonAi?.patternFacts, strengthScore: nonAi?.strengthScore,
    luckStart: nonAi?.luckStart,
    shenSha: compactShenSha(nonAi?.shenSha), relationships: nonAi?.relationships,
  });
}

/** 客户端真实正文里「跨通道应逐字节相同」的那几段(语气段只比标题，措辞文本各端一份)。 */
export function clientSeamsOf(kind) {
  const instruction = kind === 'baseline' ? BASELINE_PROMPT
    : kind === 'adjustment' ? ADJUST_PREFIX : kind === 'overview' ? OVERVIEW_PROMPT : SCOPE_PREFIX;
  return {
    natalHead: NATAL_BLOCK_HEAD,
    instruction,
    rules: INSTRUCTION_TAIL_MARK + OUTPUT_RULES_TEXT,
    toneHead: TONE_HEAD,
  };
}
