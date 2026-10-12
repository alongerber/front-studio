// "PayPal connection check" from the dashboard: with the server's own keys, asks PayPal which app they belong to, which
// webhooks that app has, and whether PAYPAL_WEBHOOK_ID is one of them with our URL and the events we handle.
// Optionally (order_id) lists that app's webhook events for one order and compares each event id with what we received.
// GET only at PayPal: nothing is created, changed or resent. Keys, secret and token are never returned. Audited.
import { q } from '../../lib/db.js';
import { cfg } from '../../lib/config.js';
import { json, handle, isOrderId, httpError } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { paypalApp, listPaypalWebhooks, listPaypalWebhookEvents, paypalError } from '../../lib/paypal.js';

export const config = { maxDuration: 30 };

// The event types api/paypal/webhook.js acts on.
export const REQUIRED_EVENTS = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'];

const mask = (v) => (v ? v.slice(0, 6) + '…' + ' (' + v.length + ' תווים)' : null);
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const GET = handle(async (request) => {
  const admin = await requireAdmin(request);
  const orderId = new URL(request.url).searchParams.get('order_id');
  if (orderId && !isOrderId(orderId)) throw httpError(400, 'bad_order_id');

  const expectedUrl = cfg.siteUrl + '/api/paypal/webhook';
  const result = {
    ok: true, checked_at: new Date().toISOString(), environment: cfg.environment, paypal_env: cfg.paypal.env,
    keys: { client_id: mask(cfg.paypal.clientId), secret_set: !!cfg.paypal.secret, webhook_id: cfg.paypal.webhookId || null },
    request_host: new URL(request.url).host, expected_url: expectedUrl,
    auth: null, app_id: null, webhooks: [], configured: null, events: null,
  };

  try { result.app_id = (await paypalApp()).app_id; result.auth = { ok: true }; }
  catch (e) { result.auth = { ok: false, error: String(e.message || e) }; }

  if (result.auth.ok) {
    const wh = await listPaypalWebhooks();
    if (!wh.ok) result.webhooks_error = 'PayPal ' + wh.status;
    result.webhooks = ((wh.data && wh.data.webhooks) || []).map(w => {
      const types = (w.event_types || []).map(t => t.name);
      return { id: w.id, url: w.url, event_types: types };
    });
    const mine = result.webhooks.find(w => w.id === cfg.paypal.webhookId) || null;
    const all = mine && mine.event_types.includes('*');
    result.configured = {
      in_this_app: !!mine,
      url: mine ? mine.url : null,
      url_matches: mine ? mine.url === expectedUrl : null,
      missing_events: mine ? (all ? [] : REQUIRED_EVENTS.filter(t => !mine.event_types.includes(t))) : null,
      all_events: !!all,
      other_webhooks_with_our_url: result.webhooks.filter(w => w.url === expectedUrl && w.id !== cfg.paypal.webhookId).map(w => w.id),
    };

    if (orderId) {
      const [o] = await q(`SELECT order_id, paypal_order_id, created_at, paid_at FROM orders WHERE order_id = $1`, [orderId]);
      if (!o) throw httpError(404, 'not_found');
      const caps = (await q(`SELECT capture_id FROM payments WHERE order_id = $1 AND provider = 'paypal'`, [orderId])).map(r => r.capture_id).filter(Boolean);
      const ids = new Set([o.paypal_order_id, ...caps].filter(Boolean));
      const from = new Date(new Date(o.created_at).getTime() - 3600e3);
      const to = new Date(Math.min(Date.now(), new Date(o.paid_at || o.created_at).getTime() + 3 * 86400e3));
      // Search attempts, each reported with PayPal's own error (name, message, debug_id, details).
      // 1) the time window with PayPal's default page size, following its "next" links;
      // 2) if that fails, each PayPal id as transaction_id (a documented filter), with no time window.
      const attempts = [], list = [], seen = new Set();
      const add = (evs) => { for (const e of evs || []) if (!seen.has(e.id)) { seen.add(e.id); list.push(e); } };
      const run = async (label, query) => {
        let res = await listPaypalWebhookEvents(query), pages = 0, n = 0;
        while (res.ok) {
          pages++; n += ((res.data && res.data.events) || []).length; add(res.data && res.data.events);
          const next = ((res.data && res.data.links) || []).find(l => l.rel === 'next');
          if (!next || pages >= 20) break;
          res = await listPaypalWebhookEvents(null, next.href);
        }
        const error = res.ok ? null : paypalError(res);
        if (error) console.warn('[paypal-connection] events search refused', label, JSON.stringify(query), JSON.stringify(error));   // no keys, token or headers
        attempts.push({ label, query, ok: res.ok, pages, events: n, error });
        return res.ok;
      };
      let searched = await run('window', { start_time: iso(from), end_time: iso(to) });
      if (!searched) for (const id of ids) searched = (await run('transaction_id', { transaction_id: id })) || searched;
      const relates = (e) => {
        const r = e.resource || {};
        const rel = (r.supplementary_data && r.supplementary_data.related_ids) || {};
        return ids.has(r.id) || ids.has(rel.order_id) || r.custom_id === orderId || r.invoice_id === orderId;
      };
      const matched = list.filter(relates);
      const out = [];
      for (const e of matched) {
        // Per event id: the verified row (deliveries counts resends of this same id) and any rejected delivery of it.
        const [row] = await q(`SELECT verified, deliveries, processed_at, error, received_at, last_received_at FROM webhook_events WHERE provider = 'paypal' AND event_id = $1`, [e.id]);
        const [bad] = await q(`SELECT received_at, error FROM webhook_events WHERE provider = 'paypal' AND event_id = $1`, ['unverified:' + e.id]);
        out.push({ id: e.id, event_type: e.event_type, create_time: e.create_time, resource_id: (e.resource || {}).id || null,
          received: row ? { deliveries: row.deliveries, processed: !!row.processed_at, error: row.error, first: row.received_at, last: row.last_received_at } : null,
          rejected_signature: bad ? { at: bad.received_at } : null });
      }
      // search_ok=false: PayPal refused every search, so "no events" is unknown, not zero.
      result.events = { order_id: orderId, paypal_ids: [...ids], window: { from: iso(from), to: iso(to) },
        search_ok: !!searched, attempts, listed: list.length, for_this_order: out };
    }
  }

  await q(`INSERT INTO admin_audit (admin_user, action, order_id, details) VALUES ($1,'paypal_connection_check',$2,$3::jsonb)`,
    [admin, orderId || null, JSON.stringify({ auth: result.auth.ok, app_id: result.app_id, configured: result.configured,
      events: result.events && { search_ok: result.events.search_ok, attempts: result.events.attempts.map(a => ({ label: a.label, ok: a.ok, http: a.error && a.error.http, debug_id: a.error && a.error.debug_id })),
        found: result.events.for_this_order.map(e => ({ id: e.id, type: e.event_type, received: !!e.received })) } })]);
  return json(result);
});
