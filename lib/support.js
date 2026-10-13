// "Help with an order": requests saved on our server, shown in the dashboard, and announced to the owner by email
// through the existing Make scenario (action "support"). Saving never depends on the email: the request is stored first.
import { q, one } from './db.js';
import { cfg } from './config.js';
import { clip } from './util.js';
import { notify } from './notify.js';

export const supportRef = (id) => 'P-' + String(id).padStart(5, '0');

export async function saveSupport({ clientRef, email, message, orderId, claimedRef, source }) {
  const ins = await one(
    `INSERT INTO support_requests (client_ref, environment, email, message, order_id, claimed_order_ref, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (client_ref) DO NOTHING RETURNING id`,
    [clientRef, cfg.environment, email, message, orderId || null, claimedRef || null, source || null]);
  if (ins) return { id: ins.id, duplicate: false };
  const prev = await one(`SELECT id FROM support_requests WHERE client_ref = $1 AND environment = $2`, [clientRef, cfg.environment]);
  return prev ? { id: prev.id, duplicate: true } : null;
}

// Deliver owner emails for new requests. Make must answer {"ok":true}; anything else is retried with backoff and
// stays visible in the dashboard. The customer's request is already saved either way.
export async function flushSupport({ id = null, limit = 10 } = {}) {
  const rows = await q(
    `SELECT id, email, message, order_id, claimed_order_ref, source, notify_attempts FROM support_requests
     WHERE notify_status = 'pending' AND notify_next_at <= now() AND environment = $1 AND ($2::bigint IS NULL OR id = $2)
     ORDER BY id LIMIT $3`, [cfg.environment, id, limit]);
  const out = [];
  for (const r of rows) {
    if (!cfg.make.notifyUrl) {
      await q(`UPDATE support_requests SET notify_error = 'not_configured', notify_next_at = now() + interval '1 hour' WHERE id = $1`, [r.id]);
      out.push({ id: r.id, ok: false, error: 'not_configured' }); continue;
    }
    const res = await notify('support', { ref: supportRef(r.id), email: r.email, message: clip(r.message, 2000),
      order: r.order_id || '', order_verified: r.order_id ? '1' : '0', claimed_order: r.claimed_order_ref || '', source: r.source || '',
      environment: cfg.environment });
    const attempts = r.notify_attempts + 1;
    await q(`UPDATE support_requests SET notify_attempts = $2, notify_error = $3,
               notify_status = CASE WHEN $4 THEN 'sent' WHEN $2 >= 10 THEN 'failed' ELSE 'pending' END,
               notify_next_at = now() + make_interval(mins => LEAST(720, power(2, $2)::int)) WHERE id = $1`,
      [r.id, attempts, res.ok ? null : clip(res.reason || ('http_' + res.status), 300), res.ok]);
    out.push({ id: r.id, ok: res.ok, error: res.ok ? null : res.reason });
  }
  return out;
}

export async function openSupport(limit = 50) {
  return q(`SELECT id, email, message, order_id, claimed_order_ref, source, status, notify_status, notify_error, created_at, handled_at, handled_by
            FROM support_requests WHERE environment = $1 ORDER BY (status = 'open') DESC, id DESC LIMIT $2`, [cfg.environment, limit]);
}

export async function closeSupport(id, admin) {
  const r = await one(`UPDATE support_requests SET status = 'done', handled_at = now(), handled_by = $2
                       WHERE id = $1 AND environment = $3 AND status = 'open' RETURNING id`, [id, admin, cfg.environment]);
  if (r) await q(`INSERT INTO admin_audit (admin_user, action, details) VALUES ($1,'support_done',$2::jsonb)`, [admin, JSON.stringify({ id })]);
  return { closed: !!r };
}
