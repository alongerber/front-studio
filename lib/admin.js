// Admin access: Basic credentials over HTTPS (sent by admin.html), password stored only as a scrypt hash in an env var.
import { cfg } from './config.js';
import { checkPassword, safeEqual, httpError, clientIp, sha256 } from './util.js';
import { rateLimit } from './store.js';

export async function requireAdmin(request) {
  if (!cfg.admin.user || !cfg.admin.passwordHash) throw httpError(503, 'admin_not_configured');
  const h = request.headers.get('authorization') || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (m) {
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const i = dec.indexOf(':');
    const user = dec.slice(0, i), pass = dec.slice(i + 1);
    if (i > 0 && safeEqual(user, cfg.admin.user) && checkPassword(pass, cfg.admin.passwordHash)) return user;
  }
  await rateLimit('adminfail:' + sha256(clientIp(request) || 'noip').slice(0, 16), 10);   // slows guessing
  throw httpError(401, 'unauthorized');   // no WWW-Authenticate: the admin page has its own login form
}
