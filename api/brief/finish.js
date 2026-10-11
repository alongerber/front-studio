// Hand the brief to production. Notes may be saved before payment, but COMPLETING the brief (and the
// "go to production" email) needs a payment that stands and a minimum of content.
// Completion, its event and the queued email are stored in one statement; the email is then retried until delivered.
import { one } from '../../lib/db.js';
import { cfg } from '../../lib/config.js';
import { json, handle, readJson, httpError } from '../../lib/util.js';
import { ownedOrder, isPaid, briefMissing, rateLimit } from '../../lib/store.js';
import { flushNotify } from '../../lib/notify.js';

export const POST = handle(async (request) => {
  const b = await readJson(request, 8 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  await rateLimit('finish:' + o.order_id, 10);
  if (o.brief_done_at) return json({ ok: true, order_id: o.order_id, paid: isPaid(o), saved: true, already: true });
  if (!isPaid(o)) throw httpError(409, 'payment_required');
  if (!o.contact || !o.contact.name || !o.contact.phone) throw httpError(409, 'contact_required');
  const missing = briefMissing(o.brief);
  if (missing.length) { const e = httpError(409, 'brief_incomplete'); e.extra = { missing }; throw e; }

  const done = await one(`
    WITH done AS (
      UPDATE orders SET brief_done_at = now(), updated_at = now()
      WHERE order_id = $1 AND brief_done_at IS NULL AND status IN ('paid','partially_refunded') RETURNING *),
    ev AS (
      INSERT INTO events (event_id, event_name, occurred_at, anonymous_id, session_id, lead_id, order_id, channel, site_version, environment, props)
      SELECT 'brief_completed:' || order_id, 'brief_completed', now(), anonymous_id, session_id, order_id, order_id, 'server', $2, environment, '{"paid":true}'::jsonb
      FROM done ON CONFLICT (event_id) DO NOTHING RETURNING 1),
    nq AS (
      INSERT INTO notify_outbox (id, action, order_id) SELECT 'finish:' || order_id, 'finish', order_id FROM done ON CONFLICT (id) DO NOTHING RETURNING 1)
    SELECT * FROM done`, [o.order_id, cfg.siteVersion]);
  if (!done) return json({ ok: true, order_id: o.order_id, paid: true, saved: true, already: true });   // a parallel request won

  let notified = false;
  try { notified = (await flushNotify({ orderId: o.order_id })).some(r => r.ok); } catch (e) { console.error('[notify]', e.message); }
  // saved = the brief is stored and visible to production. notified=false only means the email is queued for retry.
  return json({ ok: true, order_id: o.order_id, paid: true, saved: true, notified });
});
