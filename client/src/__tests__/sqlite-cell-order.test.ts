import { describe, expect, it } from 'vitest';
import { RECORD_COLS, recordToCells } from '../data/offlineSql';
import { exportRecordsSQLite, exportRecordsSQLText } from '../data/sqliteExport';
import { parseBackupFile } from '../data/sqlImport';
import type { BaziRecord } from '../types/domain';

/* 导出层此前只有两条读数：.sql 文本 dump 有逐字段比对(export-hydrate.test.ts)，
   .sqlite 二进制只钉了 aiTasks 与 toneUsed 两格(import-roundtrip.test.ts L163-165)。
   十七列里其余十五列在二进制路上没有任何判据 —— 而这条路上确实存在一个「写侧自洽、
   读侧也自洽，却把数据存进错列」的静默错位形态：RECORD_COLS 决定 INSERT 的列名顺序，
   recordToCells 决定参数顺序，两者各有一份同样的顺序；只要其中一份相邻两项对调，
   SQL 仍然合法、导入也不报错，读回来的却是「性别栏装着出生年、出生年栏装着性别」。
   下面用同一份夹具跑通两种格式，并把根因(两份顺序必须逐项一致)单独钉住。 */

/** 每一列都取互不相同、且类型可分辨的值：整数列不能读出字符串、日期串不能被当成姓名。 */
const rec: BaziRecord = {
  id: 'cell-order', name: '列序甲', gender: 'female', birthYear: 1986, birthMonth: 7,
  createdAt: '2025-04-09T08:15:30.000Z',
  yearPillar: '丙寅', monthPillar: '癸巳', dayPillar: '壬戌', hourPillar: '辛丑',
  nonAiResult: { greatFortunes: [{ ganZhi: '甲午', startYear: 2016, endYear: 2025 }], annualFortunes: [], monthlyFortunes: [] },
  aiStatus: 'completed',
  aiAnalysis: { pattern: '正印格', strength: '身强', usefulElements: ['木'], avoidElements: ['金'], explanation: 'AI 正文，用来验证 JSON 列没被当成纯文本列。' },
  aiOverview: { summary: '概述一段' },
  aiError: null,
  aiTasks: { 'task-01': { task: { taskId: 'task-01', type: 'baseline' }, status: 'completed', analysis: { explanation: '任务正文' } } },
  toneUsed: 47,
} as unknown as BaziRecord;

/** 期望值一律取自**记录对象本身**而不是重抄字面量：这样改动夹具不会让判据跟着一起错。
   ⚠ 键名用的是 SQLite 行里的那一列(下划线)，不是 BaziRecord 上的驼峰字段 —— 要钉的错位形态正是
   「这一列的值跑进了那一列」，所以必须按下划线列名逐格比；recordFromRow 把 birth_year 读进
   birthYear，用下划线去取只会读到 undefined，判据就成了空集。 */
const expectations = (): Record<string, unknown> => ({
  id: rec.id, name: rec.name, gender: rec.gender,
  birth_year: rec.birthYear, birth_month: rec.birthMonth, created_at: rec.createdAt,
  year_pillar: rec.yearPillar, month_pillar: rec.monthPillar, day_pillar: rec.dayPillar, hour_pillar: rec.hourPillar,
  ai_status: rec.aiStatus, tone_used: rec.toneUsed,
  // ai_error 不放进逐字段表：库里写的是 NULL，recordFromRow 走 jsonCell 把 NULL 读成 undefined
  // (offlineSql.ts L101)，这是「没有错误」的既有归一化口径而不是错位。单独钉一行，免得下一个人
  // 把它当成列序 bug 去改读侧。
  ai_error: undefined,
});

/** 按 SQLite 列名取回读值(驼峰字段名换算)；JSON 列已被 recordFromRow 解析回对象，同形可直接比。 */
const cellOf = (back: BaziRecord, col: string): unknown =>
  (back as unknown as Record<string, unknown>)[col in back ? col : col.replace(/_(\w)/g, (_m, c) => c.toUpperCase())];

describe('二进制导出的列序(缺陷 #97：写侧两份顺序可以各自成对地错位)', () => {
  it('前提钉子一：recordToCells 与 RECORD_COLS 逐项同长同序(对调任意相邻两列都会在这里红)', () => {
    const cells = recordToCells(rec);
    expect(cells.length, '参数个数与列数不等时 SQLite 直接报错，界面上是「导出失败」').toBe(RECORD_COLS.length);
    for (let i = 0; i < RECORD_COLS.length; i += 1) {
      const col = RECORD_COLS[i];
      const camel = col.replace(/_(\w)/g, (_m, c) => c.toUpperCase());
      const expected = (rec as unknown as Record<string, unknown>)[camel];
      // non_ai_result / ai_* 这几列存的是序列化后的文本，比对解析回来的形态
      const got = typeof expected === 'object' && expected !== null ? JSON.parse(String(cells[i])) : cells[i];
      expect(got, `第 ${i + 1} 个参数不是 ${col} 这一列该放的值 ⇒ 列名与参数对不上号`).toEqual(expected);
    }
  });

  it('前提钉子二：建表语句里的列序与 RECORD_COLS 一致(否则 SELECT 出来的列名会串位)', () => {
    const text = exportRecordsSQLText([rec]);
    const tableCols = /CREATE TABLE IF NOT EXISTS bazi_records \(([^)]*)\)/.exec(text)![1]
      .split(',').map((s) => s.trim().split(/\s+/)[0]);
    expect(tableCols).toEqual([...RECORD_COLS]);
  });

  it('.sqlite 二进制：十七列逐字段读回，不错位、不丢类型、JSON 列仍是对象', async () => {
    const bytes = await exportRecordsSQLite([rec]);
    const { records } = await parseBackupFile(bytes, 'mingli-data.sqlite');
    expect(records).toHaveLength(1);
    const back = records[0];
    for (const [col, value] of Object.entries(expectations())) {
      expect(cellOf(back, col), `${col} 读回来的不是写入时的那一格`).toEqual(value);
    }
    // 类型层面再钉一次：整数列若被写进文本列，Number() 会把「丙寅」读成 NaN
    expect(Number.isInteger(back.birthYear)).toBe(true);
    expect(Number.isInteger(back.birthMonth)).toBe(true);
    // 派生数组与 JSON 列走的是同一条序列化路，错位时它们最先变成 undefined
    expect((back.nonAiResult as { greatFortunes?: unknown[] })?.greatFortunes).toEqual(rec.nonAiResult!.greatFortunes);
    expect((back.aiAnalysis as { explanation?: string })?.explanation).toContain('AI 正文');
    expect(Object.keys(back.aiTasks ?? {})).toEqual(['task-01']);
  });

  it('.sql 文本 dump：同一套列序读回同一组字段(两条格式不许分叉)', async () => {
    const { records } = await parseBackupFile(new TextEncoder().encode(exportRecordsSQLText([rec])), 'mingli-export.sql');
    const back = records[0];
    for (const [col, value] of Object.entries(expectations())) {
      expect(cellOf(back, col), `${col} 在 .sql 路上和 .sqlite 路上读得不一样`).toEqual(value);
    }
  });

  /* 上面三条 roundtrip 判据都从 RECORD_COLS 取列名，所以「RECORD_COLS 与 recordToCells 同时
     对调同一对」这种自洽错位能把文件真写成 year/month 互换、却仍然读回正确对象(roundtrip 全绿)。
     这条不碰共享常量：直接按**写死的列名顺序**逐格查文件里的物理列序 —— 第三方拿到分享文件时
     看到的就是这个顺序，它错了整份备份就不可自解释。 */
  it('文件里的物理列序：按写死的十七列逐个 SELECT，值必须落在承诺的那一列', async () => {
    const HARD = ['id', 'name', 'gender', 'birth_year', 'birth_month', 'created_at',
      'year_pillar', 'month_pillar', 'day_pillar', 'hour_pillar', 'non_ai_result', 'ai_status',
      'ai_analysis', 'ai_overview', 'ai_error', 'ai_tasks', 'tone_used'];
    expect([...RECORD_COLS], '共享常量自己先漂移了 ⇒ 下面这条按硬编码顺序的比对才有意义').toEqual(HARD);
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs({ locateFile: () => './sql-wasm.wasm' });
    const db = new SQL.Database(await exportRecordsSQLite([rec]));
    try {
      for (const col of HARD) {
        const res = db.exec(`SELECT ${col} FROM bazi_records`);
        const raw = res.length ? res[0].values[0][0] : undefined;
        const camel = col.replace(/_(\w)/g, (_m, c) => c.toUpperCase());
        // JSON 列存的是文本，比对前先解析；NULL 与缺列一律归成 undefined(与 recordFromRow 同口径)
        const got = typeof raw === 'string' && /^[{[]/.test(raw) ? JSON.parse(raw) : (raw ?? undefined);
        // 空值两侧统一：夹具里 aiError 是 undefined，文件里写的是 SQL NULL(读回 null)，
        // 二者都表示「没有错误」，与 recordFromRow 的归一化同口径 —— 不统一就会红在这一格上。
        expect(got ?? undefined, `导出文件里 ${col} 这一列装的不是它的值 ⇒ 列序错位，别人打开备份会读串`)
          .toEqual((rec as unknown as Record<string, unknown>)[camel] ?? undefined);
      }
    } finally { db.close(); }
  });
});
