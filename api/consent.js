// The visitor changed their consent choice after the order existed: the order follows the latest choice.
// Withdrawn ads consent removes the Meta matching data, and nothing is sent to Meta for this order from then on
// (the Meta queue re-checks the order's consent at send time). Withdrawn analytics consent removes the ids.
import { q } from '../lib/db.js';
import { json, handle, readJson, clientIp, clip, isUuid } from '../lib/util.js';
import { ownedOrder, rateLimit, serverEvent } from '../lib/store.js';

export const POST = handle(async (request) => {
  const b = await readJson(request, 4 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  await rateLimit('consent:' + o.order_id, 20);
  const c = { analytics: b.consent && b.consent.analytics === 'granted' ? 'granted' : 'denied',
              ads: b.consent && b.consent.ads === 'granted' ? 'granted' : 'denied' };
  const metaUser = c.ads === 'granted'
    ? { ...(o.meta_user || {}), fbc: clip(b.fbc, 1200) || (o.meta_user && o.meta_user.fbc) || null, fbp: clip(b.fbp, 200) || (o.meta_user && o.meta_user.fbp) || null,
        ip: clientIp(request), ua: clip(request.headers.get('user-agent'), 400) }
    : null;
  const analytics = c.analytics === 'granted';
  await q(`UPDATE orders SET consent = $2::jsonb, meta_user = $3::jsonb,
             anonymous_id = CASE WHEN $4 THEN COALESCE(anonymous_id, $5) ELSE NULL END,
             session_id   = CASE WHEN $4 THEN COALESCE(session_id, $6) ELSE NULL END,
             attribution  = CASE WHEN $4 THEN attribution ELSE NULL END,
             updated_at = now()
           WHERE order_id = $1`,
    [o.order_id, JSON.stringify(c), JSON.stringify(metaUser), analytics, isUuid(b.anonymous_id) ? b.anonymous_id : null, isUuid(b.session_id) ? b.session_id : null]);
  // A Purchase waiting for consent becomes deliverable again (still within Meta's 7-day window, checked at send time).
  if (c.ads === 'granted') await q(`UPDATE meta_outbox SET status = 'pending', next_attempt_at = now() WHERE order_id = $1 AND status = 'no_consent'`, [o.order_id]);
  await serverEvent('consent_changed', { eventId: `consent_changed:${o.order_id}:${Date.now()}`, orderId: o.order_id, props: c });
  return json({ ok: true, consent: c });
});
