// Email notifications through Make, delivered from a durable queue (notify_outbox).
// A message counts as sent only when the Make scenario answers {"ok":true}; anything else is retried.
import { q } from './db.js';
import { cfg } from './config.js';
import { clip } from './util.js';
import { BRIEF_FIELDS } from './store.js';

const LABEL = { business_type: 'סוג העסק', business_name: 'שם העסק', promote: 'מה מקדמים', audience: 'למי זה מיועד', customer_questions: 'מה לקוחות שואלים',
  past_experience: 'ניסיון קודם', concern: 'חשש שעלה', avoid: 'מה לא להגיד', call_to_action: 'מה הצופה צריך לעשות', tone: 'טון', contact_details: 'פרטים בפרסומת', other: 'עוד' };

export function briefSummary(brief) {
  brief = brief || {};
  return BRIEF_FIELDS.filter(k => brief[k]).map(k => `${LABEL[k] || k}: ${brief[k]}`).join('\n') || '(לא נשמרו פרטים)';
}

// Low level: one POST to Make. Never throws.
export async function notify(action, data) {
  if (!cfg.make.notifyUrl) return { ok: false, reason: 'not_configured' };
  try {
    const body = new URLSearchParams({ a: action, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v == null ? '' : String(v)])) });
    const r = await fetch(cfg.make.notifyUrl, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const text = await r.text().catch(() => '');
    let confirmed = false; try { confirmed = JSON.parse(text).ok === true; } catch {}
    // Make answers "Accepted" when no route handled the call (scenario off or route missing): that is not a delivery.
    return confirmed && r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, reason: 'not_confirmed:' + clip(text, 80) };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function payloadFor(row, o) {
  if (row.action === 'paid') return { order: o.order_id, via: o.paid_via, amount: o.amount, currency: o.currency, environment: o.environment };
  if (row.action === 'receipt') {
    const c = o.contact || {};
    if (!c.email || !row.secret_link) return null;
    return { order: o.order_id, name: c.name, email: c.email, amount: o.amount, currency: o.currency, link: row.secret_link,
      delivery: cfg.deliveryTime, environment: o.environment };
  }
  if (row.action === 'finish') {
    const brief = o.brief || {}, c = o.contact || {};
    return { order: o.order_id, name: c.name, phone: c.phone, email: c.email || '', business: brief.business_name || brief.business_type || '',
      summary: clip(briefSummary(brief), 4000), brief: JSON.stringify(brief).slice(0, 6000), paid: o.status === 'paid' ? '1' : '0', environment: o.environment };
  }
  return null;
}

// Deliver due messages. Backoff: 2, 4, 8 … minutes, capped at 12 hours; gives up after 10 attempts (visible in the dashboard).
export async function flushNotify({ orderId = null, limit = 20 } = {}) {
  const rows = await q(
    `SELECT n.id, n.action, n.attempts, n.secret_link, to_jsonb(o) AS ord FROM notify_outbox n LEFT JOIN orders o ON o.order_id = n.order_id
     WHERE n.status = 'pending' AND n.next_attempt_at <= now() AND ($1::text IS NULL OR n.order_id = $1)
       AND (o.environment IS NULL OR o.environment = $3)
       AND (n.action <> 'receipt' OR o.status IN ('paid', 'partially_refunded', 'refunded'))   -- a receipt waits for the verified payment
     ORDER BY n.created_at LIMIT $2`, [orderId, limit, cfg.environment]);
  const results = [];
  for (const r of rows) {
    if (!cfg.make.notifyUrl) {                       // not configured yet: keep the message, don't burn attempts
      await q(`UPDATE notify_outbox SET last_error = 'not_configured', next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [r.id]);
      results.push({ id: r.id, ok: false, error: 'not_configured' }); continue;
    }
    const o = typeof r.ord === 'string' ? JSON.parse(r.ord) : r.ord;
    if (o && o.status === 'refunded') {                // refunded after it was queued: never deliver it
      await q(`UPDATE notify_outbox SET status = 'cancelled_refund', last_error = 'refunded', secret_link = NULL WHERE id = $1`, [r.id]);
      results.push({ id: r.id, ok: false, error: 'refunded' }); continue;
    }
    const data = o && payloadFor(r, o);
    const res = data ? await notify(r.action, data) : { ok: false, reason: o ? 'unknown_action' : 'order_missing' };
    const attempts = r.attempts + 1;
    await q(`UPDATE notify_outbox SET attempts = $2, last_error = $3,
               status = CASE WHEN $4 THEN 'sent' WHEN $2 >= 10 THEN 'failed' ELSE 'pending' END,
               sent_at = CASE WHEN $4 THEN now() ELSE sent_at END,
               secret_link = CASE WHEN $4 OR $2 >= 10 THEN NULL ELSE secret_link END,
               next_attempt_at = now() + make_interval(mins => LEAST(720, power(2, $2)::int))
             WHERE id = $1`, [r.id, attempts, res.ok ? null : clip(res.reason || ('http_' + res.status), 300), res.ok]);
    results.push({ id: r.id, ok: res.ok, error: res.ok ? null : res.reason });
  }
  return results;
}
