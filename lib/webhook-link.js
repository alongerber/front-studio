// Link stored PayPal webhook rows to their order when the row has no order_id (rows stored before migration 006
// had no such column). Metadata only: the event is NOT processed again, no payment is touched and no message is sent.
// Each event is first read back from PayPal (GET) and must belong to this order.
import { q, one } from './db.js';
import { httpError, isOrderId } from './util.js';
import { getPaypalWebhookEvent, paypalError } from './paypal.js';

export async function linkWebhookEvents(orderId, eventIds, admin) {
  if (!isOrderId(orderId)) throw httpError(400, 'bad_order_id');
  const list = [...new Set((Array.isArray(eventIds) ? eventIds : []).map(String))].filter(id => /^WH-[A-Z0-9-]{6,80}$/.test(id)).slice(0, 20);
  if (!list.length) throw httpError(400, 'no_events');
  const o = await one(`SELECT order_id, paypal_order_id FROM orders WHERE order_id = $1`, [orderId]);
  if (!o) throw httpError(404, 'not_found');
  const caps = (await q(`SELECT capture_id FROM payments WHERE order_id = $1 AND provider = 'paypal'`, [orderId])).map(r => r.capture_id).filter(Boolean);
  const ids = new Set([o.paypal_order_id, ...caps].filter(Boolean));
  const results = [];
  for (const id of list) {
    const row = await one(`SELECT order_id, verified FROM webhook_events WHERE provider = 'paypal' AND event_id = $1`, [id]);
    if (!row) { results.push({ id, result: 'not_received' }); continue; }
    if (!row.verified) { results.push({ id, result: 'not_verified' }); continue; }
    if (row.order_id) { results.push({ id, result: row.order_id === orderId ? 'already_linked' : 'linked_to_other', order_id: row.order_id }); continue; }
    const res = await getPaypalWebhookEvent(id);
    if (!res.ok) { results.push({ id, result: 'paypal_error', error: paypalError(res) }); continue; }
    const r = (res.data && res.data.resource) || {};
    const rel = (r.supplementary_data && r.supplementary_data.related_ids) || {};
    const belongs = ids.has(r.id) || ids.has(rel.order_id) || r.custom_id === orderId || r.invoice_id === orderId;
    if (!belongs) { results.push({ id, result: 'not_this_order', resource_id: r.id || null }); continue; }
    const done = await q(`UPDATE webhook_events SET order_id = $2 WHERE provider = 'paypal' AND event_id = $1 AND order_id IS NULL RETURNING event_id`, [id, orderId]);
    results.push({ id, result: done.length ? 'linked' : 'already_linked', event_type: res.data.event_type || null });
  }
  await q(`INSERT INTO admin_audit (admin_user, action, order_id, details) VALUES ($1,'webhook_link',$2,$3::jsonb)`, [admin, orderId, JSON.stringify({ results })]);
  return { results };
}
