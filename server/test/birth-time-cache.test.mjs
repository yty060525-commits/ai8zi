import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, writeCache, readCache, clearChartCache, insertRecord, getRecordById } from '../db.mjs';
import { birthTimeSignature, cacheKey, buildTaskPayload, runOneTask } from '../ai.mjs';
import { chatCacheKey } from '../chat.mjs';

const chart = { id: 'birth-time', userId: 'u', gender: 'male', birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
const early = { year: 1984, month: 2, day: 3, hour: 9, minute: 10 };
const late = { ...early, minute: 11 };

describe('完整出生时刻缓存隔离', () => {
  const db = openDatabase(':memory:');
  after(() => db.close());

  test('同盘任务和聊天键同刻稳定、分钟变化分叉，旧盘使用空尾签名', () => {
    const messages = [{ role: 'user', content: '问事业' }];
    for (const [make, args] of [[(r) => cacheKey(r, { type: 'baseline' }, 'model'), []], [(r) => chatCacheKey(r, '问事业', 'model', 80, messages), []]]) {
      const base = { ...chart, nonAiResult: { birthTime: early } };
      const k1 = make(base, ...args), k2 = make({ ...base }, ...args);
      const changed = make({ ...base, nonAiResult: { birthTime: late } }, ...args);
      assert.equal(k1, k2);
      assert.notEqual(k1, changed, '不同时分的起运事实不可复用答案');
      const legacy = make(chart, ...args);
      assert.ok(legacy.endsWith('|'));
      assert.equal(make({ ...chart }, ...args), legacy);
    }
  });

  test('预置异时缓存不会命中，按盘清理覆盖两种时刻', () => {
    const a = { ...chart, nonAiResult: { birthTime: early } };
    const b = { ...chart, nonAiResult: { birthTime: late } };
    const taskA = cacheKey(a, { type: 'baseline' }, 'model', 80);
    const taskB = cacheKey(b, { type: 'baseline' }, 'model', 80);
    const messages = [{ role: 'user', content: '问事业' }];
    const chatA = chatCacheKey(a, '问事业', 'model', 80, messages);
    const chatB = chatCacheKey(b, '问事业', 'model', 80, messages);
    writeCache(db, taskA, '时刻甲'); writeCache(db, chatA, '聊天甲');
    assert.equal(readCache(db, taskB), null);
    assert.equal(readCache(db, chatB), null);
    writeCache(db, taskB, '时刻乙'); writeCache(db, chatB, '聊天乙');
    assert.equal(clearChartCache(db, chart.gender, chart.yearPillar, chart.monthPillar, chart.dayPillar, chart.hourPillar), 4);
  });

  test('服务端记录 JSON 往返保留出生时刻元数据', () => {
    const saved = insertRecord(db, { ...chart, nonAiResult: { birthTime: early, greatFortunes: [] } });
    assert.deepEqual(getRecordById(db, chart.id).nonAiResult.birthTime, early);
    assert.deepEqual(saved.nonAiResult.birthTime, early);
  });

  test('整值浮点、零时与闰日规范为稳定签名，非法日期和字符串被拒绝', () => {
    assert.equal(birthTimeSignature({ year: 2000.0, month: 2.0, day: 29.0, hour: 0.0, minute: 0.0 }), '2000-02-29T00:00');
    assert.equal(birthTimeSignature({ year: 1900, month: 2, day: 29, hour: 0, minute: 0 }), '');
    assert.equal(birthTimeSignature({ year: '2000', month: 2, day: 29, hour: 0, minute: 0 }), '');
  });

  test('真实payload事实摘要隔离手改值和任务时段，忽略墙钟及未发送内容，并按盘清全部版本', async () => {
    const first = { ...chart, nonAiResult: { solarDate: '1984-02-06', elements: { 木: 1 }, elementRatio: { 木: .125 },
      annualFortunes: [{ year: 2027, ganZhi: '丁未' }], greatFortunes: [], monthlyFortunes: [],
      manualEdits: { version: 1, fields: { elements: { 木: 9 }, zodiac: '兔', fortuneDirection: 'backward', chenggu: { totalLiang: 10 } } } } };
    const task = { type: 'annual', year: 2027 };
    const one = cacheKey(first, task, 'deepseek-flash');
    const payload = buildTaskPayload(first, task);
    assert.equal(payload.cacheEvidence.natal.elements.木, 9);
    assert.equal(payload.cacheEvidence.natal.chenggu.totalText, '十两');
    assert.equal(payload.cacheEvidence.natal.fortuneDirection, 'backward');
    assert.ok(payload.messages[1].content.includes('十两'));
    const reordered = { ...first, nonAiResult: { ...first.nonAiResult, currentTime: '2099', savedAt: 'now', factsRevision: 99,
      manualEdits: { fields: { chenggu: { totalLiang: 10 }, fortuneDirection: 'backward', zodiac: '兔', elements: { 木: 9 } }, version: 1 },
      annualFortunes: [...first.nonAiResult.annualFortunes, { year: 2028, ganZhi: '戊申' }] } };
    assert.equal(cacheKey(reordered, task, 'deepseek-flash'), one);
    const next = structuredClone(first); next.nonAiResult.manualEdits.fields.elements.木 = 8;
    const two = cacheKey(next, task, 'deepseek-flash'); assert.notEqual(two, one);
    assert.notEqual(cacheKey(first, { ...task, annual: { year: 2027, ganZhi: '庚申' } }, 'deepseek-flash'), one);
    assert.equal(one.split('|').length, 14); assert.equal(one.split('|').at(-1), '');
    writeCache(db, one, JSON.stringify({ explanation: '旧有效事实' }));
    assert.equal((await runOneTask(db, first, task)).analysis.explanation, '旧有效事实');
    assert.equal((await runOneTask(db, next, task)).status, 'not_configured');
    writeCache(db, two, JSON.stringify({ explanation: '新有效事实' }));
    assert.equal(clearChartCache(db, chart.gender, chart.yearPillar, chart.monthPillar, chart.dayPillar, chart.hourPillar), 2);
    assert.equal(readCache(db, one), null); assert.equal(readCache(db, two), null);
  });
});
