// Create the PayPal order for one of our orders. Amount and currency come from the server.
import { q } from '../../lib/db.js';
import { json, handle, readJson, httpError } from '../../lib/util.js';
import { ownedOrder, serverEvent, rateLimit } from '../../lib/store.js';
import { createPaypalOrder } from '../../lib/paypal.js';

export const config = { maxDuration: 15 };

export const POST = handle(async (request) => {
  const b = await readJson(request, 2 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  if (o.paid_at) throw httpError(409, 'already_paid');
  await rateLimit('ppcreate:' + o.order_id, 10);
  // Re-use the PayPal order if we already created one and it was never paid.
  if (o.paypal_order_id) return json({ ok: true, id: o.paypal_order_id, reused: true });
  const pp = await createPaypalOrder(o.order_id);
  await q(`UPDATE orders SET paypal_order_id = $2, status = CASE WHEN status = 'created' THEN 'checkout' ELSE status END, updated_at = now() WHERE order_id = $1`, [o.order_id, pp.id]);
  await serverEvent('checkout_created', { eventId: `checkout_created:${pp.id}`, orderId: o.order_id, sessionId: o.session_id, anonymousId: o.anonymous_id, channel: 'paypal' });
  return json({ ok: true, id: pp.id });
});
