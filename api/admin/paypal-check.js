// "Check with PayPal" from the dashboard: reads the order and every recorded capture back from PayPal (GET only,
// nothing is created or captured) and compares them with what the database recorded. Audited.
import { q } from '../../lib/db.js';
import { cfg } from '../../lib/config.js';
import { json, handle, isOrderId, httpError } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { getPaypalOrder, getPaypalCapture, capturesOf } from '../../lib/paypal.js';

export const config = { maxDuration: 30 };

const money = (v) => (v == null ? null : Number(v).toFixed(2));

export const GET = handle(async (request) => {
  const admin = await requireAdmin(request);
  const id = new URL(request.url).searchParams.get('order_id');
  if (!isOrderId(id)) throw httpError(400, 'bad_order_id');
  const [order] = await q(`SELECT order_id, status, amount, currency, paypal_order_id, paid_at, environment FROM orders WHERE order_id = $1`, [id]);
  if (!order) throw httpError(404, 'not_found');
  const recorded = await q(`SELECT capture_id, status, amount, currency, payee_merchant FROM payments WHERE order_id = $1 AND provider = 'paypal' ORDER BY created_at`, [id]);

  let ppOrder = null, orderError = null;
  if (order.paypal_order_id) {
    try { ppOrder = await getPaypalOrder(order.paypal_order_id); } catch (e) { orderError = String(e.message || e); }
  }
  const inOrder = capturesOf(ppOrder);
  const ids = [...new Set([...recorded.map(p => p.capture_id), ...inOrder.map(c => c.id)].filter(Boolean))];
  const captures = [];
  for (const capId of ids) {
    const r = await getPaypalCapture(capId);
    const c = r.ok ? r.data : null;
    const db = recorded.find(p => p.capture_id === capId) || null;
    const fromOrder = inOrder.find(x => x.id === capId) || null;
    const amount = c && c.amount ? money(c.amount.value) : null;
    const currency = c && c.amount ? c.amount.currency_code : null;
    const payee = (c && c.payee && c.payee.merchant_id) || (fromOrder && fromOrder.payee && fromOrder.payee.merchant_id) || null;
    const customId = (c && c.custom_id) || (fromOrder && fromOrder.custom_id) || null;
    captures.push({
      capture_id: capId, found_at_paypal: r.ok, paypal_http: r.status,
      paypal_status: c ? c.status : null, amount, currency, payee, custom_id: customId,
      create_time: c ? c.create_time || null : null,
      paypal_order_id: (c && c.supplementary_data && c.supplementary_data.related_ids && c.supplementary_data.related_ids.order_id) || order.paypal_order_id,
      in_database: !!db, db_status: db ? db.status : null,
      matches: {
        order: customId === id,
        amount: amount === money(cfg.product.amount) && (!db || money(db.amount) === amount),
        currency: currency === cfg.product.currency && (!db || db.currency === currency),
        payee: cfg.paypal.merchantId ? payee === cfg.paypal.merchantId : null,
      },
    });
  }
  const completed = captures.filter(c => c.paypal_status === 'COMPLETED');
  const verified = completed.length === 1 && completed.every(c => c.in_database && c.matches.order && c.matches.amount && c.matches.currency && c.matches.payee !== false);
  const result = {
    ok: true, order_id: id, paypal_env: cfg.paypal.env, checked_at: new Date().toISOString(),
    paypal_order: { id: order.paypal_order_id, status: ppOrder ? ppOrder.status : null, error: orderError },
    captures, completed_captures: completed.length, verified,
  };
  await q(`INSERT INTO admin_audit (admin_user, action, order_id, details) VALUES ($1,'paypal_check',$2,$3::jsonb)`,
    [admin, id, JSON.stringify({ paypal_env: result.paypal_env, verified, captures: captures.map(c => ({ id: c.capture_id, status: c.paypal_status, amount: c.amount, currency: c.currency })) })]);
  return json(result);
});
