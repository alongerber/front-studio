// Meital may say "the payment arrived" only after the server says so. These tests cover the check_payment
// server tool (api/agent/payment-status.js) and the post-call audit of payment claims.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, ppHeaders, elSign, uuid4, failNext } from './helpers.js';

import * as order from '../api/order.js';
import * as agentLink from '../api/agent-link.js';
import * as ppCreate from '../api/paypal/create.js';
import * as ppCapture from '../api/paypal/capture.js';
import * as ppWebhook from '../api/paypal/webhook.js';
import * as note from '../api/brief/note.js';
import * as finish from '../api/brief/finish.js';
import * as contact from '../api/brief/contact.js';
import * as payStatus from '../api/agent/payment-status.js';
import * as elWebhook from '../api/elevenlabs/webhook.js';

beforeEach(freshDb);

const key = () => ('k' + uuid4().replace(/-/g, '')).slice(0, 32);
async function newOrder(link) {
  const r = await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4(), agent_link: link } });
  assert.equal(r.status, 201); return r.data;
}
async function pay(o) {
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  return call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
}
const check = (body) => call(payStatus.POST, 'POST', '/api/agent/payment-status', { body });
const status = (o) => call(order.GET, 'GET', '/api/order?order_id=' + o.order_id, { headers: { 'x-order-token': o.token } }).then(r => r.data.order);

test('P1. a new unpaid order: not_paid, and the instruction forbids saying it arrived', async () => {
  const k = key(); const o = await newOrder(k);
  const r = await check({ link: k });
  assert.equal(r.status, 200);
  assert.equal(r.data.payment, 'not_paid'); assert.equal(r.data.order_id, o.order_id);
  assert.match(r.data.instruction, /אסור לומר שהתשלום התקבל/);
  assert.match(r.data.instruction, /אני עדיין לא רואה אישור תשלום/);
  assert.ok(Date.parse(r.data.checked_at));
});

test('P2. a capture PayPal still holds for review: pending, not verified', async () => {
  const k = key(); const o = await newOrder(k);
  mock.captureStatus = 'PENDING'; await pay(o);
  assert.equal((await status(o)).paid, false);
  const r = await check({ link: k });
  assert.equal(r.data.payment, 'pending'); assert.match(r.data.instruction, /אסור לומר שהתשלום התקבל/);
});

test('P3. a verified payment: verified, only after the server captured it', async () => {
  const k = key(); const o = await newOrder(k);
  assert.equal((await check({ link: k })).data.payment, 'not_paid');
  await pay(o);
  const r = await check({ link: k });
  assert.equal(r.data.payment, 'verified'); assert.match(r.data.instruction, /מותר לומר שהתשלום התקבל/);
});

test('P4. a full refund: refunded, never verified again', async () => {
  const k = key(); const o = await newOrder(k); await pay(o);
  await call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-REF', event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'RF1', status: 'COMPLETED', custom_id: o.order_id, amount: { value: '1290.00', currency_code: 'ILS' } } }), headers: ppHeaders() });
  const r = await check({ link: k });
  assert.equal(r.data.payment, 'refunded'); assert.match(r.data.instruction, /אסור לומר שהתשלום התקבל/);
});

test('P5. the database fails: an error, never a guessed status', async () => {
  const k = key(); const o = await newOrder(k); await pay(o);
  failNext(/agent_links/);
  const r = await check({ link: k });
  assert.equal(r.status, 500); assert.equal(r.data.payment, undefined);
});

test('P6. another order cannot be read: the order id in the request is ignored, unknown keys see nothing', async () => {
  const kA = key(), kB = key();
  const A = await newOrder(kA); const B = await newOrder(kB); await pay(B);
  const r = await check({ link: kA, order_id: B.order_id });           // A's conversation asks about B
  assert.equal(r.data.payment, 'not_paid'); assert.equal(r.data.order_id, A.order_id);
  assert.equal(JSON.stringify(r.data).includes(B.order_id), false);
  const none = await check({ link: key(), order_id: B.order_id });      // a key nobody attached
  assert.equal(none.data.payment, 'no_order'); assert.equal(none.data.order_id, null);
  assert.equal((await check({ order_id: B.order_id })).data.payment, 'no_order');
  for (const k of Object.keys(r.data)) assert.ok(['ok', 'payment', 'order_id', 'checked_at', 'instruction'].includes(k), 'no other order data: ' + k);
  // a link can only be attached with the order's token
  const steal = await call(agentLink.POST, 'POST', '/api/agent-link', { body: { order_id: B.order_id, token: A.token, agent_link: kA } });
  assert.equal(steal.status, 404);
  assert.equal((await check({ link: kA })).data.order_id, A.order_id);
});

test('P7. "I paid" changes nothing: notes, the agent and the client cannot write payment', async () => {
  const k = key(); const o = await newOrder(k);
  await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field: 'other', value: 'שילמתי' } });
  await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field: 'paid', value: 'true' } });
  assert.equal((await check({ link: k })).data.payment, 'not_paid');
  assert.equal((await status(o)).paid, false);
  await call(contact.POST, 'POST', '/api/brief/contact', { body: { order_id: o.order_id, token: o.token, name: 'דנה', phone: '0501234567' } });
  const f = await call(finish.POST, 'POST', '/api/brief/finish', { body: { order_id: o.order_id, token: o.token } });
  assert.equal(f.status, 409); assert.equal(f.data.error, 'payment_required');
});

test('P8. a tab that starts a new checkout after an older paid order answers for the new, unpaid order', async () => {
  const k = key(); const old = await newOrder(k); await pay(old);
  assert.equal((await check({ link: k })).data.payment, 'verified');
  await sql(`UPDATE orders SET created_at = now() - interval '1 hour' WHERE order_id = $1`, [old.order_id]);
  const fresh = await newOrder(k);
  const r = await check({ link: k });
  assert.equal(r.data.order_id, fresh.order_id); assert.equal(r.data.payment, 'not_paid');
});

test('P9. back to the brief after paying: what was said before payment is still there, and the check says verified', async () => {
  const k = key(); const o = await newOrder(k);
  for (const [field, value] of [['business_type', 'מועדון סנוקר'], ['promote', 'ערבי צוות']])
    await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field, value } });
  await pay(o);
  // a new conversation later (another tab: new link key) attached with the token from the personal link
  const k2 = key();
  assert.equal((await call(agentLink.POST, 'POST', '/api/agent-link', { body: { order_id: o.order_id, token: o.token, agent_link: k2 } })).status, 200);
  const r = await check({ link: k2 });
  assert.equal(r.data.payment, 'verified'); assert.equal(r.data.order_id, o.order_id);
  const s = await status(o);
  assert.deepEqual(s.brief, { business_type: 'מועדון סנוקר', promote: 'ערבי צוות' });
  assert.equal(s.paid, true);
  await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field: 'audience', value: 'מנהלי משאבי אנוש' } });
  assert.equal((await status(o)).brief.audience, 'מנהלי משאבי אנוש');
  assert.equal(mock.count(/\/v2\/checkout\/orders$/), 1, 'paid once, never asked to pay again');
});

/* ── post-call audit ── */
function delivery(conv, link, transcript) {
  return JSON.stringify({ type: 'post_call_transcription', event_timestamp: 1, data: {
    agent_id: 'agent_test', conversation_id: conv, status: 'done', transcript,
    metadata: { start_time_unix_secs: 1791500000, call_duration_secs: 60 }, analysis: {},
    conversation_initiation_client_data: { dynamic_variables: { front_link: link, payment_status: 'verified' } } } });
}
const claims = () => sql(`SELECT conversation_id, props FROM events WHERE event_name = 'agent_unverified_payment_claim' ORDER BY conversation_id`);

test('P10. post-call: "the payment arrived" without a verified check is recorded; with one it is not', async () => {
  const k = key(); await newOrder(k);
  const bad = delivery('conv_bad', k, [
    { role: 'user', message: 'יאללה שילמתי בואי נאפיין', time_in_call_secs: 165 },
    { role: 'agent', message: 'התשלום התקבל, מעולה. בוא נתחיל באפיון.', time_in_call_secs: 165 }]);
  const notPaid = delivery('conv_np', k, [
    { role: 'user', message: 'שילמתי', time_in_call_secs: 10 },
    { role: 'agent', message: '', tool_calls: [{ tool_name: 'check_payment' }], tool_results: [{ tool_name: 'check_payment', result_value: '{"ok":true,"payment":"not_paid"}', is_error: false }], time_in_call_secs: 11 },
    { role: 'agent', message: 'התשלום התקבל!', time_in_call_secs: 11 }]);
  const good = delivery('conv_good', k, [
    { role: 'user', message: 'שילמתי', time_in_call_secs: 10 },
    { role: 'agent', message: '', tool_results: [{ tool_name: 'check_payment', result_value: '{"ok":true,"payment":"verified","order_id":"FR-AAAA-BBBB"}', is_error: false }], time_in_call_secs: 11 },
    { role: 'agent', message: 'התשלום התקבל. נמשיך לאפיון.', time_in_call_secs: 11 },
    { role: 'agent', message: 'אני עדיין לא רואה אישור תשלום.', time_in_call_secs: 20 }]);
  for (const raw of [bad, notPaid, good]) {
    const r = await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } });
    assert.equal(r.status, 200);
  }
  const c = await claims();
  assert.deepEqual(c.map(x => x.conversation_id), ['conv_bad', 'conv_np']);
  assert.deepEqual(c[0].props.at_secs, [165]);
});
