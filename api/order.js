// POST: create an order before checkout (or when the brief needs a home).
// GET:  read an order — only with its token (X-Order-Token header).
import { cfg } from '../lib/config.js';
import { json, handle, readJson, clientIp, clip, isUuid, httpError } from '../lib/util.js';
import { createOrder, ownedOrder, publicOrder, rateLimit, attachAgentLink } from '../lib/store.js';

function cleanTouch(t) {
  if (!t || typeof t !== 'object') return null;
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign_id', 'adset_id', 'ad_id', 'referrer_host', 'landing_path', 'ts'];
  const o = {}; for (const k of keys) if (t[k] != null) o[k] = clip(t[k], 500);
  if (t.fbclid) o.fbclid = clip(t.fbclid, 1000);   // click ids are never cut short
  return o;
}

export const POST = handle(async (request) => {
  const ip = clientIp(request);
  await rateLimit('order:' + (ip || 'noip'), 10);
  const b = await readJson(request, 8 * 1024);
  const consent = { analytics: b.consent && b.consent.analytics === 'granted' ? 'granted' : 'denied',
                    ads: b.consent && b.consent.ads === 'granted' ? 'granted' : 'denied' };
  const anonymousId = consent.analytics === 'granted' && isUuid(b.anonymous_id) ? b.anonymous_id : null;
  const sessionId = consent.analytics === 'granted' && isUuid(b.session_id) ? b.session_id : null;
  const attribution = consent.analytics === 'granted' ? { first: cleanTouch(b.first_touch), last: cleanTouch(b.last_touch) } : null;
  // Meta matching data is kept only with ads consent, and only what CAPI needs.
  const metaUser = consent.ads === 'granted' ? {
    fbc: clip(b.fbc, 1200) || null, fbp: clip(b.fbp, 200) || null, ip, ua: clip(request.headers.get('user-agent'), 400),
  } : null;
  const { orderId, token, reused } = await createOrder({ anonymousId, sessionId, consent, attribution, metaUser, clientRef: b.client_ref });
  if (b.agent_link) await attachAgentLink(orderId, b.agent_link);
  return json({ ok: true, order_id: orderId, token, reused: !!reused, environment: cfg.environment }, 201);
});

export const GET = handle(async (request) => {
  const url = new URL(request.url);
  const o = await ownedOrder(url.searchParams.get('order_id'), request.headers.get('x-order-token'));
  return json({ ok: true, order: publicOrder(o) });
});
