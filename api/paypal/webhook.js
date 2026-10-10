// PayPal webhook: authenticated by PayPal's signature postback, deduplicated by event id.
// Makes payment independent of the buyer returning to our site.
import { q, one } from '../../lib/db.js';
import { json, handle, readBody } from '../../lib/util.js';
import { serverEvent } from '../../lib/store.js';
import { verifyWebhook, capturePaypalOrder, getPaypalOrder, capturesOf } from '../../lib/paypal.js';
import { applyCapture, applyRefund } from '../../lib/payment.js';
import { cfg } from '../../lib/config.js';
import { recover } from '../../lib/recovery.js';

export const config = { maxDuration: 30 };

async function orderIdFromPaypalOrder(ppOrder) {
  const pu = (ppOrder.purchase_units || [])[0] || {};
  const id = pu.custom_id || pu.invoice_id || pu.reference_id;
  if (id) return id;
  const row = await one(`SELECT order_id FROM orders WHERE paypal_order_id = $1`, [ppOrder.id]);
  return row && row.order_id;
}

export const POST = handle(async (request) => {
  const raw = await readBody(request, 256 * 1024);
  let evt; try { evt = JSON.parse(raw); } catch { return json({ ok: false }, 400); }
  const verified = await verifyWebhook(request.headers, raw);
  if (!verified) {
    await q(`INSERT INTO webhook_events (provider, event_id, event_type, verified, error, environment) VALUES ('paypal',$1,$2,false,'bad_signature',$3) ON CONFLICT DO NOTHING`,
      ['unverified:' + (evt.id || Date.now()), evt.event_type || null, cfg.environment]);
    return json({ ok: false, error: 'bad_signature' }, 400);
  }
  const fresh = await q(`INSERT INTO webhook_events (provider, event_id, event_type, verified, environment) VALUES ('paypal',$1,$2,true,$3) ON CONFLICT DO NOTHING RETURNING event_id`,
    [evt.id, evt.event_type, cfg.environment]);
  if (!fresh.length) {
    await q(`UPDATE webhook_events SET deliveries = deliveries + 1, last_received_at = now() WHERE provider = 'paypal' AND event_id = $1`, [evt.id]);
    const prev = await one(`SELECT processed_at FROM webhook_events WHERE provider = 'paypal' AND event_id = $1`, [evt.id]);
    if (prev && prev.processed_at) return json({ ok: true, duplicate: true });   // already handled → no second purchase
  }

  let outcome = null, matched = null;
  try {
    const r = evt.resource || {};
    switch (evt.event_type) {
      case 'CHECKOUT.ORDER.APPROVED': {
        // Buyer approved but may have closed the tab before we captured: capture here.
        const orderId = await orderIdFromPaypalOrder(r);
        if (!orderId) { outcome = 'unmatched'; break; }
        matched = orderId;
        await serverEvent('payment_approved', { eventId: `payment_approved:${r.id}`, orderId, channel: 'paypal', props: { via: 'webhook' } });
        let res = await capturePaypalOrder(r.id);
        const order = res.ok ? res.data : await getPaypalOrder(r.id);
        for (const c of capturesOf(order)) outcome = await applyCapture(orderId, c, 'webhook_approved');
        break;
      }
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.CAPTURE.PENDING':
      case 'PAYMENT.CAPTURE.DENIED': {
        // Re-read the order from PayPal so payee and amount come from PayPal, not from the delivery.
        const ppOrderId = r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.order_id;
        let cap = r;
        if (ppOrderId) { const ord = await getPaypalOrder(ppOrderId); cap = capturesOf(ord).find(c => c.id === r.id) || { ...r, payee: ((ord.purchase_units || [])[0] || {}).payee }; }
        const orderId = cap.custom_id || r.custom_id || (ppOrderId && (await one(`SELECT order_id FROM orders WHERE paypal_order_id = $1`, [ppOrderId]) || {}).order_id);
        if (!orderId) { outcome = 'unmatched'; break; }
        matched = orderId;
        if (evt.event_type === 'PAYMENT.CAPTURE.DENIED') cap = { ...cap, status: 'DECLINED' };
        outcome = await applyCapture(orderId, cap, 'webhook');
        break;
      }
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED': {
        // custom_id is not always copied onto the refund; fall back to the capture it belongs to (link rel "up").
        let orderId = r.custom_id || r.invoice_id;
        if (!orderId) {
          const up = (r.links || []).find(l => l.rel === 'up' && /\/captures\//.test(l.href || ''));
          const captureId = up && up.href.split('/captures/')[1].split(/[/?#]/)[0];
          const row = captureId && await one(`SELECT order_id FROM payments WHERE capture_id = $1`, [captureId]);
          orderId = row && row.order_id;
        }
        if (!orderId) { outcome = 'unmatched'; break; }
        matched = orderId;
        // REVERSED (chargeback) ends the order like a full refund.
        outcome = await applyRefund(orderId, evt.event_type === 'PAYMENT.CAPTURE.REVERSED' ? { ...r, amount: null } : r);
        break;
      }
      default: outcome = 'ignored';
    }
    const unmatched = outcome === 'unmatched' || (outcome && outcome.reason === 'unknown_order');
    await q(`UPDATE webhook_events SET processed_at = now(), error = $3, order_id = $4 WHERE provider = $1 AND event_id = $2`,
      ['paypal', evt.id, unmatched ? 'unmatched_order' : (outcome && outcome.ok === false ? outcome.reason : null), matched]);
    try { await recover({ light: true }); } catch (e) { console.error('[recover]', e.message); }   // opportunistic retries
    return json({ ok: true });
  } catch (e) {
    await q(`UPDATE webhook_events SET error = $3 WHERE provider = $1 AND event_id = $2`, ['paypal', evt.id, String(e.message).slice(0, 300)]);
    throw e;   // 500 → PayPal retries
  }
});
