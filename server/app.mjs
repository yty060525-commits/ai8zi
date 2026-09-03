import { randomToken, sha256hex, hashPassword, verifyPassword, json, sendText, readJsonBody, uuid, SESSION_TTL_MS } from './util.mjs';
import {
  createUser, getUserByUsername, getUserById, countUsers, changePassword,
  saveSession, touchSession, deleteSession, deleteExpiredSessions, findSessionUser,
  getSetting, setSetting,
  insertRecord, getRecordById, listRecordsByUser, listAllRecords, deleteRecord, clearChartCache,
} from './db.mjs';
import { runOneTask, runSelfTest, PROVIDERS, currentProviderId, providerKey, saveProviderKey, saveProviderId, providerOf } from './ai.mjs';

function publicUser(u) {
  return u ? { id: u.id, username: u.username, role: u.role } : null;
}
function authFrom(db, req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const user = findSessionUser(db, sha256hex(token));
  if (!user) return null;
  const remaining = user.expires ? 0 : 1; // findSessionUser 已校验过期
  // 滑动续期：快到期才延长
  const s = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(sha256hex(token));
  if (s && s.expires_at - Date.now() < 30 * 24 * 60 * 60 * 1000) {
    touchSession(db, sha256hex(token), Date.now() + SESSION_TTL_MS);
  }
  return user;
}

export function createApp({ db, allowRegister = true }) {
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;
    const path = url.pathname;
    // CORS：PWA 部署在不同域名时也要可访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const api = path.startsWith('/api/');
    if (!api) {
      if (path === '/' || path === '/health') return json(res, 200, { ok: true, service: 'mingli-server', time: new Date().toISOString() });
      return json(res, 404, { error: 'not found' });
    }

    const seg = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const route = seg.join('/');
    try {
      // ---- 无需登录 ----
      if (method === 'POST' && route === 'auth/register') {
        if (!allowRegister) return json(res, 403, { error: '暂未开放注册' });
        const body = await readJsonBody(req);
        const username = String(body.username ?? '').trim();
        const password = String(body.password ?? '');
        if (!/^[\w\u4e00-\u9fa5-]{2,24}$/.test(username)) return json(res, 400, { error: '用户名需 2-24 位(字母/数字/下划线/中文)' });
        if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
        if (getUserByUsername(db, username)) return json(res, 409, { error: '用户名已存在' });
        const first = countUsers(db) === 0;
        const { salt, hash } = hashPassword(password);
        const user = createUser(db, { username, passHash: hash, salt, role: first ? 'admin' : 'user' });
        const token = startSession(db, user.id);
        return json(res, 200, { token, user: publicUser(user), firstUserIsAdmin: first });
      }
      if (method === 'POST' && route === 'auth/login') {
        const body = await readJsonBody(req);
        const user = getUserByUsername(db, String(body.username ?? '').trim());
        if (!user || !verifyPassword(String(body.password ?? ''), user.salt, user.pass_hash)) {
          return json(res, 401, { error: '账号或密码错误' });
        }
        const token = startSession(db, user.id);
        return json(res, 200, { token, user: publicUser(user) });
      }
      if (route === 'health' || route === '') {
        return json(res, 200, { ok: true, service: 'mingli-server', time: new Date().toISOString() });
      }

      // ---- 需要登录 ----
      const user = authFrom(db, req);
      if (!user) return json(res, 401, { error: '未登录或登录已过期' });
      if (method === 'POST' && route === 'auth/logout') {
        const token = String(req.headers.authorization || '').slice(7);
        deleteSession(db, sha256hex(token.trim()));
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && route === 'auth/me') return json(res, 200, { user: publicUser(user) });
      if (method === 'POST' && route === 'auth/password') {
        const body = await readJsonBody(req);
        if (!verifyPassword(String(body.old ?? ''), user.salt, user.pass_hash)) return json(res, 403, { error: '原密码错误' });
        const pw = String(body.new ?? '');
        if (pw.length < 6) return json(res, 400, { error: '新密码至少 6 位' });
        const { salt, hash } = hashPassword(pw);
        changePassword(db, user.id, hash, salt);
        return json(res, 200, { ok: true });
      }

      // ---- 记录(账号隔离：只能操作自己名下；admin 另行全量接口) ----
      if (method === 'GET' && route === 'records') return json(res, 200, { records: listRecordsByUser(db, user.id) });
      if (method === 'POST' && route === 'records') {
        const body = await readJsonBody(req);
        if (!body || !body.name || !body.yearPillar) return json(res, 400, { error: '缺少必填字段(name/yearPillar)' });
        const rec = { ...body, id: body.id || 'r-' + uuid(), userId: user.id };
        const saved = insertRecord(db, rec);
        return json(res, 200, { record: saved });
      }
      if (route.startsWith('records/')) {
        const rest = route.slice('records/'.length).split('/');
        const id = decodeURIComponent(rest[0]);
        const rec = getRecordById(db, id);
        if (!rec) return json(res, 404, { error: '记录不存在' });
        const owner = rec.userId === user.id || user.role === 'admin';
        if (!owner) return json(res, 403, { error: '无权访问他人记录' });
        if (method === 'GET' && rest.length === 1) return json(res, 200, { record: rec });
        if (method === 'DELETE' && rest.length === 1) { deleteRecord(db, id); return json(res, 200, { ok: true }); }
        if (method === 'PUT' && rest.length === 1) {
          const body = await readJsonBody(req);
          const saved = insertRecord(db, { ...body, id, userId: rec.userId });
          return json(res, 200, { record: saved });
        }
        if (method === 'POST' && rest[1] === 'ai' && rest[2] === 'task') {
          const body = await readJsonBody(req);
          if (!body?.task) return json(res, 400, { error: '缺少 task' });
          const result = await runOneTask(db, rec, body.task, body.tone);
          return json(res, 200, { result });
        }
        if (method === 'POST' && rest[1] === 'ai' && rest[2] === 'cache-clear') {
          const body = await readJsonBody(req);
          const removed = clearChartCache(db, rec.gender, rec.yearPillar, rec.monthPillar, rec.dayPillar, rec.hourPillar);
          return json(res, 200, { removed });
        }
        return json(res, 404, { error: 'unknown records action' });
      }

      // ---- 管理端 ----
      if (user.role !== 'admin') return json(res, 403, { error: '需要管理员账号' });
      if (method === 'GET' && route === 'admin/records') {
        return json(res, 200, { records: listAllRecords(db) });
      }
      if (method === 'GET' && route === 'admin/config') {
        const provider = currentProviderId(db);
        return json(res, 200, {
          providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, model: p.model, configured: !!providerKey(db, p.id) })),
          provider,
        });
      }
      if (method === 'POST' && route === 'admin/config') {
        const body = await readJsonBody(req);
        if (body.provider && PROVIDERS.some((p) => p.id === body.provider)) saveProviderId(db, body.provider);
        for (const p of PROVIDERS) {
          if (typeof body.keys?.[p.id] === 'string' && body.keys[p.id].trim()) saveProviderKey(db, p.id, body.keys[p.id]);
          if (typeof body.key === 'string' && body.key.trim() && body.provider === p.id) saveProviderKey(db, p.id, body.key);
        }
        return json(res, 200, { ok: true, message: 'AI 配置已保存' });
      }
      if (method === 'POST' && route === 'admin/test') {
        const r = await runSelfTest(db);
        return json(res, r.ok ? 200 : 400, r);
      }
      return json(res, 404, { error: 'unknown api: /api/' + route });
    } catch (err) {
      if (String(err?.message || err).includes('too large') || String(err?.message || err).includes('JSON')) {
        return json(res, 400, { error: String(err.message) });
      }
      console.error('[server]', req.method, path, err);
      return json(res, 500, { error: '服务器内部错误' });
    }
  }

  function startSession(db, userId) {
    const token = randomToken();
    saveSession(db, sha256hex(token), userId, Date.now() + SESSION_TTL_MS);
    return token;
  }
  return { handle, startSession };
}

export function pruneSessions(db) { deleteExpiredSessions(db, Date.now()); }
