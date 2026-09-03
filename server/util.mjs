import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const json = (res, status, body) => {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
};
export const sendText = (res, status, text) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
};
export const readJsonBody = (req, limit = 12 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (chunks.length === 0) return resolve({});
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { reject(new Error('invalid JSON body')); }
  });
  req.on('error', reject);
});

export const uuid = () => randomUUID();

export function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  const saltOut = saltHex ?? salt.toString('hex');
  return { salt: saltOut, hash: derived.toString('hex') };
}
export function verifyPassword(password, saltHex, expectedHash) {
  const { hash } = hashPassword(password, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const sha256hex = (text) => createHash('sha256').update(text).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');

export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 半年，设备一次登录长期有效
