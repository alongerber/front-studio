// Capture after the buyer approved in PayPal. Approval is not payment: only a COMPLETED capture is.
import { json, handle, readJson, httpError } from '../../lib/util.js';
import { ownedOrder, serverEvent } from '../../lib/store.js';
import { capturePaypalOrder, getPaypalOrder, capturesOf } from '../../lib/paypal.js';
import { applyCapture } from '../../lib/payment.js';

export const config = { maxDuration: 20 };

export const POST = handle(async (request) => {
  const b = await readJson(request, 2 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  if (!o.paypal_order_id || b.paypal_order_id !== o.paypal_order_id) throw httpError(409, 'paypal_order_mismatch');
  await serverEvent('payment_approved', { eventId: `payment_approved:${o.paypal_order_id}`, orderId: o.order_id, sessionId: o.session_id, channel: 'paypal', props: { via: 'onApprove' } });

  let res = await capturePaypalOrder(o.paypal_order_id);
  let order = res.data;
  // Already captured (e.g. by the webhook path) → read the order instead of failing.
  if (!res.ok && res.status === 422) order = await getPaypalOrder(o.paypal_order_id);
  else if (!res.ok) throw httpError(502, 'capture_failed');

  const caps = capturesOf(order);
  if (!caps.length) return json({ ok: true, paid: false, status: order && order.status || 'UNKNOWN' });
  let result = null;
  for (const c of caps) result = await applyCapture(o.order_id, c, 'capture_endpoint');
  return json({ ok: true, paid: !!(result && result.paid), pending: !!(result && result.pending), reason: result && result.reason || null });
});
