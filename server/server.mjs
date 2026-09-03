import http from 'node:http';
import path from 'node:path';
import { openDatabase, getUserByUsername, countUsers, createUser } from './db.mjs';
import { hashPassword } from './util.mjs';
import { createApp, pruneSessions } from './app.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const dataDir = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
const dbFile = path.join(dataDir, 'mingli.sqlite3');

const db = openDatabase(dbFile);
pruneSessions(db);

// 可选环境变量引导管理员(或直接注册首个账号即为 admin)
const adminUser = process.env.ADMIN_USER?.trim();
if (adminUser && !getUserByUsername(db, adminUser)) {
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const { salt, hash } = hashPassword(password);
  createUser(db, { username: adminUser, passHash: hash, salt, role: 'admin' });
  console.log('[bootstrap] 已创建管理员账号: ' + adminUser + (process.env.ADMIN_PASSWORD ? '' : ' (默认密码 admin123，请尽快修改)'));
}

const allowRegister = process.env.ALLOW_REGISTER !== 'false';
const { handle } = createApp({ db, allowRegister });
const server = http.createServer((req, res) => handle(req, res));

server.listen(PORT, HOST, () => {
  console.log('mingli-server 已启动: http://' + HOST + ':' + PORT);
  console.log('  SQLite 数据库: ' + dbFile);
  console.log('  注册: ' + (allowRegister ? '开放(首个账号为管理员)' : '关闭'));
  console.log('  登录后设备会自动记住，无需每次输入密码。');
});
const stop = () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
