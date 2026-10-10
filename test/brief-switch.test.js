// Another business in the same browser: the agent asks first, then either starts a new ad (new order,
// the previous one untouched) or changes the direction of the unpaid order (previous details archived, never deleted).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, basic, uuid4 } from './helpers.js';

import * as order from '../api/order.js';
import * as agentLink from '../api/agent-link.js';
import * as ppCreate from '../api/paypal/create.js';
import * as ppCapture from '../api/paypal/capture.js';
import * as note from '../api/brief/note.js';
import * as adminOrder from '../api/admin/order.js';
import { orderForLink } from '../lib/store.js';

beforeEach(freshDb);

const key = () => ('k' + uuid4().replace(/-/g, '')).slice(0, 32);
async function newOrder(link) {
  const r = await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4(), agent_link: link } });
  assert.equal(r.status, 201); return r.data;
}
const save = (o, field, value) => call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field, value } });
const brief = async (o) => (await sql(`SELECT brief FROM orders WHERE order_id = $1`, [o.order_id]))[0].brief;

test('S1. reproduces the sofa case: a plain note overwrites one field and leaves the old tone', async () => {
  const o = await newOrder(key());
  await save(o, 'business_type', 'מועדון בינגו לגיל הזהב'); await save(o, 'tone', 'סופר קומי ומופרע');
  await save(o, 'business_type', 'עסק לניקוי ספות');
  assert.deepEqual(await brief(o), { business_type: 'עסק לניקוי ספות', tone: 'סופר קומי ומופרע' });
});

test('S2. change_direction archives the previous details as an event and starts an empty brief', async () => {
  const o = await newOrder(key());
  await save(o, 'business_type', 'מועדון בינגו לגיל הזהב'); await save(o, 'tone', 'סופר קומי ומופרע');
  const r = await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, action: 'change_direction' } });
  assert.equal(r.status, 200); assert.equal(r.data.archived, true);
  assert.deepEqual(await brief(o), {});
  const ev = await sql(`SELECT props FROM events WHERE event_name = 'brief_direction_changed' AND order_id = $1`, [o.order_id]);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].props.previous, { business_type: 'מועדון בינגו לגיל הזהב', tone: 'סופר קומי ומופרע' });
  await save(o, 'business_type', 'עסק לניקוי ספות');
  assert.deepEqual(await brief(o), { business_type: 'עסק לניקוי ספות' });
});

test('S3. change_direction is refused on a paid order and changes nothing', async () => {
  const o = await newOrder(key());
  await save(o, 'business_type', 'מספרה');
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
  const r = await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, action: 'change_direction' } });
  assert.equal(r.status, 409);
  assert.deepEqual(await brief(o), { business_type: 'מספרה' });
});

test('S4. new_ad: a new order carries the same link key; the conversation links to the new order, the old one is untouched', async () => {
  const k = key(); const a = await newOrder(k);
  await save(a, 'business_type', 'מועדון בינגו לגיל הזהב');
  const b = await newOrder(null);
  assert.equal((await call(agentLink.POST, 'POST', '/api/agent-link', { body: { order_id: b.order_id, token: b.token, agent_link: k } })).status, 200);
  await save(b, 'business_type', 'עסק לניקוי ספות');
  assert.equal((await orderForLink(k)).order_id, b.order_id);
  assert.deepEqual(await brief(a), { business_type: 'מועדון בינגו לגיל הזהב' });
});

test('S5. dashboard: an unpaid order shows no failed matches, only "not paid"', async () => {
  const o = await newOrder(key());
  const k = (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data.checks;
  assert.equal(k.has_payment, false);
  assert.deepEqual([k.amount_matches, k.currency_matches, k.payee_matches], [null, null, null]);
  assert.equal(k.purchase_verified_events, 0);
});
