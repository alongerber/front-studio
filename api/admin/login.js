// Admin sign-in: a one-time link (15 minutes) mailed to ADMIN_EMAIL, or the owner's email + password (set or reset only
// right after a link sign-in). Either is exchanged for a session cookie (12 hours and this browser session, or 30 days with "remember me").
// The link carries the token in the fragment (#login=…), so it never reaches a server log or a Referer.
import { cfg } from '../../lib/config.js';
import { q, one } from '../../lib/db.js';
import { json, handle, readJson, httpError, clientIp, sha256, newToken, checkPassword, hashPassword } from '../../lib/util.js';
import { rateLimit } from '../../lib/store.js';
import { notify } from '../../lib/notify.js';
import { endSession, newSession, requireAdmin, clearCookie, currentSession, LOGIN_TTL_MIN, SET_PASSWORD_WINDOW_MIN } from '../../lib/admin.js';

// Compared against when no password is stored, so a missing account answers as slowly as a wrong password.
const DUMMY = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(64);
const freshLink = (s) => !!s && s.origin === 'link' && Date.now() - new Date(s.created_at).getTime() < SET_PASSWORD_WINDOW_MIN * 60000;

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
    const s = await newSession(row.email, !!b.remember, 'link');
    return json({ ok: true, hours: s.hours, remembered: !!b.remember }, 200, { 'set-cookie': s.cookie });
  }

  // Username + password (Basic) is checked once and exchanged for the same kind of cookie session:
  // the page never keeps the password, not even for this tab.
  if (b.action === 'password') {
    const who = await requireAdmin(request);
    const s = await newSession(cfg.admin.email || who, !!b.remember, 'basic');
    return json({ ok: true, hours: s.hours, remembered: !!b.remember }, 200, { 'set-cookie': s.cookie });
  }

  // Email + the owner's own password (set from the mailed link). Same answer for every failure; slowed per IP.
  if (b.action === 'login') {
    await rateLimit('adminpw:' + ip, 5);
    await rateLimit('adminpw:all', 30);
    if (!cfg.admin.email) return json({ ok: false, error: 'admin_not_configured' }, 503);
    const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    const cred = email === cfg.admin.email ? await one(`SELECT password_hash FROM admin_credentials WHERE email = $1`, [email]) : null;
    const ok = checkPassword(pw, cred ? cred.password_hash : DUMMY) && !!cred;
    if (!ok) throw httpError(401, 'invalid_login');
    const s = await newSession(email, !!b.remember, 'password');
    await q(`INSERT INTO admin_audit (admin_user, action) VALUES ($1, 'sign_in_password')`, [email]);
    return json({ ok: true, hours: s.hours, remembered: !!b.remember }, 200, { 'set-cookie': s.cookie });
  }

  // What the signed-in owner may do with the password right now (no secrets in the answer).
  if (b.action === 'status') {
    const who = await requireAdmin(request);
    const sess = await currentSession(request);
    const has = !!(await one(`SELECT 1 AS x FROM admin_credentials WHERE email = $1`, [cfg.admin.email || who]));
    return json({ ok: true, has_password: has, can_set_password: freshLink(sess), window_minutes: SET_PASSWORD_WINDOW_MIN });
  }

  // First password or reset: only from a session opened by the one-time mailed link, within 15 minutes of it.
  // Setting it signs out every other session (other devices must sign in again).
  if (b.action === 'set_password') {
    const who = await requireAdmin(request);
    const sess = await currentSession(request);
    if (!freshLink(sess)) throw httpError(403, 'link_session_required');
    const pw = String(b.password || '');
    if (pw.length < 10 || pw.length > 200) throw httpError(400, 'password_length');
    await q(`INSERT INTO admin_credentials (email, password_hash) VALUES ($1, $2)
             ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`, [sess.email, hashPassword(pw)]);
    await q(`UPDATE admin_tokens SET used_at = now() WHERE kind = 'session' AND email = $1 AND token_hash <> $2 AND used_at IS NULL`, [sess.email, sess.token_hash]);
    await q(`INSERT INTO admin_audit (admin_user, action) VALUES ($1, 'password_set')`, [who]);
    return json({ ok: true });
  }

  // Sign out everywhere: every session of the owner ends now (including this one).
  if (b.action === 'logout_all') {
    const who = await requireAdmin(request);
    await q(`UPDATE admin_tokens SET used_at = now() WHERE kind = 'session' AND email = $1 AND used_at IS NULL`, [cfg.admin.email || who]);
    await q(`INSERT INTO admin_audit (admin_user, action) VALUES ($1, 'logout_all')`, [who]);
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  if (b.action === 'logout') { await endSession(request); return json({ ok: true }, 200, { 'set-cookie': clearCookie() }); }
  throw httpError(400, 'bad_action');
});
