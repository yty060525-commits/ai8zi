import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, writeCache, readCache, clearChartCache, insertRecord, getRecordById } from '../db.mjs';
import { birthTimeSignature, cacheKey } from '../ai.mjs';
import { chatCacheKey } from '../chat.mjs';

const chart = { id: 'birth-time', userId: 'u', gender: 'male', birthYear: 1984, birthMonth: 2, yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午' };
const early = { year: 1984, month: 2, day: 3, hour: 9, minute: 10 };
const late = { ...early, minute: 11 };

describe('完整出生时刻缓存隔离', () => {
  const db = openDatabase(':memory:');
  after(() => db.close());

  test('同盘任务和聊天键同刻稳定、分钟变化分叉，旧盘使用空尾签名', () => {
    for (const [make, args] of [[(r) => cacheKey(r, { type: 'baseline' }, 'model'), []], [(r) => chatCacheKey(r, '问事业', 'model', 80), []]]) {
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
    const chatA = chatCacheKey(a, '问事业', 'model', 80);
    const chatB = chatCacheKey(b, '问事业', 'model', 80);
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
});
