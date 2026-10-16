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

import * as elWebhook from '../api/elevenlabs/webhook.js';
import * as payStatus from '../api/agent/payment-status.js';
import { elSign } from './helpers.js';

async function paidOrder(link) {
  const o = await newOrder(link);
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
  return o;
}

test('S6. an old tab (no page protocol header) cannot save notes, and nothing changes', async () => {
  const o = await newOrder(key());
  const r = await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field: 'business_type', value: 'מספרה' }, headers: { 'x-front-proto': '' } });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'page_outdated');
  assert.deepEqual(await brief(o), {});
});

test('S7. a note returns what was really saved', async () => {
  const o = await newOrder(key());
  const r = await save(o, 'business_type', 'מספרה');
  assert.equal(r.data.saved, 'business_type'); assert.equal(r.data.order_id, o.order_id);
  const e = await save(o, 'audience', '   ');
  assert.equal(e.data.saved, null);
});

test('S8. a sales conversation cannot write onto a paid order (salon case), and the paid brief is untouched', async () => {
  const o = await paidOrder(key());
  await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field: 'business_type', value: 'ניקוי ספות', phase: 'brief' } });
  const r = await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field: 'business_type', value: 'מספרה', phase: 'sales' } });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'paid_order');
  assert.deepEqual(await brief(o), { business_type: 'ניקוי ספות' });
});

test('S9. new ad: the link key moves explicitly; notes, check_payment and the post-call webhook all go to the new order', async () => {
  const k = key(); const a = await paidOrder(k);
  const before = await sql(`SELECT brief, status, paid_at FROM orders WHERE order_id = $1`, [a.order_id]);
  const b = await newOrder(k);                                               // the page's single request: create + attach
  const links = Object.fromEntries((await sql(`SELECT order_id, agent_links FROM orders WHERE order_id = any($1)`, [[a.order_id, b.order_id]])).map(r => [r.order_id, r.agent_links]));
  assert.deepEqual([links[a.order_id].includes(k), links[b.order_id].includes(k)], [false, true]);
  const moved = await sql(`SELECT props FROM events WHERE event_name = 'agent_link_moved' AND order_id = $1`, [b.order_id]);
  assert.deepEqual(moved[0].props.from, [a.order_id]);
  await save(b, 'business_type', 'מספרה');
  assert.equal((await call(payStatus.POST, 'POST', '/api/agent/payment-status', { body: { link: k } })).data.order_id, b.order_id);
  const conv = 'conv_' + uuid4().replace(/-/g, '');
  const raw = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: conv, agent_id: process.env.ELEVENLABS_AGENT_ID || 'agent_test', status: 'done',
    metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000) - 60, call_duration_secs: 60 }, transcript: [{ role: 'user', message: 'מספרה', time_in_call_secs: 1 }],
    conversation_initiation_client_data: { dynamic_variables: { front_link: k, order_id: a.order_id } } } });
  assert.equal((await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } })).status, 200);
  assert.equal((await sql(`SELECT order_id FROM conversations WHERE conversation_id = $1`, [conv]))[0].order_id, b.order_id);
  assert.deepEqual(await sql(`SELECT brief, status, paid_at FROM orders WHERE order_id = $1`, [a.order_id]), before);   // the paid order did not change
});

test('S10. a retried creation (same client_ref) returns the same order with a working token, never a duplicate', async () => {
  const ref = uuid4(); const body = { consent: { analytics: 'denied', ads: 'denied' }, client_ref: ref };
  const r1 = await call(order.POST, 'POST', '/api/order', { body });
  const n1 = (await sql(`SELECT count(*)::int c FROM orders`))[0].c;
  const r2 = await call(order.POST, 'POST', '/api/order', { body });
  assert.equal(r1.data.order_id, r2.data.order_id); assert.equal(r2.data.reused, true);
  assert.equal((await sql(`SELECT count(*)::int c FROM orders`))[0].c, n1);
  assert.equal((await save({ order_id: r2.data.order_id, token: r2.data.token }, 'business_type', 'מספרה')).status, 200);
  assert.equal((await save({ order_id: r1.data.order_id, token: r1.data.token }, 'business_type', 'x')).status, 404);   // the lost first token is void
});
