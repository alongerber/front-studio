// "Help with an order" from the site. Works without Meital and without any paid conversation.
// An order is attached only from a verified order page (order id + its token). A number typed by hand is stored as
// text and grants nothing: the answer never contains order details. Saved before anything is sent; a repeated send
// (same client_ref) returns the same request.
import { json, handle, readJson, clip, httpError, isUuid, clientIp, sha256, isOrderId } from '../lib/util.js';
import { ownedOrder, rateLimit, serverEvent } from '../lib/store.js';
import { saveSupport, flushSupport, supportRef } from '../lib/support.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export const POST = handle(async (request) => {
  const b = await readJson(request, 8 * 1024);
  await rateLimit('support:' + sha256(clientIp(request) || 'noip').slice(0, 16), 5);
  if (!isUuid(b.client_ref)) throw httpError(400, 'bad_request');
  const email = clip(String(b.email || '').trim(), 160), message = clip(String(b.message || '').trim(), 3000);
  if (!EMAIL.test(email)) throw httpError(400, 'invalid_email');
  if (message.length < 5) throw httpError(400, 'message_required');
  let orderId = null, claimed = null;
  if (b.order_id && b.token) {
    try { orderId = (await ownedOrder(b.order_id, b.token)).order_id; }
    catch { claimed = isOrderId(b.order_id) ? b.order_id : null; }        // not verified: kept as a claim only
  }
  if (!orderId && b.order_ref) claimed = clip(String(b.order_ref).trim().toUpperCase(), 40) || null;
  const saved = await saveSupport({ clientRef: b.client_ref, email, message, orderId, claimedRef: claimed,
    source: ['home', 'thanks', 'agent'].includes(b.source) ? b.source : null });
  if (!saved) throw httpError(409, 'conflict');
  if (!saved.duplicate) {
    await serverEvent('support_requested', { eventId: 'support_requested:' + saved.id, orderId, props: { verified_order: !!orderId, source: b.source || null } });
    try { await flushSupport({ id: saved.id }); } catch (e) { console.error('[support notify]', e.message); }
  }
  return json({ ok: true, saved: true, ref: supportRef(saved.id), order_attached: !!orderId });
});
