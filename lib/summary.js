// Conversation summary by email (Meital's send_summary tool). Sent through the existing Make scenario (action "summary").
// Outside production only the test recipients may receive it (same rule as the receipt email); other addresses are
// stored as not_allowed and never sent. "sent" means Make confirmed the hand-off to the mail service, not that it
// reached the inbox.
import { q, one } from './db.js';
import { cfg } from './config.js';
import { clip } from './util.js';
import { notify, briefSummary } from './notify.js';

export const summaryRef = (id) => 'S-' + String(id).padStart(5, '0');

export function allowedRecipient(email) {
  return cfg.environment === 'production' || cfg.make.testRecipients.includes(String(email || '').toLowerCase());
}

// Links are removed from what Meital wrote: a summary must not become a way to mail someone a link from our address.
export function cleanDirection(text) {
  return String(text || '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[קישור הוסר]')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/\S*)?/gi, '[קישור הוסר]');
}

// Abuse limits (the endpoint is public): one address gets at most PER_ADDRESS summaries a day, and the whole site at most
// DAILY_CAP. Over a limit the request is stored as 'limited' and never sent.
const PER_ADDRESS = 2;
const dailyCap = () => Math.max(1, Number(process.env.SUMMARY_DAILY_CAP || 50));
async function overLimit(email) {
  const r = await one(`SELECT count(*) FILTER (WHERE lower(email) = lower($2))::int AS addr, count(*)::int AS total
    FROM summary_requests WHERE environment = $1 AND status IN ('pending', 'sent', 'failed') AND created_at > now() - interval '24 hours'`,
    [cfg.environment, email]);
  return r.addr >= PER_ADDRESS || r.total >= dailyCap();
}

export async function saveSummary({ clientRef, email, direction, order, sessionId }) {
  const facts = order && order.brief && Object.keys(order.brief).length ? clip(cleanDirection(briefSummary(order.brief)), 1500) : null;
  direction = cleanDirection(direction);
  const known = await one(`SELECT id FROM summary_requests WHERE client_ref = $1 AND environment = $2`, [clientRef, cfg.environment]);
  if (known) return { id: known.id, duplicate: true };          // the same request again: never a second row or email
  const status = !allowedRecipient(email) ? 'not_allowed' : (await overLimit(email)) ? 'limited' : 'pending';
  const ins = await one(
    `INSERT INTO summary_requests (client_ref, environment, email, direction, facts, order_id, session_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (client_ref) DO NOTHING RETURNING id`,
    [clientRef, cfg.environment, email, direction, facts, order ? order.order_id : null, sessionId || null, status]);
  const row = ins || await one(`SELECT id FROM summary_requests WHERE client_ref = $1 AND environment = $2`, [clientRef, cfg.environment]);
  return row ? { id: row.id, duplicate: !ins } : null;
}

export async function retryNow(id) {
  await q(`UPDATE summary_requests SET next_attempt_at = now() WHERE id = $1 AND environment = $2 AND status = 'pending'`, [id, cfg.environment]);
}

export async function summaryState(id) {
  return one(`SELECT id, status, attempts, last_error FROM summary_requests WHERE id = $1 AND environment = $2`, [id, cfg.environment]);
}

// Deliver due summaries. Backoff 2, 4, 8 … minutes, capped at 12 hours; gives up after 6 attempts.
export async function flushSummary({ id = null, limit = 10 } = {}) {
  const rows = await q(
    `SELECT id, email, direction, facts, attempts FROM summary_requests
     WHERE status = 'pending' AND next_attempt_at <= now() AND environment = $1 AND ($2::bigint IS NULL OR id = $2)
     ORDER BY id LIMIT $3`, [cfg.environment, id, limit]);
  const out = [];
  for (const r of rows) {
    if (!cfg.make.notifyUrl) {
      await q(`UPDATE summary_requests SET last_error = 'not_configured', next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [r.id]);
      out.push({ id: r.id, ok: false, error: 'not_configured' }); continue;
    }
    const res = await notify('summary', { ref: summaryRef(r.id), email: r.email, direction: clip(r.direction, 500),
      facts: r.facts || '', site: cfg.siteUrl, environment: cfg.environment });
    const attempts = r.attempts + 1;
    await q(`UPDATE summary_requests SET attempts = $2, last_error = $3,
               status = CASE WHEN $4 THEN 'sent' WHEN $2 >= 6 THEN 'failed' ELSE 'pending' END,
               sent_at = CASE WHEN $4 THEN now() ELSE sent_at END,
               next_attempt_at = now() + make_interval(mins => LEAST(720, power(2, $2)::int)) WHERE id = $1`,
      [r.id, attempts, res.ok ? null : clip(res.reason || ('http_' + res.status), 300), res.ok]);
    out.push({ id: r.id, ok: res.ok, error: res.ok ? null : res.reason });
  }
  return out;
}
