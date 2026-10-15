// Meital's send_summary tool: email a short summary of what was said, only after the customer asked for it or agreed.
// The request is bound to an authorised conversation: the page must prove it owns the order (id + token) AND that this
// tab's conversation key is attached to that order. The email is built only from what is saved on that order, in a fixed
// template: the request names the recipient and nothing else (any text it sends is ignored). No phone, no order created
// here, no payment change. The answer tells the agent the real state: sent (Make accepted it), queued, failed,
// not_allowed (test environment) or limited (abuse limits).
import { json, handle, readJson, clip, httpError, clientIp, sha256 } from '../lib/util.js';
import { ownedOrder, rateLimit, serverEvent, isLinkKey } from '../lib/store.js';
import { saveSummary, flushSummary, summaryState, summaryRef, retryNow, summaryContent } from '../lib/summary.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export const POST = handle(async (request) => {
  const b = await readJson(request, 4 * 1024);
  await rateLimit('summary:' + sha256(clientIp(request) || 'noip').slice(0, 16), 10);
  const email = clip(String(b.email || '').trim(), 160);
  if (!EMAIL.test(email)) throw httpError(400, 'invalid_email');
  let order;
  try { order = await ownedOrder(b.order_id, b.token); } catch { throw httpError(403, 'not_authorized'); }
  if (!isLinkKey(b.link) || !(order.agent_links || []).includes(b.link)) throw httpError(403, 'not_authorized');
  const content = summaryContent(order.brief);
  if (!content) throw httpError(409, 'nothing_to_send');
  const saved = await saveSummary({ order, email, content, sessionId: clip(String(b.session_id || ''), 80) || null });
  if (!saved) throw httpError(409, 'conflict');
  if (saved.duplicate) await retryNow(saved.id);           // the same order + address again: retry it now, never a second email
  else await serverEvent('summary_requested', { eventId: 'summary_requested:' + saved.id, orderId: order.order_id, props: {} });
  try { await flushSummary({ id: saved.id }); } catch (e) { console.error('[summary notify]', e.message); }
  const s = await summaryState(saved.id);
  const state = ['sent', 'not_allowed', 'failed', 'limited'].includes(s.status) ? s.status : 'queued';
  return json({ ok: true, ref: summaryRef(saved.id), state, duplicate: saved.duplicate });
});
