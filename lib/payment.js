// The single place that decides "this order is paid".
// Called from the capture endpoint, the PayPal webhook, admin (manual Bit) and the recovery sweep.
//
// Atomicity: marking the order paid, recording purchase_verified, and queueing the Meta Purchase and the
// "paid" email happen in ONE SQL statement (data-modifying CTEs run in a single transaction).
// Either all of it is stored or none of it is, so a retry can never find "paid, but nothing queued".
import { q, one } from './db.js';
import { cfg } from './config.js';
import { serverEvent } from './store.js';
import { flushOutbox } from './meta.js';
import { flushNotify } from './notify.js';

export const EXPECTED = () => ({ amount: cfg.product.amount, currency: cfg.product.currency });

// Returns {ok, reason}. Checks amount, currency, order linkage and (when configured) the payee.
export function checkCapture(order, capture) {
  const exp = EXPECTED();
  const amt = capture && capture.amount;
  if (!amt || amt.value !== exp.amount || amt.currency_code !== exp.currency) return { ok: false, reason: 'amount_mismatch' };
  if (capture.custom_id && capture.custom_id !== order.order_id) return { ok: false, reason: 'order_mismatch' };
  if (cfg.paypal.merchantId) {
    const m = capture.payee && capture.payee.merchant_id;
    if (m !== cfg.paypal.merchantId) return { ok: false, reason: 'payee_mismatch' };
  }
  return { ok: true, payeeChecked: !!cfg.paypal.merchantId };
}

// The side effects every paid order must have. Shared by markPaid and the recovery sweep.
const SIDE_EFFECTS = `
  ev AS (
    INSERT INTO events (event_id, event_name, occurred_at, anonymous_id, session_id, lead_id, order_id, channel, site_version, environment, props)
    SELECT 'purchase_verified:' || order_id, 'purchase_verified', paid_at, anonymous_id, session_id, order_id, order_id,
           CASE WHEN paid_via = 'bit_manual' THEN 'admin' ELSE 'paypal' END, $3, environment, $4::jsonb
    FROM paid ON CONFLICT (event_id) DO NOTHING RETURNING 1),
  ob AS (
    INSERT INTO meta_outbox (event_id, event_name, order_id, status)
    SELECT order_id, 'Purchase', order_id, 'pending' FROM paid ON CONFLICT (event_id) DO NOTHING RETURNING 1),
  nq AS (
    INSERT INTO notify_outbox (id, action, order_id)
    SELECT 'paid:' || order_id, 'paid', order_id FROM paid ON CONFLICT (id) DO NOTHING RETURNING 1)`;

async function markPaid(orderId, via, props) {
  return one(`
    WITH paid AS (
      UPDATE orders SET status = 'paid', paid_at = now(), paid_via = $2, updated_at = now(),
        brief_started_at = CASE WHEN brief_started_at IS NULL AND brief <> '{}'::jsonb THEN now() ELSE brief_started_at END
      WHERE order_id = $1 AND paid_at IS NULL RETURNING *),
    ${SIDE_EFFECTS}
    SELECT * FROM paid`, [orderId, via, cfg.siteVersion, JSON.stringify(props || {})]);   // null if it was already paid (idempotent)
}

// Re-create any missing side effect for an order that is already paid (used by the recovery sweep).
export async function ensurePaidSideEffects(orderId) {
  return one(`
    WITH paid AS (SELECT * FROM orders WHERE order_id = $1 AND paid_at IS NOT NULL AND status <> 'refunded' AND $2::text = 'recover'),
    ${SIDE_EFFECTS}
    SELECT (SELECT count(*) FROM ev)::int AS ev, (SELECT count(*) FROM ob)::int AS ob, (SELECT count(*) FROM nq)::int AS nq`,
    [orderId, 'recover', cfg.siteVersion, JSON.stringify({ recovered: true })]);
}

// Recovery: the capture is stored as verified (status COMPLETED passed checkCapture) but the order is not paid.
export async function repairCapturedOrder(orderId) {
  const paid = await markPaid(orderId, 'paypal', { provider: 'paypal', source: 'recovery' });
  if (paid) await deliverNow(paid);
  return !!paid;
}

// Best effort, never throws: try to deliver what was just queued. Anything left is retried by the recovery sweep.
async function deliverNow(o) {
  try { if (o.brief_started_at) await serverEvent('brief_started', { orderId: o.order_id, sessionId: o.session_id }); } catch (e) { console.error('[brief_started]', e.message); }
  try { await flushOutbox({ orderId: o.order_id }); } catch (e) { console.error('[meta]', e.message); }
  try { await flushNotify({ orderId: o.order_id }); } catch (e) { console.error('[notify]', e.message); }
}

// Apply a PayPal capture object to our order.
export async function applyCapture(orderId, capture, source) {
  const order = await one(`SELECT * FROM orders WHERE order_id = $1`, [orderId]);
  if (!order) return { ok: false, reason: 'unknown_order' };
  const status = capture.status;
  const check = status === 'COMPLETED' ? checkCapture(order, capture) : { ok: true };
  await q(
    `INSERT INTO payments (order_id, provider, capture_id, status, amount, currency, payee_merchant, raw)
     VALUES ($1,'paypal',$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (capture_id) DO UPDATE SET status = EXCLUDED.status, raw = EXCLUDED.raw`,
    [orderId, capture.id, check.ok ? status : 'REJECTED_' + check.reason, capture.amount && capture.amount.value,
     capture.amount && capture.amount.currency_code, capture.payee && capture.payee.merchant_id || null, JSON.stringify({ source, capture })]);

  if (status === 'COMPLETED') {
    if (!check.ok) {
      await serverEvent('payment_failed', { eventId: `payment_rejected:${capture.id}`, orderId, props: { reason: check.reason } });
      return { ok: false, reason: check.reason };
    }
    const paid = await markPaid(orderId, 'paypal', { provider: 'paypal', source, payee_checked: check.payeeChecked });
    if (paid) await deliverNow(paid);
    const now = paid || await one(`SELECT status FROM orders WHERE order_id = $1`, [orderId]);
    return { ok: true, paid: now.status === 'paid' || now.status === 'partially_refunded', first: !!paid, status: now.status };
  }
  if (status === 'PENDING') {
    await q(`UPDATE orders SET status = 'pending', updated_at = now() WHERE order_id = $1 AND paid_at IS NULL`, [orderId]);
    await serverEvent('payment_pending', { eventId: `payment_pending:${capture.id}`, orderId, props: { reason: capture.status_details && capture.status_details.reason || null } });
    return { ok: true, paid: false, pending: true };
  }
  if (status === 'DECLINED' || status === 'FAILED') {
    await q(`UPDATE orders SET status = 'failed', updated_at = now() WHERE order_id = $1 AND paid_at IS NULL`, [orderId]);
    await serverEvent('payment_failed', { eventId: `payment_failed:${capture.id}`, orderId, props: { status } });
    return { ok: true, paid: false };
  }
  return { ok: true, ignored: status };
}

// Refund (full or partial) reported by PayPal. A full refund ends the order: it is no longer "paid".
// "Full" is decided by the total of all refunds on the order, so partial refunds that add up to the whole
// amount end it too. A refund without an amount (a reversal / chargeback) counts as full.
export async function applyRefund(orderId, refund) {
  const order = await one(`SELECT * FROM orders WHERE order_id = $1`, [orderId]);
  if (!order) return { ok: false, reason: 'unknown_order' };
  const refunded = Number(refund.amount && refund.amount.value || 0);
  const fresh = await q(`INSERT INTO payments (order_id, provider, capture_id, status, amount, currency, raw)
           VALUES ($1,'paypal',$2,'REFUND',$3,$4,$5::jsonb) ON CONFLICT (capture_id) DO NOTHING RETURNING 1`,
    [orderId, 'refund:' + refund.id, refunded > 0 ? refunded : null, refund.amount && refund.amount.currency_code || order.currency, JSON.stringify(refund)]);
  const tot = await one(`SELECT COALESCE(sum(amount), 0)::float8 AS total, bool_or(amount IS NULL) AS unknown
                         FROM payments WHERE order_id = $1 AND capture_id LIKE 'refund:%'`, [orderId]);
  const full = !!tot.unknown || tot.total >= Number(order.amount) - 0.001;
  const status = full ? 'refunded' : 'partially_refunded';
  if (fresh.length) await q(`UPDATE payments SET status = $2 WHERE capture_id = $1`, ['refund:' + refund.id, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED']);
  await q(`UPDATE orders SET status = $2, updated_at = now() WHERE order_id = $1 AND (status <> 'refunded')`, [orderId, status]);
  // A Purchase that was not sent yet is not sent at all after a full refund.
  if (full) await q(`UPDATE meta_outbox SET status = 'cancelled_refund' WHERE order_id = $1 AND status IN ('pending','no_consent')`, [orderId]);
  // Nor is a queued email: no "paid" note and no "go to production" for money that went back.
  if (full) await q(`UPDATE notify_outbox SET status = 'cancelled_refund', secret_link = NULL WHERE order_id = $1 AND status = 'pending'`, [orderId]);
  await serverEvent('payment_refunded', { eventId: `payment_refunded:${refund.id}`, orderId, props: { status, amount: refunded || null, total_refunded: tot.total } });
  return { ok: true, paid: !full, refunded: full, status };
}

// Manual Bit verification by an authenticated admin, with an audit trail. One statement: payment row,
// audit row, paid order, purchase event and queued messages are stored together or not at all.
export async function applyManual(orderId, adminUser, reference, note) {
  const order = await one(`SELECT * FROM orders WHERE order_id = $1`, [orderId]);
  if (!order) return { ok: false, reason: 'unknown_order' };
  if (!reference || String(reference).trim().length < 3) return { ok: false, reason: 'reference_required' };
  if (order.paid_at) return { ok: true, paid: order.status === 'paid', first: false };
  const ref = String(reference).trim().slice(0, 120);
  const paid = await one(`
    WITH pay AS (
      INSERT INTO payments (order_id, provider, status, amount, currency, verified_by, reference, raw)
      SELECT order_id, 'bit_manual', 'MANUAL_OK', amount, currency, $5, $6, $7::jsonb FROM orders WHERE order_id = $1 AND paid_at IS NULL RETURNING 1),
    aud AS (
      INSERT INTO admin_audit (admin_user, action, order_id, details)
      SELECT $5, 'verify_manual_payment', $1, $8::jsonb FROM pay RETURNING 1),
    man AS (
      INSERT INTO events (event_id, event_name, occurred_at, order_id, lead_id, channel, site_version, environment, props)
      SELECT 'purchase_manual_verified:' || $1, 'purchase_manual_verified', now(), $1, $1, 'admin', $3, environment, $9::jsonb
      FROM orders WHERE order_id = $1 AND EXISTS (SELECT 1 FROM pay) ON CONFLICT (event_id) DO NOTHING RETURNING 1),
    paid AS (
      UPDATE orders SET status = 'paid', paid_at = now(), paid_via = $2, updated_at = now(),
        brief_started_at = CASE WHEN brief_started_at IS NULL AND brief <> '{}'::jsonb THEN now() ELSE brief_started_at END
      WHERE order_id = $1 AND paid_at IS NULL AND EXISTS (SELECT 1 FROM pay) RETURNING *),
    ${SIDE_EFFECTS}
    SELECT * FROM paid`,
    [orderId, 'bit_manual', cfg.siteVersion, JSON.stringify({ provider: 'bit_manual' }), adminUser, ref,
     JSON.stringify({ note: note || null }), JSON.stringify({ reference: ref, note: note || null }), JSON.stringify({ verified_by: adminUser })]);
  if (paid) await deliverNow(paid);
  return { ok: true, paid: true, first: !!paid };
}
