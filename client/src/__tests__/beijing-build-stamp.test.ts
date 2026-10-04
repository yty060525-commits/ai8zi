import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLabel } from '../utils/buildInfo';

/* =============================================================================
 * 底部版本戳「按北京口径读」的判据 —— 与详情页/聊天同一类缺陷的第三个消费点。
 *
 * buildLabel 原先直接读 at.getFullYear()/getMonth()/getDate()/getHours()，
 * 而非 +08 设备上这些字段比北京晚若干小时：UTC 设备在 UTC 16:00 之后构建的那一版，
 * 会被读成**前一天**。而这一串正是用来判断「手机是不是旧版」的依据(见项目记忆
 * 「UI 上有构建版本戳」)，差一天就会把「已是新版」读成旧日期、把人引向错误结论。
 *
 * ⚠ 桩必须覆盖整个用例体：buildLabel 的时间来自参数而不是默认参，所以这里改的是
 *   Date.prototype 的本地 getter 族(等价于一台 UTC 真机)，只包断言不包构造同样测不到。
 * ============================================================================= */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');

/** 本机东八区，本地读法与北京同值 → 必须换时钟才分得出两种写法。
 *  用「子类 + 覆盖本地 getter」而不是改 Date.prototype：后者在第二次赋值时自引用成环
 *  (实测 TypeError: Cyclic __proto__ value)，前者每次起一个新子类就没有这个问题。 */
function onUtcDevice(run: () => void) {
  const RealDate = globalThis.Date;
  class UtcDeviceDate extends RealDate {
    getFullYear() { return this.getUTCFullYear(); }
    getMonth() { return this.getUTCMonth(); }
    getDate() { return this.getUTCDate(); }
    getDay() { return this.getUTCDay(); }
    getHours() { return this.getUTCHours(); }
    getMinutes() { return this.getUTCMinutes(); }
  }
  (globalThis as any).Date = UtcDeviceDate;
  try { run(); } finally { (globalThis as any).Date = RealDate; }
}

describe('版本戳按北京口径取值', () => {
  it('桩自证：这台"UTC 设备"上本地读数确实与北京分叉', () => {
    onUtcDevice(() => {
      const at = new Date(Date.UTC(2026, 9, 4, 16, 5)); // 北京 2026-10-05 00:05
      expect(at.getFullYear()).toBe(2026);
      expect(at.getMonth() + 1).toBe(10);
      expect(at.getDate()).toBe(4);   // 北京已是 5 日
      expect(at.getHours()).toBe(16); // 北京是 0 时
    });
  });

  it('UTC 设备上构建的那一版，读出来仍是北京的日期与时分', () => {
    /* 取一个「本地比北京差一天又差 8 小时」的时刻：UTC 2026-10-04T16:05Z
       → 北京 2026-10-05 00:05；本地字段读出 10-04 16 时。
       期望串按北京日历当场推：五日读「五日」、零时读「零时」。 */
    const stamp = String(Date.UTC(2026, 9, 4, 16, 5));
    onUtcDevice(() => {
      expect(buildLabel(stamp)).toBe('二零二六年十月五日零时五分');
    });
    // 反向钉子：同一枚时间戳在真表(本机东八区)上也必须是这个读法，否则上面那条绿得没道理。
    expect(buildLabel(stamp)).toBe('二零二六年十月五日零时五分');
  });

  it('跨年那一刻构建的版本：年份也按北京翻过去', () => {
    const stamp = String(Date.UTC(2025, 11, 31, 16, 0)); // 北京 2026-01-01 00:00
    onUtcDevice(() => {
      expect(buildLabel(stamp)).toBe('二零二六年一月一日零时零分');
    });
  });

  it('源码层钉子：buildInfo 不再用宿主时区字段取年月日时分', () => {
    const src = readFileSync(resolve(repo, 'client/src/utils/buildInfo.ts'), 'utf8').replace(/\r\n/g, '\n');
    const code = src.split('\n')
      .map((l) => l.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, ''))
      .filter((l) => /at\.get|chinaDateTimeParts|p\.(year|month|day|hour|minute)/.test(l));
    const localReads = code.filter((l) => /at\.get(FullYear|Month|Date|Hours|Minutes)\(\)/.test(l));
    expect(localReads).toEqual([]);
    expect(code.join('\n')).toMatch(/chinaDateTimeParts\(/);
    expect(code.length).toBeGreaterThan(2); // 扫描面非空，判据不恒真
  });
});
