import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import './netGuard.mjs'; // 上闸：本用例只拼装文本，绝不该发请求
import { buildTaskPayload, natalFactsOf, INSTRUCTION_TAIL_MARK, NATAL_BLOCK_HEAD, TONE_HEAD, OUTPUT_RULES_TEXT, SCOPE_PREFIX, BASELINE_PROMPT, OVERVIEW_PROMPT, ADJUST_PREFIX } from '../ai.mjs';
import { clientSeamsOf, clientNatalKeysOf } from '../../client/src/__tests__/helpers/promptSeams.mts';

/* 服务器与浏览器直连两条通道**真实拼出的正文**必须同源。已有的 prompt-parity.test.ts(客户端)
 * 只比对四个指令常量的定义文本 —— 常量抄对了、但拼装顺序或标题各写一份(例如 natal 又放回指令
 * 后面、输出要求少一条、语气标题换个写法)，它查不出来；而那正是打断 Qwen 显式缓存公共前缀的
 * 改法。这里改成调两端真正的拼装函数取「恒定段」直接比。
 * natal 的 JSON 取值不比(两端字段集本就略有差异，客户端少带 gender/birthYear 等)，只比标题与
 * 顶层键顺序；语气段的措辞文本也各端一份，只比标题。 */

const anchorRecord = {
  gender: 'male', birthYear: 1984,
  yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: {
    solarDate: '1984-02-06', lunarDate: '一九八四年正月初六', zodiac: '鼠', dayMaster: '庚',
    elements: { 木: 2, 火: 3, 土: 1, 金: 1, 水: 1 },
    hiddenStems: { 子: ['癸'], 寅: ['甲', '丙', '戊'], 午: ['丁', '己'] }, tenGods: {}, naYin: {}, twelveLongevity: {},
    patternFacts: { name: '建禄格', tenGod: '比肩', basis: '月令寅为日主禄' },
    strengthScore: { index: 18, label: '中和偏旺', inSeason: true, support: 55, drain: 45, detail: [] },
    luckStart: { age: 3, startYear: 1987 },
    shenSha: { auspicious: ['天乙贵人'], inauspicious: [], items: [{ name: '天乙贵人', pillarIndex: 2, position: '天干' }] },
    relationships: {},
    greatFortunes: [{ ganZhi: '丁卯', startYear: 2024, endYear: 2033, relationshipDetails: [] }],
    annualFortunes: [{ year: 2026, ganZhi: '丙午', relationshipDetails: [] }],
    monthlyFortunes: [{ year: 2026, month: 3, ganZhi: '庚辰', relationshipDetails: [] }],
  },
};

/** natal「够不够撑起缓存门槛」按真实字段量判定：fixture 只负责结构与键序，字段刻意精简，
 *  所以这里直接构造一份与引擎输出同量级的完整 nonAiResult(藏干/十神/神煞/关系各柱齐全)。 */
const fullRecord = {
  gender: 'male', birthYear: 1984,
  yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  nonAiResult: {
    ...anchorRecord.nonAiResult,
    hiddenStems: { 子: ['癸'], 寅: ['甲', '丙', '戊'], 午: ['丁', '己'], 戌: ['戊', '辛', '丁'] },
    tenGods: { year: ['偏财', '伤官'], month: ['七杀', '偏印', '偏财'], day: ['正官', '正印'], hour: ['食神', '正财'] },
    naYin: { year: '海中金', month: '炉中火', day: '路旁土', hour: '杨柳木' },
    twelveLongevity: { year: '死', month: '绝', day: '沐浴', hour: '病' },
    elementRatio: { 木: 0.25, 火: 0.375, 土: 0.125, 金: 0.125, 水: 0.125 },
    lunarDate: '一九八四年正月初六 辰时',
    relationships: { sanHe: [{ type: 'sanHe', sourcePillar: '甲子', targetPillar: '丙寅', status: 'half-combination' }], liuHe: [], chong: [], xing: [], hai: [], po: [] },
    shenSha: { auspicious: ['天乙贵人', '文昌贵人', '太极贵人'], inauspicious: ['羊刃', '劫煞'], items: Array.from({ length: 8 }, (_, i) => ({ name: ['天乙贵人', '文昌贵人', '太极贵人', '羊刃', '劫煞', '驿马', '华盖', '将星'][i], pillarIndex: i % 4, position: i % 2 ? '天干' : '地支' })) },
  },
};

const cases = [
  ['baseline', { type: 'baseline', year: 2026 }],
  ['annual', { type: 'annual', year: 2026 }],
  ['monthly', { type: 'monthly', year: 2026, month: 3 }],
  ['decade', { type: 'decade', year: 2026 }],
  ['overview', { type: 'overview', year: 2026 }],
  ['adjustment', { type: 'adjustment', year: 2026, guide: { element: '火' } }],
];

const instructionOf = (kind) => kind === 'baseline' ? BASELINE_PROMPT
  : kind === 'adjustment' ? ADJUST_PREFIX : kind === 'overview' ? OVERVIEW_PROMPT : SCOPE_PREFIX;

/** 从服务器正文里取出恒定段：靠标题定位，不依赖实现细节。 */
function serverSeams(task) {
  const content = buildTaskPayload(anchorRecord, task, 80).messages[1].content;
  const start = content.indexOf(NATAL_BLOCK_HEAD);
  const toneAt = content.indexOf(TONE_HEAD);
  assert.ok(start >= 0 && toneAt > start, task.type + ' 服务器正文缺少 natal 或语气标题');
  const rulesAt = content.indexOf(INSTRUCTION_TAIL_MARK, start);
  assert.ok(rulesAt > start && rulesAt < toneAt, task.type + ' 服务器正文找不到输出要求标题');
  const instruction = instructionOf(task.type);
  const instrStart = content.indexOf(instruction.slice(0, 24), start);
  assert.ok(instrStart > start, task.type + ' 服务器正文找不到指令起点');
  return {
    natalHead: content.slice(start, start + NATAL_BLOCK_HEAD.length),
    natalJson: content.slice(start + NATAL_BLOCK_HEAD.length, instrStart),
    instruction: content.slice(instrStart, rulesAt),
    rules: content.slice(rulesAt, toneAt),
    toneHead: content.slice(toneAt, toneAt + TONE_HEAD.length),
  };
}

/** 服务器 natal 比客户端多带的那几项：跨通道只比「共有键的相对顺序」，多带的键在此排除。 */
const SERVER_ONLY_KEYS = ['gender', 'birthYear', 'lunarDate', 'elementRatio', 'naYin', 'twelveLongevity'];
const sharedKeys = (keys) => keys.filter((k) => !SERVER_ONLY_KEYS.includes(k));

describe('服务器与浏览器直连的真实正文同源(标题/顺序/恒定段)', () => {
  for (const [label, task] of cases) {
    test(`${label}: natal 标题+共有键顺序 / 指令 / 输出要求 / 语气标题一致`, () => {
      const s = serverSeams(task);
      const c = clientSeamsOf(label);
      assert.equal(c.natalHead, s.natalHead, `${label} natal 标题两端不同 → 公共前缀从第一个字就断`);
      assert.deepEqual(sharedKeys(Object.keys(JSON.parse(s.natalJson))), clientNatalKeysOf(anchorRecord),
        `${label} natal 共有键的相对顺序两端不同(改一处就会让公共前缀提前分叉)`);
      assert.ok(s.instruction.startsWith(c.instruction.slice(0, 24)), `${label} 任务指令文本两端不同`);
      assert.equal(s.instruction, c.instruction, `${label} 任务指令整段两端不同`);
      assert.equal(c.rules, s.rules, `${label} 输出硬性要求两端不同(条数或文字)`);
      assert.equal(c.toneHead, s.toneHead, `${label} 语气段标题两端不同`);
    });
  }

  test('natal 块自身够长，能独立撑起缓存门槛(≥1000 字)', () => {
    // 用完整命盘数据(引擎真实字段量)判定；fixture 只保证结构与键序，字段没那么多。
    const len = NATAL_BLOCK_HEAD.length + JSON.stringify(natalFactsOf(fullRecord)).length;
    assert.ok(len >= 1000, 'natal 仅 ' + len + ' 字');
  });

  test('natal 段在服务器全部任务里是同一段文本(四类任务共享前缀的前提)', () => {
    const blocks = new Set(cases.map(([, task]) => serverSeams(task).natalJson));
    assert.equal(blocks.size, 1);
  });

  test('输出要求只有一份文本(服务器不再各分支重复拼)', () => {
    assert.ok(OUTPUT_RULES_TEXT.includes('违反即') === false, '规则正文不该含标题');
    for (const [label, task] of cases) {
      const s = serverSeams(task);
      assert.equal(s.rules.split(INSTRUCTION_TAIL_MARK).length - 1, 1, label + ' 输出要求标题出现次数不对');
    }
  });

  test('natalFactsOf 带引擎格局与旺衰(模型沿用不重判的依据)', () => {
    const keys = Object.keys(natalFactsOf(anchorRecord));
    assert.ok(keys.includes('patternFacts') && keys.includes('strengthScore'));
    assert.ok(keys.includes('luckStart'), '大运年份区间要靠它，缺了模型只能瞎估');
  });

  test('natalFactsOf 带调候且紧随旺衰之后(与客户端 natal 同序，否则公共前缀当场分叉)', () => {
    const rec = {
      ...anchorRecord,
      nonAiResult: { ...anchorRecord.nonAiResult, tiaohouFacts: '春·温而余寒未尽·调候非急(以扶抑格局为主)·《穷通宝鉴》按季归并用神参考：丙(佐甲)〔仅供参考〕' },
    };
    const natal = natalFactsOf(rec);
    const keys = Object.keys(natal);
    assert.equal(keys.indexOf('tiaohouFacts'), keys.indexOf('strengthScore') + 1, '调候必须紧跟旺衰、位于起运之前');
    assert.doesNotMatch(natal.tiaohouFacts, /[A-Za-z]/, '注入正文的调候串不许有拉丁字母');
    // 缺该字段的存量记录： natalFactsOf 应原样丢弃，两端一致(不凭空空造一格)
    assert.equal('tiaohouFacts' in JSON.parse(JSON.stringify(natalFactsOf(anchorRecord))), false);
  });
});
