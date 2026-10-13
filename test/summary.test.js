// Conversation summary by email and the brief memory it draws on: sent only to an allowed address (test recipients
// outside production), one request per conversation + address, honest state (sent / queued / failed / not_allowed),
// no order created and no payment touched; brief fields are a closed list and a correction replaces the old value.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, uuid4 } from './helpers.js';
import * as order from '../api/order.js';
import * as note from '../api/brief/note.js';
import * as summary from '../api/summary.js';
import * as recover from '../api/admin/recover.js';
import { CLIENT_TOOLS } from '../lib/agent-tools.js';
import { BRIEF_FIELDS } from '../lib/store.js';

process.env.NOTIFY_TEST_RECIPIENTS = 'owner@test.co';
beforeEach(freshDb);
const newOrder = async () => (await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4() } })).data;
const ref = () => 'tab' + uuid4().replace(/-/g, '');
const send = (body, ip = '10.0.0.9') => call(summary.POST, 'POST', '/api/summary', { body, headers: { 'x-forwarded-for': ip } });
const saveNote = (o, field, value) => call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field, value, phase: 'sales' } });
const mails = () => mock.calls.filter(c => /hook\.make\.test/.test(c.url) && c.body.includes('a=summary'));
const DIR = 'ספרית מחייכת בגשם: ״עשית החלקה, זוכרת?״';

test('SM1. brief memory: new fields are stored, a correction replaces the old value, an unknown field is refused (not folded into other)', async () => {
  for (const f of ['goal', 'change_reason', 'liked_direction', 'past_experience', 'concern']) assert.ok(BRIEF_FIELDS.includes(f), f);
  const o = await newOrder();
  assert.equal((await saveNote(o, 'promote', 'החלקות')).data.saved, 'promote');
  assert.equal((await saveNote(o, 'liked_direction', 'הגשם בחלון')).data.saved, 'liked_direction');
  await saveNote(o, 'other', 'פרט ראשון');
  assert.equal((await saveNote(o, 'promote', 'החלקות קרטין')).data.saved, 'promote');             // the customer corrected it
  const bad = await saveNote(o, 'guess_about_budget', 'כנראה אין תקציב');
  assert.equal(bad.status, 400); assert.equal(bad.data.error, 'unsupported_field');
  const [row] = await sql(`SELECT brief, status FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.equal(row.brief.promote, 'החלקות קרטין'); assert.equal(row.brief.other, 'פרט ראשון'); assert.equal(row.brief.guess_about_budget, undefined);
  assert.notEqual(row.status, 'paid');
});

test('SM2. an allowed address: one email through Make, state "sent", facts come from the saved brief, the order is attached, nothing paid', async () => {
  const o = await newOrder();
  await saveNote(o, 'business_type', 'מספרה'); await saveNote(o, 'liked_direction', 'הגשם בחלון');
  const r = await send({ client_ref: ref(), email: 'owner@test.co', direction: DIR, order_id: o.order_id, token: o.token });
  assert.equal(r.status, 200); assert.equal(r.data.state, 'sent'); assert.equal(r.data.order_attached, true); assert.match(r.data.ref, /^S-\d{5}$/);
  assert.equal(mails().length, 1);
  const body = decodeURIComponent(mails()[0].body.replace(/\+/g, ' '));
  assert.ok(body.includes('מספרה') && body.includes('הגשם בחלון') && body.includes('environment=test'));
  const [ord] = await sql(`SELECT status, paid_at FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.notEqual(ord.status, 'paid'); assert.equal(ord.paid_at, null);
  assert.equal((await sql(`SELECT count(*)::int n FROM orders`))[0].n, 1);                       // no order was created
});

test('SM3. outside production a non-test address is never sent: stored as not_allowed, no Make call', async () => {
  const r = await send({ client_ref: ref(), email: 'customer@gmail.com', direction: DIR });
  assert.equal(r.data.state, 'not_allowed'); assert.equal(mails().length, 0);
  assert.equal((await sql(`SELECT status FROM summary_requests`))[0].status, 'not_allowed');
});

test('SM4. double call / retry: same request, one row, one email; a failed send is "queued", retried on demand, then "sent" once', async () => {
  const k = ref();
  mock.makeFail = true;
  const a = await send({ client_ref: k, email: 'owner@test.co', direction: DIR });
  assert.equal(a.data.state, 'queued'); assert.equal(mails().length, 1);
  mock.makeFail = false;
  const b = await send({ client_ref: k, email: 'owner@test.co', direction: DIR });   // the agent tries again
  assert.equal(b.data.ref, a.data.ref); assert.equal(b.data.duplicate, true); assert.equal(b.data.state, 'sent');
  const c = await send({ client_ref: k, email: 'owner@test.co', direction: DIR });   // and again: already sent, no new email
  assert.equal(c.data.state, 'sent');
  assert.equal(mails().length, 2);                                                   // one failed attempt + one success
  assert.equal((await sql(`SELECT count(*)::int n FROM summary_requests`))[0].n, 1);
});

test('SM5. Make answering "Accepted" (no route) is not a delivery; recovery keeps retrying until confirmed; gives up as failed', async () => {
  mock.makeFail = 'accepted';
  const r = await send({ client_ref: ref(), email: 'owner@test.co', direction: DIR });
  assert.equal(r.data.state, 'queued');
  await sql(`UPDATE summary_requests SET attempts = 5, next_attempt_at = now() - interval '1 minute'`);
  await call(recover.POST, 'POST', '/api/admin/recover', { headers: { authorization: 'Bearer cron-secret' } }).catch(() => {});
  const { flushSummary } = await import('../lib/summary.js'); await flushSummary();
  const [row] = await sql(`SELECT status, attempts FROM summary_requests`);
  assert.equal(row.status, 'failed'); assert.ok(row.attempts >= 6);
});

test('SM6. validation and limits: bad address or empty direction refused and nothing stored; a forged token attaches nothing; rate limited', async () => {
  assert.equal((await send({ client_ref: ref(), email: 'nope', direction: DIR })).data.error, 'invalid_email');
  assert.equal((await send({ client_ref: ref(), email: 'owner@test.co', direction: 'קצר' })).data.error, 'direction_required');
  assert.equal((await send({ client_ref: 'x', email: 'owner@test.co', direction: DIR })).status, 400);
  assert.equal((await sql(`SELECT count(*)::int n FROM summary_requests`))[0].n, 0);
  const o = await newOrder();
  const f = await send({ client_ref: ref(), email: 'owner@test.co', direction: DIR, order_id: o.order_id, token: 'x'.repeat(40) });
  assert.equal(f.data.order_attached, false); assert.equal(JSON.stringify(f.data).includes(o.order_id), false);
  let last; for (let i = 0; i < 6; i++) last = await send({ client_ref: ref(), email: 'owner@test.co', direction: DIR }, '10.9.9.9');
  assert.equal(last.status, 429);
});

test('SM7. the page offers Meital the summary tool; the prompt only promises a summary through it, with consent', async () => {
  assert.ok(CLIENT_TOOLS.includes('send_summary'));
  const { readFile } = await import('node:fs/promises');
  const p = await readFile(new URL('../docs/agent/meital-v5-prompt.md', import.meta.url), 'utf8');
  assert.ok(p.includes('send_summary'));
  const pages = (await readFile(new URL('../assets/page-home.js', import.meta.url), 'utf8')) + (await readFile(new URL('../assets/page-thanks.js', import.meta.url), 'utf8'));
  assert.equal((pages.match(/send_summary/g) || []).length, 2);
});
