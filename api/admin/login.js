// Admin sign-in without a password: a one-time link (15 minutes) mailed to ADMIN_EMAIL, exchanged for a session (12 hours).
// The link carries the token in the fragment (#login=…), so it never reaches a server log or a Referer.
import { cfg } from '../../lib/config.js';
import { q, one } from '../../lib/db.js';
import { json, handle, readJson, httpError, clientIp, sha256, newToken } from '../../lib/util.js';
import { rateLimit } from '../../lib/store.js';
import { notify } from '../../lib/notify.js';
import { endSession, LOGIN_TTL_MIN, SESSION_TTL_HOURS } from '../../lib/admin.js';

export const POST = handle(async (request) => {
  const b = await readJson(request, 2 * 1024);
  const ip = sha256(clientIp(request) || 'noip').slice(0, 16);

  if (b.action === 'request') {
    await rateLimit('adminlink:' + ip, 5);
    if (!cfg.admin.email) return json({ ok: false, error: 'admin_not_configured' }, 503);   // said plainly: 5xx errors are masked
    const email = String(b.email || '').trim().toLowerCase();
    // Same answer for any address; only the configured one receives a link.
    if (email !== cfg.admin.email) return json({ ok: true });
    await rateLimit('adminlink:sent', 5);
    const token = newToken();
    await q(`INSERT INTO admin_tokens (token_hash, kind, email, expires_at) VALUES ($1, 'login', $2, now() + make_interval(mins => $3))`,
      [sha256(token), email, LOGIN_TTL_MIN]);
    const res = await notify('admin_login', { email, link: cfg.siteUrl + '/admin#login=' + token, minutes: LOGIN_TTL_MIN, environment: cfg.environment });
    if (!res.ok) {
      await q(`DELETE FROM admin_tokens WHERE token_hash = $1`, [sha256(token)]);
      console.error('[admin_login] send failed', res.reason || res.status);
      return json({ ok: false, error: 'send_failed' }, 503);
    }
    return json({ ok: true });
  }

  if (b.action === 'redeem') {
    await rateLimit('adminredeem:' + ip, 10);
    const t = String(b.token || '');
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(t)) throw httpError(401, 'link_invalid');
    const row = await one(`UPDATE admin_tokens SET used_at = now()
                           WHERE token_hash = $1 AND kind = 'login' AND used_at IS NULL AND expires_at > now() RETURNING email`, [sha256(t)]);
    if (!row || row.email !== cfg.admin.email) throw httpError(401, 'link_invalid');
    const session = newToken();
    await q(`INSERT INTO admin_tokens (token_hash, kind, email, expires_at) VALUES ($1, 'session', $2, now() + make_interval(hours => $3))`,
      [sha256(session), row.email, SESSION_TTL_HOURS]);
    return json({ ok: true, session, hours: SESSION_TTL_HOURS });
  }

  if (b.action === 'logout') { await endSession(request); return json({ ok: true }); }
  throw httpError(400, 'bad_action');
});
