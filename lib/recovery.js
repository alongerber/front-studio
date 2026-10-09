// Recovery sweep: finishes anything a failure left half-done. Every step is idempotent.
// Runs from the daily cron, from the dashboard ("retry now"), and lightly after each webhook delivery.
import { q } from './db.js';
import { cfg } from './config.js';
import { ensurePaidSideEffects, repairCapturedOrder } from './payment.js';
import { flushOutbox } from './meta.js';
import { flushNotify } from './notify.js';
import { processElevenEvent, markElevenProcessed } from '../api/elevenlabs/webhook.js';

export async function recover({ light = false } = {}) {
  const env = cfg.environment, lim = light ? 5 : 50;
  const out = { repaired_payments: 0, side_effects: 0, finish_requeued: 0, conversations_replayed: 0, conversations_failed: 0, meta: [], notify: [] };

  // 1. A verified PayPal capture is stored but the order was never marked paid (the atomic step failed).
  const stuck = await q(`SELECT DISTINCT p.order_id FROM payments p JOIN orders o USING (order_id)
                         WHERE p.provider = 'paypal' AND p.status = 'COMPLETED' AND o.paid_at IS NULL AND o.environment = $1 LIMIT $2`, [env, lim]);
  for (const r of stuck) if (await repairCapturedOrder(r.order_id)) out.repaired_payments++;

  // 2. Paid orders missing their purchase event, Meta queue row or "paid" email (e.g. rows lost before migration 003).
  const missing = await q(`SELECT o.order_id FROM orders o WHERE o.environment = $1 AND o.paid_at IS NOT NULL AND o.status <> 'refunded' AND (
      NOT EXISTS (SELECT 1 FROM events e WHERE e.event_id = 'purchase_verified:' || o.order_id) OR
      NOT EXISTS (SELECT 1 FROM meta_outbox m WHERE m.event_id = o.order_id) OR
      NOT EXISTS (SELECT 1 FROM notify_outbox n WHERE n.id = 'paid:' || o.order_id)) LIMIT $2`, [env, lim]);
  for (const r of missing) { await ensurePaidSideEffects(r.order_id); out.side_effects++; }

  // 3. Completed briefs whose production email was never queued.
  const fin = await q(`INSERT INTO notify_outbox (id, action, order_id)
                       SELECT 'finish:' || order_id, 'finish', order_id FROM orders
                       WHERE environment = $1 AND brief_done_at IS NOT NULL ON CONFLICT (id) DO NOTHING RETURNING id`, [env]);
  out.finish_requeued = fin.length;

  // 4. ElevenLabs deliveries that were stored but not processed.
  const pending = await q(`SELECT event_id, payload, attempts FROM webhook_events
                           WHERE provider = 'elevenlabs' AND processed_at IS NULL AND payload IS NOT NULL AND attempts < 20
                             AND (environment IS NULL OR environment = $1)
                           ORDER BY received_at LIMIT $2`, [env, light ? 3 : 25]);
  for (const r of pending) {
    try {
      const evt = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      await markElevenProcessed(r.event_id, await processElevenEvent(evt));
      out.conversations_replayed++;
    } catch (e) {
      out.conversations_failed++;
      await q(`UPDATE webhook_events SET error = $2, attempts = attempts + 1 WHERE provider = 'elevenlabs' AND event_id = $1`, [r.event_id, String(e.message).slice(0, 300)]);
    }
  }

  // 5. Deliver what is due.
  out.meta = await flushOutbox({ limit: light ? 5 : 50 });
  out.notify = await flushNotify({ limit: light ? 5 : 50 });
  return out;
}
