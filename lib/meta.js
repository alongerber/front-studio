// Meta Conversions API: Purchase only after a verified payment, via an outbox.
import { q } from './db.js';
import { cfg } from './config.js';
import { sha256, clip } from './util.js';

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);            // Israeli local format → country code
  return d;
}

export function buildPurchase(order) {
  const mu = order.meta_user || {};
  const c = order.contact || {};
  const user = {};
  if (c.email) user.em = [sha256(normEmail(c.email))];
  if (c.phone && normPhone(c.phone)) user.ph = [sha256(normPhone(c.phone))];
  if (order.anonymous_id) user.external_id = [sha256(order.anonymous_id)];
  if (mu.fbc) user.fbc = mu.fbc;
  if (mu.fbp) user.fbp = mu.fbp;
  if (mu.ip) user.client_ip_address = mu.ip;
  if (mu.ua) user.client_user_agent = mu.ua;
  const t = Math.floor(new Date(order.paid_at || Date.now()).getTime() / 1000);
  const body = {
    data: [{
      event_name: 'Purchase', event_time: t, event_id: order.order_id, action_source: 'website',
      event_source_url: cfg.siteUrl + '/', user_data: user,
      custom_data: { value: Number(order.amount), currency: order.currency, content_ids: [order.product], content_type: 'product', order_id: order.order_id },
    }],
  };
  if (cfg.meta.testCode) body.test_event_code = cfg.meta.testCode;
  return body;
}

// Deliver queued Purchases. The payload is built now, from the order as it is now:
// consent is checked at send time (not only at order time), and a refunded order is never reported.
// Rows waiting for consent are re-checked on every run and expire with the 7-day Meta window.
export async function flushOutbox({ orderId = null, limit = 20 } = {}) {
  const rows = await q(
    `SELECT m.event_id, m.attempts, m.status AS ob_status, to_jsonb(o) AS ord
     FROM meta_outbox m LEFT JOIN orders o ON o.order_id = m.order_id
     WHERE m.status IN ('pending','no_consent') AND m.next_attempt_at <= now() AND ($1::text IS NULL OR m.order_id = $1)
       AND (o.environment IS NULL OR o.environment = $3)          -- a preview deployment never sends production rows, and vice versa
     ORDER BY m.created_at LIMIT $2`, [orderId, limit, cfg.environment]);
  const results = [];
  const set = (id, fields) => q(`UPDATE meta_outbox SET status = $2, last_error = $3 WHERE event_id = $1`, [id, fields.status, fields.error || null]);
  for (const r of rows) {
    const o = typeof r.ord === 'string' ? JSON.parse(r.ord) : r.ord;
    if (!o) { await set(r.event_id, { status: 'failed', error: 'order_missing' }); results.push({ id: r.event_id, ok: false, error: 'order_missing' }); continue; }
    if (o.status === 'refunded') { await set(r.event_id, { status: 'cancelled_refund' }); results.push({ id: r.event_id, ok: false, error: 'refunded' }); continue; }
    const ageDays = (Date.now() - new Date(o.paid_at || o.created_at).getTime()) / 86400e3;
    if (ageDays > 7) { await set(r.event_id, { status: 'expired', error: 'older_than_7_days' }); results.push({ id: r.event_id, ok: false, error: 'expired' }); continue; }
    if (!o.consent || o.consent.ads !== 'granted') {          // consent may still arrive; nothing is sent meanwhile
      if (r.ob_status !== 'no_consent') await set(r.event_id, { status: 'no_consent' });
      results.push({ id: r.event_id, ok: false, error: 'no_consent' }); continue;
    }
    // Outside production a Purchase may only go to Meta as a test event: no test code, nothing is sent.
    const missing = !cfg.meta.pixelId || !cfg.meta.token ? 'not_configured' : (cfg.environment !== 'production' && !cfg.meta.testCode ? 'test_code_required' : null);
    if (missing) {
      await q(`UPDATE meta_outbox SET status = 'pending', last_error = $2, next_attempt_at = now() + interval '1 hour' WHERE event_id = $1`, [r.event_id, missing]);
      results.push({ id: r.event_id, ok: false, error: missing }); continue;
    }
    const payload = buildPurchase(o);
    let ok = false, err = null;
    try {
      const url = `https://graph.facebook.com/${cfg.meta.version}/${cfg.meta.pixelId}/events?access_token=${encodeURIComponent(cfg.meta.token)}`;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
      ok = res.ok; if (!ok) err = 'http_' + res.status + ':' + clip(await res.text(), 300);
    } catch (e) { err = clip(e.message, 300); }
    const attempts = r.attempts + 1;
    await q(`UPDATE meta_outbox SET attempts = $2, payload = $3::jsonb, last_error = $4,
               status = CASE WHEN $5 THEN 'sent' WHEN $2 >= 10 THEN 'failed' ELSE 'pending' END,
               sent_at = CASE WHEN $5 THEN now() ELSE sent_at END,
               next_attempt_at = now() + make_interval(mins => LEAST(720, power(2, $2)::int))
             WHERE event_id = $1`, [r.event_id, attempts, JSON.stringify(payload), ok ? null : err, ok]);
    await q(`INSERT INTO events (event_id, event_name, occurred_at, order_id, lead_id, channel, site_version, environment, props)
             VALUES ($1,$2,now(),$3,$3,'meta',$4,$5,$6::jsonb) ON CONFLICT (event_id) DO NOTHING`,
      [`${ok ? 'meta_purchase_sent' : 'meta_purchase_failed'}:${r.event_id}:${attempts}`, ok ? 'meta_purchase_sent' : 'meta_purchase_failed',
       o.order_id, cfg.siteVersion, o.environment || cfg.environment, JSON.stringify(ok ? {} : { error: err })]);
    results.push({ id: r.event_id, ok, error: err });
  }
  return results;
}
