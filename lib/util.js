import { createHash, randomBytes, randomUUID, timingSafeEqual, scryptSync } from 'node:crypto';

export const uuid = () => randomUUID();
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newOrderId() {
  const b = randomBytes(8); let s = '';
  for (let i = 0; i < 8; i++) { s += ALPHA[b[i] % ALPHA.length]; if (i === 3) s += '-'; }
  return 'FR-' + s;
}
export const newToken = () => randomBytes(32).toString('base64url');
export const isOrderId = (s) => typeof s === 'string' && /^FR-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(s);
export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Admin password: "scrypt$<salt hex>$<hash hex>" (generate with scripts/hash-password.js)
export function checkPassword(password, stored) {
  if (!stored || !password) return false;
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const got = scryptSync(String(password), Buffer.from(salt, 'hex'), 32).toString('hex');
  return safeEqual(got, hash);
}

export function clip(v, n = 500) {
  if (v === null || v === undefined) return null;
  const s = String(v); return s.length > n ? s.slice(0, n) : s;
}

// Coarse device class from the user agent (we never store the full UA in events).
export function deviceOf(ua = '') {
  const u = ua.toLowerCase();
  const inApp = /fban|fbav|instagram/.test(u) ? (u.includes('instagram') ? 'instagram-inapp' : 'facebook-inapp') : '';
  const kind = /ipad|tablet/.test(u) ? 'tablet' : /mobi|iphone|android/.test(u) ? 'mobile' : 'desktop';
  return inApp ? `${kind}:${inApp}` : kind;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export async function readBody(request, max = 32 * 1024) {
  const text = await request.text();
  if (text.length > max) { const e = new Error('payload too large'); e.status = 413; throw e; }
  return text;
}
export async function readJson(request, max) {
  const t = await readBody(request, max);
  try { return t ? JSON.parse(t) : {}; } catch { const e = new Error('invalid json'); e.status = 400; throw e; }
}

export function clientIp(request) {
  const xf = request.headers.get('x-forwarded-for') || '';
  return xf.split(',')[0].trim() || null;
}

// Wrap a handler: never leak internals, always JSON.
export function handle(fn) {
  return async (request) => {
    try { return await fn(request); }
    catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[front]', e && e.stack || e);
      return json({ ok: false, error: status >= 500 ? 'server_error' : e.message, ...(status < 500 && e.extra || {}) }, status, e.headers || {});
    }
  };
}

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
