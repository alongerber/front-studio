// Admin access, checked on the server for every admin API call:
//  - a session from a one-time sign-in link mailed to ADMIN_EMAIL (Authorization: Bearer <session>), or
//  - Basic credentials, password stored only as a scrypt hash in an env var.
// Only hashes of link and session tokens are stored (admin_tokens).
import { cfg } from './config.js';
import { q, one } from './db.js';
import { checkPassword, safeEqual, httpError, clientIp, sha256 } from './util.js';
import { rateLimit } from './store.js';

export const LOGIN_TTL_MIN = 15;
export const SESSION_TTL_HOURS = 12;

export async function requireAdmin(request) {
  const basicOn = !!(cfg.admin.user && cfg.admin.passwordHash);
  if (!basicOn && !cfg.admin.email) throw httpError(503, 'admin_not_configured');
  const h = request.headers.get('authorization') || '';
  const bearer = /^Bearer\s+([A-Za-z0-9_-]{20,128})$/i.exec(h);
  if (bearer && cfg.admin.email) {
    const s = await one(`SELECT email FROM admin_tokens WHERE token_hash = $1 AND kind = 'session' AND used_at IS NULL AND expires_at > now()`, [sha256(bearer[1])]);
    if (s && s.email === cfg.admin.email) return s.email;     // a changed ADMIN_EMAIL ends older sessions
  }
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (m && basicOn) {
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const i = dec.indexOf(':');
    const user = dec.slice(0, i), pass = dec.slice(i + 1);
    if (i > 0 && safeEqual(user, cfg.admin.user) && checkPassword(pass, cfg.admin.passwordHash)) return user;
  }
  await rateLimit('adminfail:' + sha256(clientIp(request) || 'noip').slice(0, 16), 10);   // slows guessing
  throw httpError(401, 'unauthorized');   // no WWW-Authenticate: the admin page has its own login form
}

export async function endSession(request) {
  const bearer = /^Bearer\s+([A-Za-z0-9_-]{20,128})$/i.exec(request.headers.get('authorization') || '');
  if (bearer) await q(`UPDATE admin_tokens SET used_at = now() WHERE token_hash = $1 AND kind = 'session'`, [sha256(bearer[1])]);
}
