// Meital's send_summary tool: email a short summary of the direction, only after the customer asked for it or agreed.
// No phone, no order creation, no payment change. An order is attached only when the page proves it owns it (id + token).
// The answer tells the agent the real state: sent (Make accepted it), queued (will retry), failed, or not_allowed.
import { json, handle, readJson, clip, httpError, clientIp, sha256 } from '../lib/util.js';
import { ownedOrder, rateLimit, serverEvent } from '../lib/store.js';
import { saveSummary, flushSummary, summaryState, summaryRef, retryNow } from '../lib/summary.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const REF = /^[A-Za-z0-9_-]{16,80}$/;

export const POST = handle(async (request) => {
  const b = await readJson(request, 6 * 1024);
  await rateLimit('summary:' + sha256(clientIp(request) || 'noip').slice(0, 16), 5);
  if (!REF.test(String(b.client_ref || ''))) throw httpError(400, 'bad_request');
  const email = clip(String(b.email || '').trim(), 160), direction = clip(String(b.direction || '').trim(), 500);
  if (!EMAIL.test(email)) throw httpError(400, 'invalid_email');
  if (direction.length < 10) throw httpError(400, 'direction_required');
  let order = null;
  if (b.order_id && b.token) { try { order = await ownedOrder(b.order_id, b.token); } catch { order = null; } }
  const saved = await saveSummary({ clientRef: b.client_ref, email, direction, order, sessionId: clip(String(b.session_id || ''), 80) || null });
  if (!saved) throw httpError(409, 'conflict');
  if (saved.duplicate) await retryNow(saved.id);           // the same request asked again: retry it now, never a second email
  else {
    await serverEvent('summary_requested', { eventId: 'summary_requested:' + saved.id, orderId: order ? order.order_id : null, props: { order_attached: !!order } });
  }
  try { await flushSummary({ id: saved.id }); } catch (e) { console.error('[summary notify]', e.message); }
  const s = await summaryState(saved.id);
  const state = ['sent', 'not_allowed', 'failed', 'limited'].includes(s.status) ? s.status : 'queued';
  return json({ ok: true, ref: summaryRef(saved.id), state, duplicate: saved.duplicate, order_attached: !!order });
});
