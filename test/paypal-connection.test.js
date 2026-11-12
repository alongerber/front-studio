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
  assert.equal(ev.listed, 3); assert.equal(ev.search_ok, true);
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

test('PC6. PayPal refuses the search: its error (name, message, debug_id, details) is shown; a failed search is never "0 events"', async () => {
  const o = await paidOrder();
  mock.webhooks = [{ id: 'WH-1', url: URL_OK, event_types: all6 }];
  const err = { name: 'INVALID_REQUEST', message: 'Request is not well-formed, syntactically incorrect, or violates schema.', debug_id: 'dbg123abc',
    details: [{ field: 'start_time', value: 'x', location: 'query', issue: 'INVALID_PARAMETER_VALUE', description: 'bad' }] };
  mock.eventsReject = () => err;                                       // every search refused
  let ev = (await get('?order_id=' + o.order_id)).data.events;
  assert.equal(ev.search_ok, false);
  assert.ok(ev.attempts.length >= 2, 'window, then each PayPal id as transaction_id');
  assert.deepEqual(ev.attempts[0].error, { http: 400, name: 'INVALID_REQUEST', message: err.message, debug_id: 'dbg123abc',
    details: [{ field: 'start_time', value: 'x', location: 'query', issue: 'INVALID_PARAMETER_VALUE', description: 'bad' }] });
  assert.ok(!JSON.stringify(ev).match(/csecret|Bearer|tok"/), 'no secrets');
  const audit = (await sql(`SELECT details FROM admin_audit WHERE action = 'paypal_connection_check' ORDER BY id DESC LIMIT 1`))[0].details;
  assert.equal(audit.events.search_ok, false); assert.equal(audit.events.attempts[0].debug_id, 'dbg123abc');

  // window refused, transaction_id accepted → search ok, the event is found
  mock.eventsReject = (sp) => sp.get('start_time') ? err : null;
  mock.whEvents = [{ id: 'WH-EV-A', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: o.pp } }];
  ev = (await get('?order_id=' + o.order_id)).data.events;
  assert.equal(ev.search_ok, true); assert.equal(ev.attempts[0].ok, false); assert.ok(ev.attempts.some(a => a.ok && a.query.transaction_id === o.pp));
  assert.deepEqual(ev.for_this_order.map(e => e.id), ['WH-EV-A']);

  // search succeeds and finds nothing → search_ok true, zero events (distinct from failure)
  mock.eventsReject = null; mock.whEvents = [];
  ev = (await get('?order_id=' + o.order_id)).data.events;
  assert.equal(ev.search_ok, true); assert.equal(ev.for_this_order.length, 0); assert.equal(ev.attempts.length, 1);
});

test('PC7. the window search uses only documented parameters and follows "next" pages (default page size)', async () => {
  const o = await paidOrder();
  mock.webhooks = [{ id: 'WH-1', url: URL_OK, event_types: all6 }];
  mock.whEvents = Array.from({ length: 23 }, (_, i) => ({ id: 'E' + i, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'other' + i } }));
  mock.whEvents.push({ id: 'E-MINE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'x', supplementary_data: { related_ids: { order_id: o.pp } } } });
  const ev = (await get('?order_id=' + o.order_id)).data.events;
  assert.equal(ev.listed, 24); assert.equal(ev.attempts[0].pages, 3);
  assert.deepEqual(ev.for_this_order.map(e => e.id), ['E-MINE']);
  const first = mock.calls.find(c => /webhooks-events\?/.test(c.url) && !/start=/.test(c.url));
  const keys = [...new URL(first.url).searchParams.keys()].sort();
  assert.deepEqual(keys, ['end_time', 'start_time']);
  assert.match(new URL(first.url).searchParams.get('start_time'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('PC8. a row stored without order_id (before migration 006): the card counts 0, the check shows it as received but unlinked; linking fixes the card without reprocessing', async () => {
  const adminOrder = await import('../api/admin/order.js');
  const manage = await import('../api/admin/manage.js');
  const o = await paidOrder();
  const cap = (await sql(`SELECT capture_id FROM payments WHERE order_id = $1`, [o.order_id]))[0].capture_id;
  mock.webhooks = [{ id: 'WH-1', url: URL_OK, event_types: all6 }];
  mock.whEvents = [
    { id: 'WH-OLD-APPROVED', event_type: 'CHECKOUT.ORDER.APPROVED', create_time: '2026-10-10T02:56:00Z', resource: { id: o.pp } },
    { id: 'WH-OLD-COMPLETED', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-10-10T02:57:00Z', resource: { id: cap, custom_id: o.order_id, supplementary_data: { related_ids: { order_id: o.pp } } } },
    { id: 'WH-OTHER-ORDER', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-NOT-MINE' } },
  ];
  for (const id of ['WH-OLD-APPROVED', 'WH-OLD-COMPLETED', 'WH-OTHER-ORDER'])
    await sql(`INSERT INTO webhook_events (provider, event_id, event_type, verified, processed_at, deliveries, order_id) VALUES ('paypal',$1,'x',true,now(),1,NULL)`, [id]);
  const card = async () => (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data.checks.webhook_deliveries;
  assert.equal(await card(), 0, 'the card counts by order_id only');
  const ev = (await get('?order_id=' + o.order_id)).data.events;
  assert.deepEqual(ev.for_this_order.map(e => [e.id, e.received.processed, e.received.linked, e.received.order_id]),
    [['WH-OLD-APPROVED', true, false, null], ['WH-OLD-COMPLETED', true, false, null]]);
  assert.deepEqual(ev.unlinked.map(u => u.id), ['WH-OLD-APPROVED', 'WH-OLD-COMPLETED']);
  assert.equal(ev.for_this_order[0].paypal.id, 'WH-OLD-APPROVED');

  const before = { pays: await sql(`SELECT * FROM payments WHERE order_id = $1`, [o.order_id]), evs: (await sql(`SELECT count(*)::int n FROM events WHERE order_id = $1`, [o.order_id]))[0].n,
    outbox: (await sql(`SELECT count(*)::int n FROM notify_outbox`))[0].n, make: mock.count(/hook\.make\.test/), posts: mock.calls.filter(c => c.method === 'POST' && /paypal\.com\/v2\//.test(c.url)).length };
  const r = await call(manage.POST, 'POST', '/api/admin/manage', { headers: basic(), body: { action: 'link_webhooks', order_id: o.order_id, event_ids: ['WH-OLD-APPROVED', 'WH-OLD-COMPLETED', 'WH-OTHER-ORDER', 'WH-NEVER-SEEN'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map(x => [x.id, x.result]), [['WH-OLD-APPROVED', 'linked'], ['WH-OLD-COMPLETED', 'linked'], ['WH-OTHER-ORDER', 'not_this_order'], ['WH-NEVER-SEEN', 'not_received']]);
  assert.equal(await card(), 2);
  assert.equal((await sql(`SELECT order_id FROM webhook_events WHERE event_id = 'WH-OTHER-ORDER'`))[0].order_id, null);
  assert.deepEqual(await sql(`SELECT * FROM payments WHERE order_id = $1`, [o.order_id]), before.pays, 'payment untouched');
  assert.equal((await sql(`SELECT count(*)::int n FROM events WHERE order_id = $1`, [o.order_id]))[0].n, before.evs, 'no new events (no purchase_verified)');
  assert.equal((await sql(`SELECT count(*)::int n FROM notify_outbox`))[0].n, before.outbox, 'no message queued');
  assert.equal(mock.count(/hook\.make\.test/), before.make, 'nothing sent');
  assert.equal(mock.calls.filter(c => c.method === 'POST' && /paypal\.com\/v2\//.test(c.url)).length, before.posts, 'no capture');
  const again = await call(manage.POST, 'POST', '/api/admin/manage', { headers: basic(), body: { action: 'link_webhooks', order_id: o.order_id, event_ids: ['WH-OLD-APPROVED'] } });
  assert.equal(again.data.results[0].result, 'already_linked');
  assert.ok((await sql(`SELECT 1 FROM admin_audit WHERE action = 'webhook_link'`)).length >= 1);
  assert.equal((await call(manage.POST, 'POST', '/api/admin/manage', { body: { action: 'link_webhooks', order_id: o.order_id, event_ids: ['WH-OLD-APPROVED'] } })).status, 401);
});

test('PC9. a resend of the COMPLETED event: that event id goes 1→2, no second payment, no second purchase_verified, no payment email', async () => {
  const ppWebhook = await import('../api/paypal/webhook.js');
  const { ppHeaders } = await import('./helpers.js');
  const o = await paidOrder();
  const cap = (await sql(`SELECT capture_id FROM payments WHERE order_id = $1`, [o.order_id]))[0].capture_id;
  const evt = { id: 'WH-17S883833T449544V-5X776969DC421502L', event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: cap, status: 'COMPLETED', custom_id: o.order_id, amount: { currency_code: 'ILS', value: '1290.00' }, supplementary_data: { related_ids: { order_id: o.pp } } } };
  const send = () => call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify(evt), headers: ppHeaders('good') });
  await send();
  const snap = async () => ({ d: (await sql(`SELECT deliveries FROM webhook_events WHERE event_id = $1`, [evt.id]))[0].deliveries,
    pays: (await sql(`SELECT count(*)::int n FROM payments WHERE order_id = $1`, [o.order_id]))[0].n,
    pv: (await sql(`SELECT count(*)::int n FROM events WHERE order_id = $1 AND event_name = 'purchase_verified'`, [o.order_id]))[0].n,
    paidMails: (await sql(`SELECT count(*)::int n FROM notify_outbox WHERE order_id = $1 AND action = 'paid'`, [o.order_id]))[0].n });
  const a = await snap();
  const r = await send();
  assert.equal(r.data.duplicate, true);
  const b = await snap();
  assert.deepEqual([a.d, b.d], [1, 2]);
  assert.deepEqual([b.pays, b.pv, b.paidMails], [a.pays, a.pv, a.paidMails]);
});
