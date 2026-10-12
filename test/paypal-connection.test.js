// PayPal connection check: which app the server keys belong to, its webhooks, and per-event-id delivery for one order.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, basic, uuid4 } from './helpers.js';
import * as order from '../api/order.js';
import * as ppCreate from '../api/paypal/create.js';
import * as ppCapture from '../api/paypal/capture.js';
import * as conn from '../api/admin/paypal-connection.js';

beforeEach(freshDb);

const URL_OK = 'https://front.test/api/paypal/webhook';
const all6 = conn.REQUIRED_EVENTS.map(name => ({ name }));
const get = (qs = '', headers = basic()) => call(conn.GET, 'GET', '/api/admin/paypal-connection' + qs, { headers });
async function paidOrder() {
  const o = (await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4() } })).data;
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
  return { ...o, pp: pp.data.id };
}
const nonGetPaypal = () => mock.calls.filter(c => /paypal\.com/.test(c.url) && c.method !== 'GET' && !/oauth2\/token/.test(c.url)).length;

test('PC1. only the owner; keys, secret and token never leave the server', async () => {
  assert.equal((await get('', {})).status, 401);
  mock.webhooks = [{ id: 'WH-1', url: URL_OK, event_types: all6 }];
  const r = await get();
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.data);
  for (const s of ['csecret', 'tok"', '"cid"']) assert.ok(!text.includes(s), 'leaked ' + s);
  assert.equal(r.data.keys.secret_set, true);
  assert.equal(r.data.app_id, 'APP-TEST1');
});

test('PC2. matching app, URL and all six events → everything true; read only', async () => {
  mock.webhooks = [{ id: 'WH-OTHER', url: 'https://elsewhere.test/x', event_types: [{ name: '*' }] }, { id: 'WH-1', url: URL_OK, event_types: all6 }];
  const before = nonGetPaypal();
  const c = (await get()).data.configured;
  assert.equal(nonGetPaypal(), before, 'no POST/PATCH/DELETE at PayPal');
  assert.deepEqual(c, { in_this_app: true, url: URL_OK, url_matches: true, missing_events: [], all_events: false, other_webhooks_with_our_url: [] });
  const audit = await sql(`SELECT action FROM admin_audit WHERE action = 'paypal_connection_check'`);
  assert.equal(audit.length, 1);
});

test('PC3. webhook id from another app, wrong URL, missing events, failed auth are each reported', async () => {
  mock.webhooks = [{ id: 'WH-9', url: URL_OK, event_types: all6 }];
  let c = (await get()).data.configured;
  assert.equal(c.in_this_app, false); assert.equal(c.url_matches, null); assert.deepEqual(c.other_webhooks_with_our_url, ['WH-9']);
  mock.webhooks = [{ id: 'WH-1', url: 'https://old.test/api/paypal/webhook', event_types: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }] }];
  c = (await get()).data.configured;
  assert.equal(c.url_matches, false); assert.equal(c.missing_events.length, 5);
  mock.webhooks = [{ id: 'WH-1', url: URL_OK, event_types: [{ name: '*' }] }];
  c = (await get()).data.configured;
  assert.deepEqual(c.missing_events, []); assert.equal(c.all_events, true);
  const { resetPaypalToken } = await import('../lib/paypal.js'); resetPaypalToken(); mock.authFail = true;
  const r = (await get()).data;
  assert.equal(r.auth.ok, false); assert.equal(r.configured, null);
});

test('PC4. per order: each PayPal event id is compared with its own row (deliveries per id, not a total)', async () => {
  const o = await paidOrder();
  const cap = (await sql(`SELECT capture_id FROM payments WHERE order_id = $1`, [o.order_id]))[0].capture_id;
  mock.webhooks = [{ id: 'WH-1', url: URL_OK, event_types: all6 }];
  mock.whEvents = [
    { id: 'WH-EV-A', event_type: 'CHECKOUT.ORDER.APPROVED', create_time: '2026-10-10T02:56:00Z', resource: { id: o.pp } },
    { id: 'WH-EV-B', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-10-10T02:57:00Z', resource: { id: cap, supplementary_data: { related_ids: { order_id: o.pp } } } },
    { id: 'WH-EV-C', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-10-10T02:58:00Z', resource: { id: 'CAP-SOMEONE-ELSE' } },
  ];
  await sql(`INSERT INTO webhook_events (provider, event_id, event_type, verified, processed_at, deliveries) VALUES ('paypal','WH-EV-B','PAYMENT.CAPTURE.COMPLETED',true,now(),2)`);
  await sql(`INSERT INTO webhook_events (provider, event_id, event_type, verified, error) VALUES ('paypal','unverified:WH-EV-A','CHECKOUT.ORDER.APPROVED',false,'bad_signature')`);
  const ev = (await get('?order_id=' + o.order_id)).data.events;
  assert.equal(ev.listed_in_window, 3);
  assert.deepEqual(ev.for_this_order.map(e => e.id), ['WH-EV-A', 'WH-EV-B'], 'another order\'s event is not counted');
  const [a, b] = ev.for_this_order;
  assert.equal(a.received, null); assert.ok(a.rejected_signature, 'a delivery that failed signature is shown for that id');
  assert.equal(b.received.deliveries, 2); assert.equal(b.received.processed, true);
  assert.equal((await get('?order_id=bad')).status, 400);
});

test('PC5. the real order number FR-Y7J2-SNQA is accepted (and only exact upper-case form reaches the server check)', async () => {
  const { isOrderId } = await import('../lib/util.js');
  assert.equal(isOrderId('FR-Y7J2-SNQA'), true);
  const o = await paidOrder();
  // A paid order under the SNQA number (a full copy of a real paid row, so every column is valid).
  await sql(`INSERT INTO orders SELECT (jsonb_populate_record(null::orders, to_jsonb(o) ||
               '{"order_id":"FR-Y7J2-SNQA","token_hash":"snqa","paypal_order_id":"9EP78293M29745057","agent_links":[]}'::jsonb)).* FROM orders o WHERE order_id = $1`, [o.order_id]);
  mock.webhooks = [{ id: 'WH-1', url: URL_OK, event_types: all6 }];
  mock.whEvents = [{ id: 'WH-SNQA', event_type: 'CHECKOUT.ORDER.APPROVED', create_time: '2026-10-10T02:56:00Z', resource: { id: '9EP78293M29745057' } }];
  const r = await get('?order_id=FR-Y7J2-SNQA');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.events.order_id, 'FR-Y7J2-SNQA');
  assert.deepEqual(r.data.events.for_this_order.map(e => e.id), ['WH-SNQA']);
  assert.equal((await get('?order_id=fr-y7j2-snqa')).status, 400, 'the dashboard upper-cases before sending');
});
