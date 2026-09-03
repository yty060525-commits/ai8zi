import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 打开(必要时创建)真正的 SQLite 数据库文件；node:sqlite 为 Node 22.5+ 内置。 */
export function openDatabase(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  name TEXT NOT NULL, gender TEXT NOT NULL,
  birth_year INTEGER NOT NULL, birth_month INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  year_pillar TEXT NOT NULL, month_pillar TEXT NOT NULL,
  day_pillar TEXT NOT NULL, hour_pillar TEXT NOT NULL,
  non_ai_result TEXT, ai_status TEXT NOT NULL DEFAULT 'not_started',
  ai_analysis TEXT, ai_overview TEXT, ai_error TEXT, ai_tasks TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id);
`);
  return db;
}

export const nowText = () => new Date().toISOString();

/* ---------- users ---------- */
export const createUser = (db, { username, passHash, salt, role }) => {
  const id = 'u-' + randomUUID();
  db.prepare('INSERT INTO users (id,username,pass_hash,salt,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, username, passHash, salt, role, nowText());
  return getUserByUsername(db, username);
};
export const getUserByUsername = (db, username) => {
  const row = db.prepare('SELECT id,username,pass_hash,salt,role,created_at FROM users WHERE username=?').get(username);
  return row || null;
};
export const getUserById = (db, id) => {
  const row = db.prepare('SELECT id,username,pass_hash,salt,role,created_at FROM users WHERE id=?').get(id);
  return row || null;
};
export const countUsers = (db) => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  return row?.n ?? 0;
};
export const changePassword = (db, userId, passHash, salt) => {
  db.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').run(passHash, salt, userId);
};

/* ---------- sessions ---------- */
export const saveSession = (db, tokenHash, userId, expiresAt) => {
  db.prepare('INSERT OR REPLACE INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(tokenHash, userId, expiresAt);
};
export const touchSession = (db, tokenHash, expiresAt) => {
  db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(expiresAt, tokenHash);
};
export const deleteSession = (db, tokenHash) => { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); };
export const deleteExpiredSessions = (db, at) => { db.prepare('DELETE FROM sessions WHERE expires_at<?').run(at); };
export const findSessionUser = (db, tokenHash) => {
  const s = db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(tokenHash);
  if (!s || s.expires_at < Date.now()) return null;
  return getUserById(db, s.user_id);
};

/* ---------- settings ---------- */
export const getSetting = (db, key, fallback = null) => {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
};
export const setSetting = (db, key, value) => {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
};
export const deleteSetting = (db, key) => { db.prepare('DELETE FROM settings WHERE key=?').run(key); };

/* ---------- records ---------- */
const RECORD_COLS = ['id','user_id','name','gender','birth_year','birth_month','created_at','year_pillar','month_pillar','day_pillar','hour_pillar','non_ai_result','ai_status','ai_analysis','ai_overview','ai_error','ai_tasks','updated_at'];
const parseJsonCol = (v) => (v == null ? undefined : JSON.parse(v));
/** DB 行 -> 客户端 BaziRecord(驼峰, JSON 对象还原) */
export function rowToRecord(row) {
  return {
    id: row.id, userId: row.user_id, name: row.name, gender: row.gender,
    birthYear: row.birth_year, birthMonth: row.birth_month,
    createdAt: row.created_at,
    yearPillar: row.year_pillar, monthPillar: row.month_pillar,
    dayPillar: row.day_pillar, hourPillar: row.hour_pillar,
    nonAiResult: parseJsonCol(row.non_ai_result),
    aiStatus: row.ai_status, aiAnalysis: parseJsonCol(row.ai_analysis),
    aiOverview: parseJsonCol(row.ai_overview), aiError: row.ai_error,
    aiTasks: parseJsonCol(row.ai_tasks),
    updatedAt: row.updated_at,
  };
}
/** 客户端记录 -> DB 参数数组 */
export function recordToRow(record) {
  const now = nowText();
  return [
    record.id, record.userId ?? '', record.name ?? '', record.gender ?? 'male',
    Number(record.birthYear) || 0, Number(record.birthMonth) || 0,
    record.createdAt ?? now,
    record.yearPillar ?? '', record.monthPillar ?? '', record.dayPillar ?? '', record.hourPillar ?? '',
    record.nonAiResult ? JSON.stringify(record.nonAiResult) : null,
    record.aiStatus ?? 'not_started',
    record.aiAnalysis ? JSON.stringify(record.aiAnalysis) : null,
    record.aiOverview ? JSON.stringify(record.aiOverview) : null,
    record.aiError ?? null,
    record.aiTasks ? JSON.stringify(record.aiTasks) : null,
    now,
  ];
}
export const insertRecord = (db, rec) => {
  const r = recordToRow(rec);
  db.prepare('INSERT OR REPLACE INTO records (' + RECORD_COLS.join(',') + ') VALUES (' + RECORD_COLS.map(() => '?').join(',') + ')').run(...r);
  return rowToRecord(db.prepare('SELECT ' + RECORD_COLS.join(',') + ' FROM records WHERE id=?').get(rec.id));
};
export const getRecordById = (db, id) => {
  const row = db.prepare('SELECT ' + RECORD_COLS.join(',') + ' FROM records WHERE id=?').get(id);
  return row ? rowToRecord(row) : null;
};
export const listRecordsByUser = (db, userId) => {
  const rows = db.prepare('SELECT ' + RECORD_COLS.join(',') + ' FROM records WHERE user_id=? ORDER BY updated_at DESC, created_at DESC').all(userId);
  return rows.map(rowToRecord);
};
export const listAllRecords = (db) => {
  const rows = db.prepare('SELECT r.*, u.username FROM records r JOIN users u ON u.id=r.user_id ORDER BY r.updated_at DESC').all();
  return rows.map((row) => ({ ...rowToRecord(row), username: row.username }));
};
export const deleteRecord = (db, id) => { db.prepare('DELETE FROM records WHERE id=?').run(id); };

/* ---------- ai cache ---------- */
export const readCache = (db, key) => {
  const row = db.prepare('SELECT payload FROM ai_cache WHERE cache_key=?').get(key);
  return row ? row.payload : null;
};
export const writeCache = (db, key, payload) => {
  db.prepare('INSERT OR REPLACE INTO ai_cache (cache_key,payload,created_at) VALUES (?,?,?)').run(key, payload, nowText());
};
export const clearChartCache = (db, gender, y, m, d, h) => {
  const pattern = '%|' + gender + '|' + y + '|' + m + '|' + d + '|' + h + '|%';
  const res = db.prepare('DELETE FROM ai_cache WHERE cache_key LIKE ?').run(pattern);
  return res.changes;
};
