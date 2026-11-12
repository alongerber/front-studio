// Save the customer's contact details (name + phone required, email optional).
import { q } from '../../lib/db.js';
import { json, handle, readJson, clip, httpError } from '../../lib/util.js';
import { ownedOrder, serverEvent, rateLimit } from '../../lib/store.js';
import { cfg } from '../../lib/config.js';
import { flushNotify } from '../../lib/notify.js';

export const POST = handle(async (request) => {
  const b = await readJson(request, 4 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  await rateLimit('contact:' + o.order_id, 20);
  const name = clip(String(b.name || '').trim(), 80), phone = clip(String(b.phone || '').trim(), 20), email = clip(String(b.email || '').trim(), 120);
  if (!name || phone.replace(/\D/g, '').length < 9) throw httpError(400, 'name_and_phone_required');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'invalid_email');
  await q(`UPDATE orders SET contact = $2::jsonb, updated_at = now() WHERE order_id = $1`, [o.order_id, JSON.stringify({ name, phone, email })]);
  await serverEvent('lead_captured', { orderId: o.order_id, sessionId: o.session_id, anonymousId: o.anonymous_id });
  // Payment confirmation + personal link for customers who brief later. Queued once per order; delivered
  // only after the server has verified the payment (see flushNotify). Outside production, only to test addresses.
  if (email && (cfg.environment === 'production' || cfg.make.testRecipients.includes(email.toLowerCase()))) {
    const link = cfg.siteUrl + '/thanks#o=' + encodeURIComponent(o.order_id) + '&t=' + encodeURIComponent(b.token);
    await q(`INSERT INTO notify_outbox (id, action, order_id, secret_link) VALUES ('receipt:' || $1, 'receipt', $1, $2)
             ON CONFLICT (id) DO NOTHING`, [o.order_id, link]);
    try { await flushNotify({ orderId: o.order_id }); } catch (e) { console.error('[notify]', e.message); }
  }
  return json({ ok: true });
});
