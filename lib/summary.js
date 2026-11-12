// Conversation summary by email (Meital's send_summary tool). Sent through the existing Make scenario (action "summary").
// Outside production only the test recipients may receive it (same rule as the receipt email); other addresses are
// stored as not_allowed and never sent. "sent" means Make confirmed the hand-off to the mail service, not that it
// reached the inbox.
import { q, one, transaction } from './db.js';
import { cfg } from './config.js';
import { clip, sha256 } from './util.js';
import { notify } from './notify.js';

export const summaryRef = (id) => 'S-' + String(id).padStart(5, '0');

export function allowedRecipient(email) {
  return cfg.environment === 'production' || cfg.make.testRecipients.includes(String(email || '').toLowerCase());
}

// Links are removed from customer text: a summary must not become a way to mail someone a link from our address.
export function cleanText(text) {
  return String(text || '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[קישור הוסר]')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/\S*)?/gi, '[קישור הוסר]')
    .replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

// The only content an email can carry: the order's saved facts, from a fixed list, in a fixed order. Nothing from the
// request. Contact details, avoid-lists and free notes stay out (they are for production, not for a mailed summary).
const FACTS = [['business_type', 'העסק'], ['business_name', 'שם העסק'], ['promote', 'מה מקדמים'], ['goal', 'מה רוצים להשיג'],
  ['audience', 'קהל'], ['tone', 'טון']];
export function summaryContent(brief) {
  brief = brief || {};
  const facts = FACTS.filter(([k]) => brief[k]).map(([k, l]) => l + ': ' + clip(cleanText(brief[k]), 160)).join('\n');
  const direction = brief.liked_direction ? clip(cleanText(brief.liked_direction), 240) : '';
  if (!direction) return null;                    // a summary is of a direction the customer liked; without one there is nothing to send
  return { facts, direction };
}

// Abuse limits: an order may send to at most PER_ORDER addresses, one address gets at most PER_ADDRESS summaries a day,
// and the whole site at most DAILY_CAP. Over a limit the request is stored as 'limited' and never sent.
const PER_ORDER = 2, PER_ADDRESS = 2;
const dailyCap = () => {
  const n = Number(process.env.SUMMARY_DAILY_CAP || 50);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1; // a malformed explicit cap fails closed
};

// One request per order + address (the key is made here, never by the page): repeating it, or retrying after a failure,
// is the same row and at most one email.
export async function saveSummary({ order, email, content, sessionId }) {
  const ref = 'o:' + order.order_id + ':' + sha256(email.toLowerCase()).slice(0, 24);
  const known = await one(`SELECT id FROM summary_requests WHERE client_ref = $1 AND environment = $2`, [ref, cfg.environment]);
  if (known) return { id: known.id, duplicate: true };
  // All reservations in one environment share the lock, including requests handled by other serverless workers.
  // Keep lock and insert in separate statements: a lock in an INSERT CTE would leave its count on a stale snapshot.
  const [, inserted] = await transaction([
    { text: `SELECT pg_advisory_xact_lock(1179799124, hashtext($1))`, params: [cfg.environment] },
    { text: `INSERT INTO summary_requests (client_ref, environment, email, direction, facts, order_id, session_id, status)
      SELECT $1,$2,$3,$4,$5,$6,$7,
        CASE WHEN NOT $8::boolean THEN 'not_allowed'
          WHEN count(*) FILTER (WHERE lower(email) = lower($3) AND created_at > now() - interval '24 hours') >= $9::bigint
            OR count(*) FILTER (WHERE order_id = $6) >= $10::bigint
            OR count(*) FILTER (WHERE created_at > now() - interval '24 hours') >= $11::bigint THEN 'limited'
          ELSE 'pending' END
      FROM summary_requests WHERE environment = $2 AND status IN ('pending', 'sent', 'failed')
      ON CONFLICT (client_ref) DO NOTHING RETURNING id`,
      params: [ref, cfg.environment, email, content.direction, content.facts || null, order.order_id,
        sessionId || null, allowedRecipient(email), PER_ADDRESS, PER_ORDER, dailyCap()] },
  ]);
  const ins = inserted[0];
  const row = ins || await one(`SELECT id FROM summary_requests WHERE client_ref = $1 AND environment = $2`, [ref, cfg.environment]);
  return row ? { id: row.id, duplicate: !ins } : null;
}

export async function retryNow(id) {
  await q(`UPDATE summary_requests SET next_attempt_at = now() WHERE id = $1 AND environment = $2 AND status = 'pending'
    AND (last_error IS DISTINCT FROM 'delivery_in_progress' OR next_attempt_at <= now())`, [id, cfg.environment]);
}

export async function summaryState(id) {
  return one(`SELECT id, status, attempts, last_error FROM summary_requests WHERE id = $1 AND environment = $2`, [id, cfg.environment]);
}

// Deliver due summaries. Backoff 2, 4, 8 … minutes, capped at 12 hours; gives up after 6 attempts.
export async function flushSummary({ id = null, limit = 10 } = {}) {
  const rows = await q(
    `WITH due AS (SELECT id FROM summary_requests
     WHERE status = 'pending' AND next_attempt_at <= now() AND environment = $1 AND ($2::bigint IS NULL OR id = $2)
     ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED)
     UPDATE summary_requests s SET next_attempt_at = now() + interval '5 minutes', last_error = 'delivery_in_progress'
     FROM due WHERE s.id = due.id
     RETURNING s.id, s.email, s.direction, s.facts, s.attempts`, [cfg.environment, id, limit]);
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
