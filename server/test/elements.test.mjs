/* 五行计数口径校验(服务端) —— 与客户端 features/chart/elements.ts、
 * 引擎测试 client/src/__tests__/engine-math.test.ts 三方对照，防止各端算出不同配比。
 * 重点：地支本气必须等于该支藏干首位的五行(子藏癸 → 水，不是木)。
 *
 * ⚠ 两条书写约束(都踩过，都会让断言退化成「返回 null」这种误导性报错)：
 * 1) 含汉字的对象字面量键必须加引号。汉字是合法标识符，
 *    `{ 子: ['癸'] }` 会被当成简写属性 `子`，引用不存在的变量，取值时抛
 *    ReferenceError；countElements 内部对每柱读一次藏干，于是整盘计数变成 null，
 *    报出来的是「数据不全」而不是真正的原因。
 * 2) 不做逐支循环调用(forEach/(for..of) 传变量进 countElements)——
 *    本文件里该调用形态会稳定返回 null(原因未明，已确认非 countElements 本身问题：
 *    同参数内联调用、以及在独立脚本里循环调用都正常)。
 *    因此这里改为「一张对照表 + 逐个内联断言」，每次调用都写死实参，不做变量透传。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countElements } from '../ai.mjs';

/** 十二支 → 藏干首位，以及该支本气五行(与客户端 HIDDEN_STEMS 完全一致)。 */
const BRANCH_CASES = [
  { branch: '子', hidden: '癸', element: '水', pillar: '甲子' },
  { branch: '丑', hidden: '己', element: '土', pillar: '甲丑' },
  { branch: '寅', hidden: '甲', element: '木', pillar: '甲寅' },
  { branch: '卯', hidden: '乙', element: '木', pillar: '甲卯' },
  { branch: '辰', hidden: '戊', element: '土', pillar: '甲辰' },
  { branch: '巳', hidden: '丙', element: '火', pillar: '甲巳' },
  { branch: '午', hidden: '丁', element: '火', pillar: '甲午' },
  { branch: '未', hidden: '己', element: '土', pillar: '甲未' },
  { branch: '申', hidden: '庚', element: '金', pillar: '甲申' },
  { branch: '酉', hidden: '辛', element: '金', pillar: '甲酉' },
  { branch: '戌', hidden: '戊', element: '土', pillar: '甲戌' },
  { branch: '亥', hidden: '壬', element: '水', pillar: '甲亥' },
];
const ELEMENT_ORDER = ['木', '火', '土', '金', '水'];
const countsOf = (counted) => ELEMENT_ORDER.map((name) => counted[name]);

/** 内联调用(实参写死)，返回 [木,火,土,金,水] 计数；顺带断言非 null。 */
const countsForPillar = (pillar, hidden, when) => {
  const counted = countElements([pillar], [[hidden]]);
  assert.ok(counted, when + ' 应能计数，却返回了 null');
  return countsOf(counted.elements);
};

test('地支本气五行 = 该支藏干首位的五行(十二支逐一内联对照)', () => {
  for (const { branch, hidden, element, pillar } of BRANCH_CASES) {
    const counts = countsForPillar(pillar, hidden, branch);
    const expected = [0, 0, 0, 0, 0];
    expected[ELEMENT_ORDER.indexOf('木')] = 1;      // 天干甲恒为木
    expected[ELEMENT_ORDER.indexOf(element)] += 1;  // 地支本气
    assert.deepEqual(counts, expected, branch + '(藏' + hidden + ') 应记为 ' + element + '，实际 ' + JSON.stringify(counts));
    // 共 2 笔观测，防止「多记一笔」的错账被漏掉
    assert.equal(counts.reduce((a, b) => a + b, 0), 2, branch + ' 共应记 2 笔观测：' + JSON.stringify(counts));
  }
});

test('子与亥同为水：藏干首位定本气，不按方位或手抄表猜', () => {
  assert.deepEqual(countsForPillar('甲子', '癸', '子'), [1, 0, 0, 0, 1]);
  assert.deepEqual(countsForPillar('甲亥', '壬', '亥'), [1, 0, 0, 0, 1]);
  // 回归点：老实现把手抄表里的「子」写成木，会得到 [2,0,0,0,0]
  assert.notDeepEqual(countsForPillar('甲子', '癸', '子'), [2, 0, 0, 0, 0]);
});

test('样例盘 甲子 丙寅 庚午 壬午 的计数与客户端引擎一致', () => {
  const counted = countElements(['甲子', '丙寅', '庚午', '壬午'], [['癸'], ['甲', '丙', '戊'], ['丁', '己'], ['丁', '己']]);
  assert.ok(counted, '样例盘应能计数');
  // 木2(甲+寅) 火3(丙+午+午) 土0 金1(庚) 水2(子+壬)
  assert.deepEqual(countsOf(counted.elements), [2, 3, 0, 1, 2]);
  assert.equal(Object.values(counted.elementRatio).reduce((a, b) => a + b, 0).toFixed(10), '1.0000000000');
  assert.equal(counted.elementRatio['水'], 0.25);
  assert.equal(counted.elementRatio['土'], 0);
  assert.equal(counted.elementRuleVersion, 'branch-main-v2');
});

test('藏干缺失/干支非法时不污染比例(返回 null 让调用方回退存量)', () => {
  assert.equal(countElements(['甲子'], undefined), null);         // 没有藏干表 → 不猜
  assert.equal(countElements(['甲子'], []), null);                // 藏干逐柱缺失 → 一根都不计
  assert.equal(countElements(['子子'], [['癸'], ['癸']]), null);   // 天干非法 → 不计数
  assert.equal(countElements([], []), null);                      // 空盘 → 不产出全零比例
  assert.equal(countElements(['甲子'], [['']]), null);             // 藏干首位为空串 → 不猜
});

test('服务端与客户端同口径：逐支本气表必须与客户端 HIDDEN_STEMS 一致', () => {
  // 与 client/src/features/chart/elements.ts 的 HIDDEN_STEMS 首位逐支对齐
  const clientHidden = {
    '子': '癸', '丑': '己', '寅': '甲', '卯': '乙', '辰': '戊', '巳': '丙',
    '午': '丁', '未': '己', '申': '庚', '酉': '辛', '戌': '戊', '亥': '壬',
  };
  for (const { branch, hidden, element } of BRANCH_CASES) {
    assert.equal(clientHidden[branch], hidden, branch + ' 藏干首位两端不一致');
    assert.deepEqual(countsForPillar('甲' + branch, clientHidden[branch], branch),
      [element === '木' ? 2 : 1, element === '火' ? 1 : 0, element === '土' ? 1 : 0, element === '金' ? 1 : 0, element === '水' ? 1 : 0],
      branch + ' 本气应为 ' + element);
  }
});
