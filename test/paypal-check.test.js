// The owner can ask PayPal directly about a paid order: read-only, compared with the records, audited.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, basic, uuid4 } from './helpers.js';
import * as order from '../api/order.js';
import * as ppCreate from '../api/paypal/create.js';
import * as ppCapture from '../api/paypal/capture.js';
import * as check from '../api/admin/paypal-check.js';

beforeEach(freshDb);

async function paidOrder() {
  const o = (await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4() } })).data;
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
  return o;
}
const get = (id, headers = basic()) => call(check.GET, 'GET', '/api/admin/paypal-check?order_id=' + id, { headers });

test('C1. only the owner can ask', async () => {
  const o = await paidOrder();
  assert.equal((await get(o.order_id, {})).status, 401);
  assert.equal((await get(o.order_id, basic('admin', 'wrong'))).status, 401);
});

test('C2. a paid order: one capture, its own id, amount and currency from PayPal, matching the records; nothing new is created', async () => {
  const A = await paidOrder(); const B = await paidOrder();
  const before = mock.calls.filter(c => c.method === 'POST' && /paypal\.com\/v2\//.test(c.url)).length;
  const a = (await get(A.order_id)).data, b = (await get(B.order_id)).data;
  assert.equal(mock.calls.filter(c => c.method === 'POST' && /paypal\.com\/v2\//.test(c.url)).length, before, 'read only');
  for (const [r, o] of [[a, A], [b, B]]) {
    assert.equal(r.verified, true); assert.equal(r.paypal_env, 'sandbox'); assert.equal(r.paypal_order.status, 'COMPLETED');
    assert.equal(r.captures.length, 1);
    const c = r.captures[0];
    assert.equal(c.paypal_status, 'COMPLETED'); assert.equal(c.amount, '1290.00'); assert.equal(c.currency, 'ILS');
    assert.equal(c.custom_id, o.order_id); assert.equal(c.payee, 'MERCH1'); assert.equal(c.in_database, true);
    assert.deepEqual(c.matches, { order: true, amount: true, currency: true, payee: true });
  }
  assert.notEqual(a.captures[0].capture_id, b.captures[0].capture_id, 'each order has its own capture');
  const audit = await sql(`SELECT order_id FROM admin_audit WHERE action = 'paypal_check' ORDER BY id`);
  assert.deepEqual(audit.map(x => x.order_id), [A.order_id, B.order_id]);
});

test('C3. a capture PayPal does not know, or a wrong amount, is not verified', async () => {
  const o = await paidOrder();
  await sql(`UPDATE payments SET capture_id = 'CAP-FORGED' WHERE order_id = $1`, [o.order_id]);
  const r = (await get(o.order_id)).data;
  const forged = r.captures.find(c => c.capture_id === 'CAP-FORGED');
  assert.equal(forged.found_at_paypal, false); assert.equal(forged.paypal_status, null);
  const real = r.captures.find(c => c.capture_id !== 'CAP-FORGED');
  assert.equal(real.in_database, false);
  assert.equal(r.verified, false);
  const o2 = await paidOrder();
  for (const c of mock.pp.values()) for (const cap of (c.purchase_units[0].payments || {}).captures || []) if (cap.custom_id === o2.order_id) cap.amount.value = '1.00';
  assert.equal((await get(o2.order_id)).data.verified, false);
});

test('C4. an order that never reached checkout: no captures, not verified', async () => {
  const o = (await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4() } })).data;
  const r = (await get(o.order_id)).data;
  assert.equal(r.captures.length, 0); assert.equal(r.verified, false);
  assert.equal((await get('FR-ZZZZ-ZZZZ')).status, 404);
});

test('C5. a long session (hundreds of events before payment) still shows its one purchase_verified in the order screen', async () => {
  const adminOrder = await import('../api/admin/order.js');
  const o = (await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4() } })).data;
  const [{ session_id }] = await sql(`SELECT session_id FROM orders WHERE order_id = $1`, [o.order_id]);
  await sql(`INSERT INTO events (event_id, event_name, occurred_at, session_id, channel, environment, props)
             SELECT 'pad:' || g, 'agent_tool_result', now() - interval '1 hour' + g * interval '1 second', $1, 'web', 'test', '{}'::jsonb
             FROM generate_series(1, 400) g`, [session_id]);
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
  assert.equal((await sql(`SELECT count(*)::int c FROM events WHERE event_id = $1`, ['purchase_verified:' + o.order_id]))[0].c, 1, 'stored');
  const d = (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data;
  assert.equal(d.checks.purchase_verified_events, 1, 'counted even when the event list is capped');
  assert.equal(d.events.some(e => e.event_name === 'purchase_verified'), true, 'the capped list keeps the newest events');
});

test('C6. a resend of a delivery stored before order_id existed: linked to its order, counted, not processed again', async () => {
  const { ppHeaders } = await import('./helpers.js');
  const ppWebhook = await import('../api/paypal/webhook.js');
  const adminOrder = await import('../api/admin/order.js');
  const o = await paidOrder();
  const [{ capture_id, paypal_order_id }] = await sql(`SELECT p.capture_id, o.paypal_order_id FROM payments p JOIN orders o USING (order_id) WHERE order_id = $1`, [o.order_id]);
  const raw = JSON.stringify({ id: 'WH-OLD-1', event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: capture_id, status: 'COMPLETED', custom_id: o.order_id, amount: { value: '1290.00', currency_code: 'ILS' },
      supplementary_data: { related_ids: { order_id: paypal_order_id } } } });
  await call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw, headers: ppHeaders() });
  await sql(`UPDATE webhook_events SET order_id = NULL WHERE event_id = 'WH-OLD-1'`);             // as stored before migration 006
  const before = (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data.checks;
  assert.equal(before.webhook_deliveries, 0, 'not visible before the resend');
  const r = await call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw, headers: ppHeaders() });
  assert.equal(r.data.duplicate, true);
  const k = (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data.checks;
  assert.equal(k.webhook_deliveries, 2); assert.equal(k.webhook_resends, 1);
  assert.equal(k.purchase_verified_events, 1); assert.equal(k.completed_payments, 1);
});
