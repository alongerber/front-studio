// Acceptance criteria from the approved spec, each as an executable test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, basic, ppHeaders, elSign, uuid4 } from './helpers.js';

import * as order from '../api/order.js';
import * as ppCreate from '../api/paypal/create.js';
import * as ppCapture from '../api/paypal/capture.js';
import * as ppWebhook from '../api/paypal/webhook.js';
import * as note from '../api/brief/note.js';
import * as contact from '../api/brief/contact.js';
import * as finish from '../api/brief/finish.js';
import * as agentLink from '../api/agent-link.js';
import * as elWebhook from '../api/elevenlabs/webhook.js';
import * as track from '../api/track.js';
import * as adminSummary from '../api/admin/summary.js';
import * as adminOrder from '../api/admin/order.js';
import * as verifyManual from '../api/admin/verify-manual.js';
import * as cron from '../api/cron/meta-flush.js';

beforeEach(freshDb);

const GRANTED = { analytics: 'granted', ads: 'granted' };
async function newOrder(extra = {}) {
  const r = await call(order.POST, 'POST', '/api/order', { body: { consent: GRANTED, anonymous_id: uuid4(), session_id: uuid4(), fbc: 'fb.1.1700000000000.' + 'x'.repeat(190), fbp: 'fb.1.1.2', last_touch: { utm_source: 'facebook', fbclid: 'x'.repeat(190) }, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;   // {order_id, token}
}
async function checkout(o) {
  const r = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}
const ppEvent = (id, type, resource) => JSON.stringify({ id, event_type: type, resource });
const webhook = (raw, sig = 'good') => call(ppWebhook.POST, 'POST', '/api/paypal/webhook', { raw, headers: ppHeaders(sig) });
const purchases = async (orderId) => (await sql(`SELECT count(*)::int c FROM events WHERE event_name = 'purchase_verified' AND order_id = $1`, [orderId]))[0].c;

/* 1 ─ /thanks never creates a purchase */
test('1. visiting thanks / returning without a verified capture creates no purchase', async () => {
  const o = await newOrder();
  const ppId = await checkout(o);
  // The browser claims a return from PayPal, but PayPal says the order was never approved.
  const r = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: ppId } });
  assert.equal(r.data.paid, false);
  // A forged paypal order id is refused.
  const forged = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: 'PP999' } });
  assert.equal(forged.status, 409);
  const st = await call(order.GET, 'GET', '/api/order?order_id=' + o.order_id, { headers: { 'x-order-token': o.token } });
  assert.equal(st.data.order.paid, false);
  assert.equal(await purchases(o.order_id), 0);
  assert.equal(mock.count(/graph\.facebook\.com/), 0, 'no Purchase sent to Meta');
});

/* 2 ─ payment lands even if the buyer never comes back */
test('2. approved payment is captured by the webhook alone (buyer closed the tab)', async () => {
  const o = await newOrder();
  const ppId = await checkout(o);
  mock.approve(ppId);
  const pp = mock.pp.get(ppId);
  const r = await webhook(ppEvent('WH-EVT-1', 'CHECKOUT.ORDER.APPROVED', { id: ppId, status: 'APPROVED', purchase_units: pp.purchase_units }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [row] = await sql(`SELECT status, paid_via, paid_at FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.equal(row.status, 'paid'); assert.equal(row.paid_via, 'paypal'); assert.ok(row.paid_at);
  assert.equal(await purchases(o.order_id), 1);
  assert.equal(mock.count(/graph\.facebook\.com/), 1, 'one CAPI Purchase');
  const sent = JSON.parse(mock.calls.find(c => /graph\.facebook/.test(c.url)).body);
  assert.equal(sent.data[0].event_id, o.order_id);
  assert.equal(sent.data[0].user_data.fbc.length > 180, true, 'fbc not truncated');
  assert.equal(mock.count(/hook\.make\.test/), 1, 'paid email requested once');
});

/* 3 ─ duplicates never double the purchase */
test('3. duplicate webhooks + capture endpoint → exactly one purchase', async () => {
  const o = await newOrder();
  const ppId = await checkout(o);
  mock.approve(ppId);
  const c1 = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: ppId } });
  assert.equal(c1.data.paid, true);
  const cap = mock.pp.get(ppId).purchase_units[0].payments.captures[0];
  const raw = ppEvent('WH-EVT-2', 'PAYMENT.CAPTURE.COMPLETED', cap);
  for (let i = 0; i < 3; i++) assert.equal((await webhook(raw)).status, 200);
  await webhook(ppEvent('WH-EVT-3', 'PAYMENT.CAPTURE.COMPLETED', cap));          // same capture, new event id
  await webhook(ppEvent('WH-EVT-4', 'CHECKOUT.ORDER.APPROVED', { id: ppId, purchase_units: mock.pp.get(ppId).purchase_units }));  // late APPROVED
  const c2 = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: ppId } });
  assert.equal(c2.data.paid, true);
  assert.equal(await purchases(o.order_id), 1);
  assert.equal((await sql(`SELECT count(*)::int c FROM payments WHERE order_id = $1`, [o.order_id]))[0].c, 1);
  assert.equal(mock.count(/graph\.facebook\.com/), 1);
  assert.equal((await sql(`SELECT count(*)::int c FROM webhook_events WHERE provider = 'paypal'`))[0].c, 3);
});

test('3b. forged PayPal webhook is rejected and changes nothing', async () => {
  const o = await newOrder();
  const ppId = await checkout(o);
  const r = await webhook(ppEvent('WH-FAKE', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-X', status: 'COMPLETED', custom_id: o.order_id, amount: { value: '1290.00', currency_code: 'ILS' }, supplementary_data: { related_ids: { order_id: ppId } } }), 'bad');
  assert.equal(r.status, 400);
  assert.equal(await purchases(o.order_id), 0);
});

test('3c. wrong amount or wrong payee is not a purchase', async () => {
  const a = await newOrder(); const ppA = await checkout(a); mock.amount = '1.00'; mock.approve(ppA);
  const ra = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: a.order_id, token: a.token, paypal_order_id: ppA } });
  assert.equal(ra.data.paid, false); assert.equal(ra.data.reason, 'amount_mismatch');
  mock.amount = '1290.00'; mock.payee = 'SOMEONE_ELSE';
  const b = await newOrder(); const ppB = await checkout(b); mock.approve(ppB);
  const rb = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: b.order_id, token: b.token, paypal_order_id: ppB } });
  assert.equal(rb.data.paid, false); assert.equal(rb.data.reason, 'payee_mismatch');
  assert.equal(await purchases(a.order_id) + await purchases(b.order_id), 0);
});

test('3d. pending capture is not a purchase until COMPLETED arrives', async () => {
  const o = await newOrder(); const ppId = await checkout(o); mock.captureStatus = 'PENDING'; mock.approve(ppId);
  const r = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: ppId } });
  assert.equal(r.data.paid, false); assert.equal(r.data.pending, true);
  const cap = { ...mock.pp.get(ppId).purchase_units[0].payments.captures[0], status: 'COMPLETED' };
  mock.pp.get(ppId).purchase_units[0].payments.captures[0].status = 'COMPLETED';
  await webhook(ppEvent('WH-P2', 'PAYMENT.CAPTURE.COMPLETED', cap));
  assert.equal(await purchases(o.order_id), 1);
});

/* 4 ─ conversation and brief belong to the right order */
test('4. conversation + brief link only to the order that owns the link key', async () => {
  const keyA = 'linkA_' + 'a'.repeat(30), keyB = 'linkB_' + 'b'.repeat(30);
  const A = await newOrder({ agent_link: keyA });
  const B = await newOrder({ agent_link: keyB });
  await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: A.order_id, token: A.token, field: 'business_type', value: 'מספרה' } });
  // The call claims order B in its variables, but carries A's link key → it belongs to A.
  const payload = { type: 'post_call_transcription', event_timestamp: 1, data: {
    agent_id: 'agent_test', conversation_id: 'conv_1', status: 'done', version_id: 'v9',
    transcript: [{ role: 'agent', message: 'היי', time_in_call_secs: 0 }, { role: 'user', message: 'יש לי מספרה', time_in_call_secs: 4 }],
    metadata: { start_time_unix_secs: 1791500000, call_duration_secs: 95, termination_reason: 'client disconnected' },
    analysis: { transcript_summary: 'לקוחה עם מספרה', data_collection_results: {
      business_type: { value: 'מספרה' }, promote_goal: { value: 'תורים לשבוע הבא' }, asked_price: { value: true }, last_stage: { value: 'payment' }, info_basis: { value: 'inferred' } } },
    conversation_initiation_client_data: { dynamic_variables: { front_link: keyA, order_id: B.order_id, payment_status: 'paid' } } } };
  const raw = JSON.stringify(payload);
  const bad = await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw, 'wrong') } });
  assert.equal(bad.status, 401);
  const r = await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } });
  assert.equal(r.status, 200); assert.equal(r.data.linked, true);
  const [conv] = await sql(`SELECT order_id, user_turns, summary FROM conversations WHERE conversation_id = 'conv_1'`);
  assert.equal(conv.order_id, A.order_id);
  assert.equal(conv.user_turns, 1);
  const ev = await sql(`SELECT event_name, order_id FROM events WHERE conversation_id = 'conv_1' ORDER BY event_name`);
  assert.deepEqual(ev.map(e => e.event_name), ['agent_connected', 'agent_first_user_message', 'lead_qualified']);
  assert.ok(ev.every(e => e.order_id === A.order_id));
  assert.equal((await sql(`SELECT props FROM events WHERE event_name = 'lead_qualified'`))[0].props.basis, 'inferred');
  // The agent's claim "payment_status: paid" changed nothing.
  assert.equal((await sql(`SELECT paid_at FROM orders WHERE order_id = $1`, [B.order_id]))[0].paid_at, null);
  // Same delivery again → no duplicate events.
  await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } });
  assert.equal((await sql(`SELECT count(*)::int c FROM events WHERE conversation_id = 'conv_1'`))[0].c, 3);
  // Brief of B is untouched.
  assert.deepEqual((await sql(`SELECT brief FROM orders WHERE order_id = $1`, [B.order_id]))[0].brief, {});
});

test('4b. webhook that arrives before the order is back-filled when the order attaches its key', async () => {
  const key = 'early_' + 'c'.repeat(30);
  const raw = JSON.stringify({ type: 'post_call_transcription', data: { agent_id: 'agent_test', conversation_id: 'conv_early', status: 'done',
    transcript: [{ role: 'agent', message: 'שלום' }], metadata: {}, analysis: {}, conversation_initiation_client_data: { dynamic_variables: { front_link: key } } } });
  const r = await call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } });
  assert.equal(r.data.linked, false);
  const o = await newOrder();
  const l = await call(agentLink.POST, 'POST', '/api/agent-link', { body: { order_id: o.order_id, token: o.token, agent_link: key } });
  assert.equal(l.status, 200);
  assert.equal((await sql(`SELECT order_id FROM conversations WHERE conversation_id = 'conv_early'`))[0].order_id, o.order_id);
});

/* 5 ─ nobody reads someone else's order */
test('5. a customer cannot read or change another order', async () => {
  const A = await newOrder(), B = await newOrder();
  const steal = await call(order.GET, 'GET', '/api/order?order_id=' + A.order_id, { headers: { 'x-order-token': B.token } });
  assert.equal(steal.status, 404);
  const noTok = await call(order.GET, 'GET', '/api/order?order_id=' + A.order_id);
  assert.equal(noTok.status, 404);
  for (const [h, path, body] of [
    [note.POST, '/api/brief/note', { field: 'business_type', value: 'x' }],
    [contact.POST, '/api/brief/contact', { name: 'x', phone: '0501234567' }],
    [finish.POST, '/api/brief/finish', {}],
    [ppCreate.POST, '/api/paypal/create', {}],
    [ppCapture.POST, '/api/paypal/capture', { paypal_order_id: 'PP1' }],
    [agentLink.POST, '/api/agent-link', { agent_link: 'k'.repeat(30) }],
  ]) {
    const r = await call(h, 'POST', path, { body: { order_id: A.order_id, token: B.token, ...body } });
    assert.equal(r.status, 404, path);
  }
  // Admin endpoints need a login.
  assert.equal((await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + A.order_id)).status, 401);
  assert.equal((await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + A.order_id, { headers: basic('alon', 'wrong') })).status, 401);
  assert.equal((await call(adminSummary.GET, 'GET', '/api/admin/summary')).status, 401);
  // A tracking event that names order A without its token is not attached to A.
  const aid = uuid4(), sid = uuid4();
  await call(track.POST, 'POST', '/api/track', { raw: JSON.stringify({ consent: GRANTED, anonymous_id: aid, session_id: sid, order_id: A.order_id, order_token: B.token,
    events: [{ id: uuid4(), name: 'checkout_clicked', at: new Date().toISOString(), path: '/' }] }) });
  assert.equal((await sql(`SELECT order_id FROM events WHERE session_id = $1`, [sid]))[0].order_id, null);
});

/* 6 ─ a completed brief is really saved and visible to production */
test('6. completed brief is stored and readable in admin, even if the email fails', async () => {
  const o = await newOrder(); const ppId = await checkout(o); mock.approve(ppId);
  await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: ppId } });
  for (const [field, value] of [['business_type', 'מספרה'], ['promote', 'תספורת גברים'], ['tone', 'חם']])
    assert.equal((await call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field, value } })).status, 200);
  const early = await call(finish.POST, 'POST', '/api/brief/finish', { body: { order_id: o.order_id, token: o.token } });
  assert.equal(early.status, 409, 'contact required first');
  await call(contact.POST, 'POST', '/api/brief/contact', { body: { order_id: o.order_id, token: o.token, name: 'דנה', phone: '050-1234567', email: 'dana@example.com' } });
  mock.makeFail = true;
  const f = await call(finish.POST, 'POST', '/api/brief/finish', { body: { order_id: o.order_id, token: o.token } });
  assert.equal(f.status, 200); assert.equal(f.data.saved, true); assert.equal(f.data.notified, false);
  const d = await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() });
  assert.equal(d.status, 200);
  assert.equal(d.data.order.brief.business_type, 'מספרה');
  assert.equal(d.data.order.contact.name, 'דנה');
  assert.ok(d.data.order.brief_done_at);
  assert.equal(d.data.order.token_hash, undefined, 'token hash never leaves the server');
  assert.equal((await sql(`SELECT count(*)::int c FROM admin_audit WHERE action = 'view_order'`))[0].c, 1);
  const again = await call(finish.POST, 'POST', '/api/brief/finish', { body: { order_id: o.order_id, token: o.token } });
  assert.equal(again.status, 200);
  assert.equal((await sql(`SELECT count(*)::int c FROM events WHERE event_name = 'brief_completed'`))[0].c, 1);
});

/* 7 ─ measurement failure never blocks the purchase */
test('7. Meta down → order still paid, outbox retries later; no ads consent → nothing sent', async () => {
  mock.metaFail = 'throw';
  const o = await newOrder(); const ppId = await checkout(o); mock.approve(ppId);
  const r = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: ppId } });
  assert.equal(r.status, 200); assert.equal(r.data.paid, true);
  const [ob] = await sql(`SELECT sent_at, attempts, last_error FROM meta_outbox WHERE event_id = $1`, [o.order_id]);
  assert.equal(ob.sent_at, null); assert.equal(ob.attempts, 1); assert.match(ob.last_error, /network down/);
  assert.equal((await call(cron.GET, 'GET', '/api/cron/meta-flush')).status, 401);
  mock.metaFail = false;
  await sql(`UPDATE meta_outbox SET next_attempt_at = now()`);                       // the backoff window has passed
  const c = await call(cron.GET, 'GET', '/api/cron/meta-flush', { headers: { authorization: 'Bearer cron-secret' } });
  assert.equal(c.data.sent, 1);
  assert.ok((await sql(`SELECT sent_at FROM meta_outbox WHERE event_id = $1`, [o.order_id]))[0].sent_at);
  // Second order without ads consent: paid, never queued for Meta.
  const r2 = await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'denied', ads: 'denied' } } });
  const pp2 = await checkout(r2.data); mock.approve(pp2);
  const before = mock.count(/graph\.facebook/);
  const p2 = await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: r2.data.order_id, token: r2.data.token, paypal_order_id: pp2 } });
  assert.equal(p2.data.paid, true);
  assert.equal(mock.count(/graph\.facebook/), before);
  const [row] = await sql(`SELECT anonymous_id, attribution, meta_user FROM orders WHERE order_id = $1`, [r2.data.order_id]);
  assert.deepEqual([row.anonymous_id, row.attribution, row.meta_user], [null, null, null]);
});

/* manual Bit */
test('8. manual Bit verification needs admin, a reference and an explicit confirmation; it is audited', async () => {
  const o = await newOrder();
  assert.equal((await call(verifyManual.POST, 'POST', '/api/admin/verify-manual', { body: { order_id: o.order_id, reference: 'BIT-123', confirm_seen_in_account: true } })).status, 401);
  assert.equal((await call(verifyManual.POST, 'POST', '/api/admin/verify-manual', { headers: basic(), body: { order_id: o.order_id, reference: 'BIT-123' } })).status, 400);
  assert.equal((await call(verifyManual.POST, 'POST', '/api/admin/verify-manual', { headers: basic(), body: { order_id: o.order_id, reference: '', confirm_seen_in_account: true } })).status, 400);
  const ok = await call(verifyManual.POST, 'POST', '/api/admin/verify-manual', { headers: basic(), body: { order_id: o.order_id, reference: 'BIT-123', note: 'ראיתי בחשבון', confirm_seen_in_account: true } });
  assert.equal(ok.status, 200);
  const [a] = await sql(`SELECT admin_user, details FROM admin_audit WHERE action = 'verify_manual_payment'`);
  assert.equal(a.admin_user, 'alon'); assert.equal(a.details.reference, 'BIT-123');
  assert.equal((await sql(`SELECT paid_via FROM orders WHERE order_id = $1`, [o.order_id]))[0].paid_via, 'bit_manual');
  assert.equal(await purchases(o.order_id), 1);
});

/* tracking + dashboard */
test('9. tracking: consent required, whitelist enforced, fbclid kept; dashboard returns absolute counts', async () => {
  const aid = uuid4(), sid = uuid4();
  const none = await call(track.POST, 'POST', '/api/track', { raw: JSON.stringify({ consent: { analytics: 'denied' }, anonymous_id: aid, session_id: sid, events: [{ id: uuid4(), name: 'landing_view' }] }) });
  assert.equal(none.data.stored, 0);
  const ev = (name, props, cta) => ({ id: uuid4(), name, at: new Date().toISOString(), path: '/?utm_source=x', props, cta });
  const r = await call(track.POST, 'POST', '/api/track', { raw: JSON.stringify({ consent: GRANTED, anonymous_id: aid, session_id: sid,
    first_touch: { utm_source: 'facebook', utm_campaign: 'c1', fbclid: 'F'.repeat(300) },
    events: [ev('landing_view', { utm_source: 'facebook', email: 'leak@x.com' }), ev('agent_opened'), ev('agent_start_requested'), ev('checkout_presented'),
      ev('checkout_clicked', { method: 'paypal' }, 'offer'), ev('time_summary', { active_ms: 42000, visible_ms: 60000, open_ms: 61000 }), ev('Purchase'), ev('agent_tool_result', { tool: 'open_payment', ok: false })] }) });
  assert.equal(r.data.stored, 7); assert.equal(r.data.rejected, 1, 'browser cannot send Purchase');
  const [lv] = await sql(`SELECT props, page_path FROM events WHERE event_name = 'landing_view'`);
  assert.equal(lv.props.email, undefined, 'unlisted props dropped'); assert.equal(lv.page_path, '/');
  assert.equal((await sql(`SELECT first_touch FROM sessions WHERE session_id = $1`, [sid]))[0].first_touch.fbclid.length, 300);
  const s = await call(adminSummary.GET, 'GET', '/api/admin/summary?days=7', { headers: basic() });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const f = Object.fromEntries(s.data.funnel.map(x => [x.key, x.count]));
  assert.equal(f.entries, 1); assert.equal(f.agent_open, 1); assert.equal(f.checkout_clicked, 1); assert.equal(f.purchase_verified, 0);
  assert.equal(s.data.health.agent_tool_failures, 1);
  assert.equal(s.data.time.median_active_ms, 42000);
});

test('10. rate limiting and input validation', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call(order.POST, 'POST', '/api/order', { body: { consent: {} } })).status, 201);
  assert.equal((await call(order.POST, 'POST', '/api/order', { body: { consent: {} } })).status, 429);
  const o = (await sql(`SELECT order_id FROM orders LIMIT 1`))[0];
  assert.equal((await call(note.POST, 'POST', '/api/brief/note', { raw: 'x'.repeat(10000) })).status, 413);
  assert.equal((await call(note.POST, 'POST', '/api/brief/note', { raw: '{bad' })).status, 400);
  assert.equal((await call(order.GET, 'GET', "/api/order?order_id=FR-' OR 1=1", { headers: { 'x-order-token': 'x'.repeat(40) } })).status, 404);
  assert.ok(o);
});

test('11. refunds mark the order refunded and are reported', async () => {
  const o = await newOrder(); const ppId = await checkout(o); mock.approve(ppId);
  await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: ppId } });
  await webhook(ppEvent('WH-R1', 'PAYMENT.CAPTURE.REFUNDED', { id: 'REF-1', status: 'COMPLETED', custom_id: o.order_id, amount: { value: '1290.00', currency_code: 'ILS' } }));
  assert.equal((await sql(`SELECT status FROM orders WHERE order_id = $1`, [o.order_id]))[0].status, 'refunded');
  assert.equal((await sql(`SELECT count(*)::int c FROM events WHERE event_name = 'payment_refunded'`))[0].c, 1);
});
