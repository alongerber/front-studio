// Regression tests for the review findings (09/10). Each test reproduces the failure first, then checks the fix.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { freshDb, sql, mock, call, basic, ppHeaders, elSign, uuid4, failNext } from './helpers.js';
import { setDb } from '../lib/db.js';

import * as order from '../api/order.js';
import * as ppCreate from '../api/paypal/create.js';
import * as ppCapture from '../api/paypal/capture.js';
import * as ppWebhook from '../api/paypal/webhook.js';
import * as note from '../api/brief/note.js';
import * as contact from '../api/brief/contact.js';
import * as finish from '../api/brief/finish.js';
import * as consentApi from '../api/consent.js';
import * as elWebhook from '../api/elevenlabs/webhook.js';
import * as cron from '../api/cron/meta-flush.js';
import * as adminRecover from '../api/admin/recover.js';
import * as adminOrder from '../api/admin/order.js';
import * as configApi from '../api/config.js';
import { cfg } from '../lib/config.js';

beforeEach(freshDb);

const GRANTED = { analytics: 'granted', ads: 'granted' };
const DENIED = { analytics: 'denied', ads: 'denied' };
async function newOrder(consent = GRANTED, extra = {}) {
  const r = await call(order.POST, 'POST', '/api/order', { body: { consent, anonymous_id: uuid4(), session_id: uuid4(), fbc: 'fb.1.1.abc', fbp: 'fb.1.1.2', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data;
}
async function pay(o) {
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  return call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
}
const status = (o) => call(order.GET, 'GET', '/api/order?order_id=' + o.order_id, { headers: { 'x-order-token': o.token } }).then(r => r.data.order);
const cnt = async (q, p = []) => (await sql(q, p))[0].c;
const dueNow = async () => { await sql(`UPDATE meta_outbox SET next_attempt_at = now()`); await sql(`UPDATE notify_outbox SET next_attempt_at = now()`); };   // the backoff window has passed
const runCron = () => call(cron.GET, 'GET', '/api/cron/meta-flush', { headers: { authorization: 'Bearer cron-secret' } });
async function fillBrief(o, fields = { business_type: 'מספרה', promote: 'תספורת גברים' }) {
  for (const [field, value] of Object.entries(fields)) await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field, value } });
}
const addContact = (o) => call(contact.POST, 'POST', '/api/brief/contact', { body: { order_id: o.order_id, token: o.token, name: 'דנה', phone: '0501234567', email: 'dana@example.com' } });
const doFinish = (o) => call(finish.POST, 'POST', '/api/brief/finish', { body: { order_id: o.order_id, token: o.token } });

/* ── 1. finish requires payment and minimum content ── */
test('F1a. finishing without payment is refused; notes before payment are still saved', async () => {
  const o = await newOrder();
  await fillBrief(o); await addContact(o);
  const r = await doFinish(o);
  assert.equal(r.status, 409); assert.equal(r.data.error, 'payment_required');
  const [row] = await sql(`SELECT brief, brief_done_at FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.equal(row.brief_done_at, null);
  assert.equal(row.brief.business_type, 'מספרה', 'pre-payment notes are kept');
  assert.equal(await cnt(`SELECT count(*)::int c FROM notify_outbox WHERE action = 'finish'`), 0, 'no production email');
  assert.equal(mock.count(/hook\.make\.test/), 0);
});
test('F1b. finishing a paid order with no content is refused and says what is missing', async () => {
  const o = await newOrder(); await pay(o); await addContact(o);
  const r = await doFinish(o);
  assert.equal(r.status, 409); assert.equal(r.data.error, 'brief_incomplete');
  assert.deepEqual(r.data.missing.sort(), ['business_type', 'promote']);
  await fillBrief(o, { business_name: 'מספרת דנה' });
  assert.deepEqual((await doFinish(o)).data.missing, ['promote'], 'business_name counts as the business');
  await fillBrief(o, { promote: 'תספורת' });
  const ok = await doFinish(o);
  assert.equal(ok.status, 200); assert.equal(ok.data.saved, true);
  assert.equal(await cnt(`SELECT count(*)::int c FROM notify_outbox WHERE action = 'finish' AND status = 'sent'`), 1);
});

/* ── 2. paid + event + queue are atomic; a retry recovers ── */
test('F2a. Meta queue insert fails → nothing is marked paid; the retry stores paid AND the queue', async () => {
  const o = await newOrder();
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  failNext(/INSERT INTO meta_outbox/);
  const r1 = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
  assert.equal(r1.status, 500);
  const [after1] = await sql(`SELECT paid_at FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.equal(after1.paid_at, null, 'not paid without its queue (atomic)');
  assert.equal(await cnt(`SELECT count(*)::int c FROM events WHERE event_name = 'purchase_verified'`), 0);
  // PayPal retries the webhook for the same capture
  const cap = mock.pp.get(pp.data.id).purchase_units[0].payments.captures[0];
  const w = await call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-R', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: cap }), headers: ppHeaders() });
  assert.equal(w.status, 200);
  const [row] = await sql(`SELECT status FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.equal(row.status, 'paid');
  assert.equal(await cnt(`SELECT count(*)::int c FROM meta_outbox WHERE order_id = $1`, [o.order_id]), 1, 'queue is NOT empty after the retry');
  assert.equal(await cnt(`SELECT count(*)::int c FROM meta_outbox WHERE order_id = $1 AND status = 'sent'`, [o.order_id]), 1);
  assert.equal(await cnt(`SELECT count(*)::int c FROM events WHERE event_name = 'purchase_verified'`), 1);
  assert.equal(mock.count(/graph\.facebook/), 1);
});
test('F2b. the stored capture alone is enough: the recovery sweep marks the order paid without any webhook', async () => {
  const o = await newOrder();
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  failNext(/WITH paid AS/);                                     // the atomic step itself fails
  assert.equal((await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } })).status, 500);
  assert.equal(await cnt(`SELECT count(*)::int c FROM payments WHERE status = 'COMPLETED'`), 1, 'the verified capture was stored');
  const r = await runCron();
  assert.equal(r.data.repaired_payments, 1);
  assert.equal((await status(o)).paid, true);
  assert.equal(await cnt(`SELECT count(*)::int c FROM notify_outbox WHERE id = $1 AND status = 'sent'`, ['paid:' + o.order_id]), 1);
});
test('F2c. rows lost by any other path are re-created by the sweep (and Purchase still sent once)', async () => {
  const o = await newOrder(); await pay(o);
  await sql(`DELETE FROM meta_outbox`); await sql(`DELETE FROM events WHERE event_name = 'purchase_verified'`); await sql(`DELETE FROM notify_outbox`);
  const before = mock.count(/graph\.facebook/);
  const r = await runCron();
  assert.equal(r.data.side_effects, 1);
  assert.equal(await cnt(`SELECT count(*)::int c FROM events WHERE event_name = 'purchase_verified'`), 1);
  assert.equal(await cnt(`SELECT count(*)::int c FROM meta_outbox`), 1);
  assert.equal(mock.count(/graph\.facebook/) - before, 1, 'Meta deduplicates by event_id = order_id; we resend once');
});

/* ── 3. refunds change the order state ── */
test('F3. a full refund makes the order not paid, cancels an unsent Purchase, and blocks production', async () => {
  mock.metaFail = true;                                          // Purchase not delivered yet when the refund arrives
  const o = await newOrder(); await pay(o); await fillBrief(o); await addContact(o);
  assert.equal((await status(o)).paid, true);
  await call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-REF', event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'RF1', status: 'COMPLETED', custom_id: o.order_id, amount: { value: '1290.00', currency_code: 'ILS' } } }), headers: ppHeaders() });
  const s = await status(o);
  assert.equal(s.paid, false); assert.equal(s.refunded, true); assert.equal(s.status, 'refunded');
  assert.equal((await sql(`SELECT status FROM meta_outbox WHERE order_id = $1`, [o.order_id]))[0].status, 'cancelled_refund');
  mock.metaFail = false; await dueNow(); await runCron();
  assert.equal(mock.count(/graph\.facebook/), 1, 'only the failed attempt before the refund; nothing after');
  assert.equal((await doFinish(o)).data.error, 'payment_required');
  // a re-delivered COMPLETED capture does not resurrect the order
  const cap = [...mock.pp.values()][0].purchase_units[0].payments.captures[0];
  await call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-LATE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: cap }), headers: ppHeaders() });
  assert.equal((await status(o)).paid, false);
});
test('F3b. a partial refund keeps the order paid and shows it', async () => {
  const o = await newOrder(); await pay(o);
  await call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-PREF', event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'RF2', status: 'COMPLETED', custom_id: o.order_id, amount: { value: '200.00', currency_code: 'ILS' } } }), headers: ppHeaders() });
  const s = await status(o);
  assert.equal(s.paid, true); assert.equal(s.status, 'partially_refunded'); assert.equal(s.refunded, false);
});

test('F3c. partial refunds that add up to the full amount end the order like a full refund', async () => {
  mock.metaFail = true;                                          // Purchase still queued when the refunds arrive
  const o = await newOrder(); await pay(o);
  const refund = (id, value) => call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-' + id, event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id, status: 'COMPLETED', custom_id: o.order_id, amount: { value, currency_code: 'ILS' } } }), headers: ppHeaders() });
  await refund('RF-P1', '600.00');
  assert.equal((await status(o)).status, 'partially_refunded');
  await refund('RF-P2', '690.00');                               // 600 + 690 = 1290 = everything
  const s = await status(o);
  assert.equal(s.paid, false); assert.equal(s.refunded, true); assert.equal(s.status, 'refunded');
  assert.equal((await sql(`SELECT status FROM meta_outbox WHERE order_id = $1`, [o.order_id]))[0].status, 'cancelled_refund');
  await refund('RF-P1', '600.00');                               // a re-delivered refund is not counted twice
  assert.equal(await cnt(`SELECT count(*)::int c FROM payments WHERE order_id = $1 AND capture_id LIKE 'refund:%'`, [o.order_id]), 2);
});
test('F3d. a refund without custom_id is matched to the order through its capture', async () => {
  const o = await newOrder(); await pay(o);
  const cap = [...mock.pp.values()][0].purchase_units[0].payments.captures[0];
  await call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-NOCID', event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'RF-N1', status: 'COMPLETED', amount: { value: '1290.00', currency_code: 'ILS' },
      links: [{ rel: 'self', href: 'https://api.sandbox.paypal.com/v2/payments/refunds/RF-N1' },
              { rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/' + cap.id }] } }), headers: ppHeaders() });
  const s = await status(o);
  assert.equal(s.paid, false); assert.equal(s.status, 'refunded');
  assert.equal(await cnt(`SELECT count(*)::int c FROM webhook_events WHERE event_id = 'WH-NOCID' AND error IS NULL`), 1);
});

test('F3e. a queued "go to production" email is not sent after a full refund', async () => {
  const o = await newOrder(); await pay(o); await fillBrief(o); await addContact(o);
  mock.makeFail = true;                                          // Make is down: the finish email stays queued
  assert.equal((await doFinish(o)).data.notified, false);
  const refund = (id, value) => call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-' + id, event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id, status: 'COMPLETED', custom_id: o.order_id, amount: { value, currency_code: 'ILS' } } }), headers: ppHeaders() });
  await refund('RF-E1', '1290.00');
  mock.makeFail = false; await dueNow(); await runCron();
  assert.equal(mock.calls.filter(c => /hook\.make\.test/.test(c.url) && c.body.includes('a=finish')).length, 1, 'only the failed attempt before the refund');
  assert.equal((await sql(`SELECT status FROM notify_outbox WHERE id = $1`, ['finish:' + o.order_id]))[0].status, 'cancelled_refund');
});
test('F3f. partial refunds that add up to the full amount also cancel a queued production email', async () => {
  const o = await newOrder(); await pay(o); await fillBrief(o); await addContact(o);
  mock.makeFail = true; await doFinish(o);
  const refund = (id, value) => call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-' + id, event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id, status: 'COMPLETED', custom_id: o.order_id, amount: { value, currency_code: 'ILS' } } }), headers: ppHeaders() });
  await refund('RF-F1', '290.00');
  mock.makeFail = false; await dueNow(); await runCron();          // partial: the email still goes out
  assert.equal((await sql(`SELECT status FROM notify_outbox WHERE id = $1`, ['finish:' + o.order_id]))[0].status, 'sent');
  const o2 = await newOrder(); await pay(o2); await fillBrief(o2); await addContact(o2);
  mock.makeFail = true; await doFinish(o2);
  const refund2 = (id, value) => call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw: JSON.stringify({ id: 'WH-' + id, event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id, status: 'COMPLETED', custom_id: o2.order_id, amount: { value, currency_code: 'ILS' } } }), headers: ppHeaders() });
  await refund2('RF-F2', '600.00'); await refund2('RF-F3', '690.00');
  const before = mock.calls.filter(c => /hook\.make\.test/.test(c.url) && c.body.includes('a=finish') && c.body.includes(o2.order_id)).length;
  mock.makeFail = false; await dueNow(); await runCron();
  const after = mock.calls.filter(c => /hook\.make\.test/.test(c.url) && c.body.includes('a=finish') && c.body.includes(o2.order_id)).length;
  assert.equal(after, before, 'nothing sent after the refunds added up to the full amount');
  assert.equal((await sql(`SELECT status FROM notify_outbox WHERE id = $1`, ['finish:' + o2.order_id]))[0].status, 'cancelled_refund');
});

test('F8. outside production a Purchase is never sent to Meta without a test event code', async () => {
  const saved = process.env.META_TEST_EVENT_CODE; delete process.env.META_TEST_EVENT_CODE;
  try {
    const before = mock.count(/graph\.facebook/);
    const o = await newOrder(); await pay(o);
    assert.equal(mock.count(/graph\.facebook/), before, 'nothing sent');
    assert.equal((await sql(`SELECT last_error FROM meta_outbox WHERE order_id = $1`, [o.order_id]))[0].last_error, 'test_code_required');
    process.env.META_TEST_EVENT_CODE = 'TEST123'; await dueNow(); await runCron();
    const sent = mock.calls.filter(c => /graph\.facebook/.test(c.url)).pop();
    assert.equal(JSON.parse(sent.body).test_event_code, 'TEST123', 'sent as a test event once the code exists');
  } finally { process.env.META_TEST_EVENT_CODE = saved; }
});

test('F9. outside production PayPal is always sandbox and the browser is told it is a test', async () => {
  const saved = { env: process.env.FRONT_ENV, pp: process.env.PAYPAL_ENV };
  try {
    process.env.PAYPAL_ENV = 'live';
    for (const e of ['preview', 'development', 'test']) {
      process.env.FRONT_ENV = e;
      assert.equal(cfg.paypal.env, 'sandbox', e + ': PAYPAL_ENV=live is ignored');
      assert.match(cfg.paypal.base, /sandbox\.paypal\.com/);
      const r = await call(configApi.GET, 'GET', '/api/config');
      assert.equal(r.data.test_mode, true); assert.equal(r.data.paypal_env, 'sandbox');
    }
    process.env.FRONT_ENV = 'production';
    assert.equal(cfg.paypal.env, 'live'); assert.equal(cfg.paypal.base, 'https://api-m.paypal.com');
    assert.equal((await call(configApi.GET, 'GET', '/api/config')).data.test_mode, false);
  } finally { process.env.FRONT_ENV = saved.env; process.env.PAYPAL_ENV = saved.pp; }
});

test('F10. approved delivery time opens production checkout; without one, production takes no PayPal payment', async () => {
  const saved = { env: process.env.FRONT_ENV, d: process.env.DELIVERY_TIME_TEXT, a: cfg.approvedDeliveryTime };
  try {
    delete process.env.DELIVERY_TIME_TEXT;
    process.env.FRONT_ENV = 'production';
    const appr = (await call(configApi.GET, 'GET', '/api/config')).data;
    assert.equal(appr.checkout_open, true); assert.equal(appr.delivery_time, '7 ימי עסקים מרגע ההזמנה');
    process.env.FRONT_ENV = saved.env;
    cfg.approvedDeliveryTime = '';
    const o = await newOrder();
    process.env.FRONT_ENV = 'production';
    assert.equal((await call(configApi.GET, 'GET', '/api/config')).data.checkout_open, false);
    const before = mock.count(/paypal/);
    const r = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
    assert.equal(r.status, 409); assert.equal(r.data.error, 'checkout_closed_delivery_time');
    assert.equal(mock.count(/paypal/), before, 'PayPal never called');
    process.env.DELIVERY_TIME_TEXT = 'עד 10 ימי עבודה מאישור התסריט';
    const c = (await call(configApi.GET, 'GET', '/api/config')).data;
    assert.equal(c.checkout_open, true); assert.equal(c.delivery_time, 'עד 10 ימי עבודה מאישור התסריט');
    process.env.FRONT_ENV = 'test'; delete process.env.DELIVERY_TIME_TEXT;
    const ok = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
    assert.equal(ok.status, 200, 'preview/test: sandbox checkout stays open without a delivery time');
  } finally { cfg.approvedDeliveryTime = saved.a; process.env.FRONT_ENV = saved.env; if (saved.d === undefined) delete process.env.DELIVERY_TIME_TEXT; else process.env.DELIVERY_TIME_TEXT = saved.d; }
});

/* ── 4. consent changes follow the order and are checked at send time ── */
test('F4a. ads consent withdrawn after payment (Purchase still queued) → nothing is sent, matching data removed', async () => {
  mock.metaFail = true;
  const o = await newOrder(); await pay(o);
  const sentBefore = mock.count(/graph\.facebook/);
  const r = await call(consentApi.POST, 'POST', '/api/consent', { body: { order_id: o.order_id, token: o.token, consent: { analytics: 'granted', ads: 'denied' } } });
  assert.equal(r.status, 200);
  const [row] = await sql(`SELECT consent, meta_user FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.equal(row.consent.ads, 'denied'); assert.equal(row.meta_user, null);
  mock.metaFail = false; await dueNow(); await runCron();
  assert.equal(mock.count(/graph\.facebook/), sentBefore, 'no Purchase after withdrawal');
  assert.equal((await sql(`SELECT status FROM meta_outbox WHERE order_id = $1`, [o.order_id]))[0].status, 'no_consent');
});
test('F4b. ads consent given after payment → the queued Purchase is sent with the new matching data', async () => {
  const o = await newOrder(DENIED); await pay(o);
  assert.equal(mock.count(/graph\.facebook/), 0);
  assert.equal((await sql(`SELECT status FROM meta_outbox`))[0].status, 'no_consent');
  await call(consentApi.POST, 'POST', '/api/consent', { body: { order_id: o.order_id, token: o.token, consent: GRANTED, fbc: 'fb.1.1700000000000.NEWCLICK', anonymous_id: uuid4(), session_id: uuid4() } });
  await runCron();
  assert.equal(mock.count(/graph\.facebook/), 1);
  const sent = JSON.parse(mock.calls.find(c => /graph\.facebook/.test(c.url)).body);
  assert.equal(sent.data[0].user_data.fbc, 'fb.1.1700000000000.NEWCLICK');
  assert.ok((await sql(`SELECT anonymous_id FROM orders`))[0].anonymous_id, 'analytics ids attached after consent');
});
test('F4c. analytics consent withdrawn → ids and attribution removed from the order', async () => {
  const o = await newOrder(GRANTED, { last_touch: { utm_source: 'facebook' } });
  await call(consentApi.POST, 'POST', '/api/consent', { body: { order_id: o.order_id, token: o.token, consent: { analytics: 'denied', ads: 'granted' } } });
  const [row] = await sql(`SELECT anonymous_id, session_id, attribution FROM orders`);
  assert.deepEqual([row.anonymous_id, row.session_id, row.attribution], [null, null, null]);
  const other = await newOrder();
  assert.equal((await call(consentApi.POST, 'POST', '/api/consent', { body: { order_id: o.order_id, token: other.token, consent: DENIED } })).status, 404, 'needs the order token');
});

/* ── 5. ElevenLabs: no conversation is lost ── */
function elPayload(key) {
  return JSON.stringify({ type: 'post_call_transcription', data: { agent_id: 'agent_test', conversation_id: 'conv_durable', status: 'done',
    transcript: [{ role: 'agent', message: 'היי' }, { role: 'user', message: 'יש לי מוסך' }], metadata: { start_time_unix_secs: 1791500000 },
    analysis: { transcript_summary: 'מוסך' }, conversation_initiation_client_data: { dynamic_variables: { front_link: key } } } });
}
test('F5a. processing fails → 200, the delivery is kept and replayed by the sweep', async () => {
  const key = 'durable_' + 'd'.repeat(30); const o = await newOrder(GRANTED, { agent_link: key });
  const raw = elPayload(key);
  failNext(/INSERT INTO conversations/);
  const r = await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } });
  assert.equal(r.status, 200); assert.equal(r.data.queued_for_retry, true);
  const [w] = await sql(`SELECT processed_at, payload IS NOT NULL AS has_payload, attempts FROM webhook_events WHERE provider = 'elevenlabs'`);
  assert.equal(w.processed_at, null); assert.equal(w.has_payload, true); assert.equal(w.attempts, 1);
  assert.equal(await cnt(`SELECT count(*)::int c FROM conversations`), 0);
  const rec = await call(adminRecover.POST, 'POST', '/api/admin/recover', { headers: basic(), body: {} });
  assert.equal(rec.data.conversations_replayed, 1);
  assert.equal((await sql(`SELECT order_id FROM conversations WHERE conversation_id = 'conv_durable'`))[0].order_id, o.order_id);
  const [w2] = await sql(`SELECT processed_at, payload FROM webhook_events WHERE provider = 'elevenlabs'`);
  assert.ok(w2.processed_at); assert.equal(w2.payload, null, 'raw transcript dropped once stored in conversations');
});
test('F5b. storing the delivery fails → 500 so ElevenLabs retries; the retry is processed once', async () => {
  const raw = elPayload('k'.repeat(30));
  failNext(/INSERT INTO webhook_events/);
  assert.equal((await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } })).status, 500);
  assert.equal((await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } })).status, 200);
  assert.equal((await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } })).data.duplicate, true);
  assert.equal(await cnt(`SELECT count(*)::int c FROM conversations`), 1);
  assert.equal(await cnt(`SELECT count(*)::int c FROM events WHERE event_name = 'agent_first_user_message'`), 1);
});

/* ── 6. the production email is retried until Make confirms ── */
test('F6. Make down at finish → brief saved, email queued, delivered later; "Accepted" without a route is not a delivery', async () => {
  const o = await newOrder(); await pay(o); await fillBrief(o); await addContact(o);
  mock.makeFail = true;
  const f = await doFinish(o);
  assert.equal(f.status, 200); assert.equal(f.data.saved, true); assert.equal(f.data.notified, false);
  const q1 = (await sql(`SELECT status, attempts FROM notify_outbox WHERE id = $1`, ['finish:' + o.order_id]))[0];
  assert.deepEqual([q1.status, q1.attempts], ['pending', 1]);
  mock.makeFail = 'accepted'; await dueNow(); await runCron();
  assert.equal((await sql(`SELECT status FROM notify_outbox WHERE id = $1`, ['finish:' + o.order_id]))[0].status, 'pending', 'a bare "Accepted" is not confirmation');
  mock.makeFail = false; await dueNow(); await runCron();
  assert.equal((await sql(`SELECT status FROM notify_outbox WHERE id = $1`, ['finish:' + o.order_id]))[0].status, 'sent');
  const finishCalls = mock.calls.filter(c => /hook\.make\.test/.test(c.url) && c.body.includes('a=finish'));
  assert.equal(finishCalls.length, 3, 'one try per run, then stops');
  const d = await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() });
  assert.ok(d.data.order.brief_done_at);
});

/* ── 7. npm run migrate ── */
test('F7. scripts/migrate.js applies all migrations, is idempotent, and fails clearly without DATABASE_URL', async () => {
  const db = new PGlite();
  setDb(async (t, p) => (await db.query(t, p)).rows);
  const { run } = await import('../scripts/migrate.js');
  const first = await run();
  assert.deepEqual(first.all, ['001_init', '002_agent_link', '003_durable_queues']);
  assert.deepEqual(first.applied, ['001_init', '002_agent_link', '003_durable_queues']);
  setDb(async (t, p) => (await db.query(t, p)).rows);                     // a new process
  const second = await run();
  assert.deepEqual(second.applied, [], 'nothing re-applied');
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'meta_outbox'`)).rows.map(r => r.column_name);
  for (const c of ['order_id', 'status', 'next_attempt_at']) assert.ok(cols.includes(c), c);
  const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.migrate, 'node scripts/migrate.js');
  const env = { ...process.env }; delete env.DATABASE_URL;
  const p = spawnSync(process.execPath, ['scripts/migrate.js'], { cwd: new URL('..', import.meta.url).pathname, env, encoding: 'utf8' });
  assert.equal(p.status, 2); assert.match(p.stderr, /DATABASE_URL is not set/);
});
