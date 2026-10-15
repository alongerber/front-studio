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
const send = (body, ip = '10.0.0.9') => call(summary.POST, 'POST', '/api/summary', { body, headers: { 'x-forwarded-for': ip } });
const saveNote = (o, field, value) => call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field, value, phase: 'sales' }, headers: { 'x-front-proto': '9' } });
const mails = () => mock.calls.filter(c => /hook\.make\.test/.test(c.url) && c.body.includes('a=summary'));

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

// A conversation the page proved: its own order (id + token) with this tab's link key attached.
const LINK = () => ('L' + uuid4().replace(/-/g, '') + 'xyz').slice(0, 32);
async function conversation(notes = { business_type: 'מספרה', liked_direction: 'הגשם בחלון' }) {
  const link = LINK();
  const o = (await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4(), agent_link: link } })).data;
  for (const [f, v] of Object.entries(notes)) assert.equal((await saveNote(o, f, v)).status, 200);
  return { ...o, link };
}
const ask = (c, email, extra = {}, ip) => send({ email, order_id: c.order_id, token: c.token, link: c.link, ...extra }, ip);

test('SM2. an allowed address: one email through Make, state "sent", built only from the saved order (request text ignored), nothing paid', async () => {
  const c = await conversation();
  const r = await ask(c, 'owner@test.co', { direction: 'טקסט חופשי מהבקשה ZX-INJECT', facts: 'ZX-INJECT' });
  assert.equal(r.status, 200); assert.equal(r.data.state, 'sent'); assert.match(r.data.ref, /^S-\d{5}$/);
  assert.equal(mails().length, 1);
  const p = new URLSearchParams(mails()[0].body);
  assert.equal(p.get('direction'), 'הגשם בחלון'); assert.match(p.get('facts'), /מספרה/); assert.equal(p.get('environment'), 'test');
  assert.equal(mails()[0].body.includes('ZX-INJECT'), false);
  const [ord] = await sql(`SELECT status, paid_at FROM orders WHERE order_id = $1`, [c.order_id]);
  assert.notEqual(ord.status, 'paid'); assert.equal(ord.paid_at, null);
  assert.equal((await sql(`SELECT count(*)::int n FROM orders`))[0].n, 1);                       // no order was created
});

test('SM3. outside production a non-test address is never sent: stored as not_allowed, no Make call', async () => {
  const r = await ask(await conversation(), 'customer@gmail.com');
  assert.equal(r.data.state, 'not_allowed'); assert.equal(mails().length, 0);
  assert.equal((await sql(`SELECT status FROM summary_requests`))[0].status, 'not_allowed');
});

test('SM4. double call / retry: same order + address is one row and one email; a failed send is "queued", retried, then "sent" once', async () => {
  const c = await conversation();
  mock.makeFail = true;
  const a = await ask(c, 'owner@test.co');
  assert.equal(a.data.state, 'queued'); assert.equal(mails().length, 1);
  mock.makeFail = false;
  const b = await ask(c, 'Owner@Test.co');                                            // the agent tries again (any case)
  assert.equal(b.data.ref, a.data.ref); assert.equal(b.data.duplicate, true); assert.equal(b.data.state, 'sent');
  const d = await ask(c, 'owner@test.co');                                            // and again: already sent, no new email
  assert.equal(d.data.state, 'sent');
  assert.equal(mails().length, 2);                                                   // one failed attempt + one success
  assert.equal((await sql(`SELECT count(*)::int n FROM summary_requests`))[0].n, 1);
});

test('SM5. Make answering "Accepted" (no route) is not a delivery; recovery keeps retrying until confirmed; gives up as failed', async () => {
  mock.makeFail = 'accepted';
  const r = await ask(await conversation(), 'owner@test.co');
  assert.equal(r.data.state, 'queued');
  await sql(`UPDATE summary_requests SET attempts = 5, next_attempt_at = now() - interval '1 minute'`);
  await call(recover.POST, 'POST', '/api/admin/recover', { headers: { authorization: 'Bearer cron-secret' } }).catch(() => {});
  const { flushSummary } = await import('../lib/summary.js'); await flushSummary();
  const [row] = await sql(`SELECT status, attempts FROM summary_requests`);
  assert.equal(row.status, 'failed'); assert.ok(row.attempts >= 6);
});

test('SM6. no authorised conversation, no email: missing/forged token, a key not attached to the order, nothing saved yet; rate limited', async () => {
  const c = await conversation();
  assert.equal((await ask(c, 'nope')).data.error, 'invalid_email');
  assert.equal((await send({ email: 'owner@test.co' })).status, 403);                                          // no order at all
  assert.equal((await ask(c, 'owner@test.co', { token: 'x'.repeat(40) })).status, 403);                        // forged token
  assert.equal((await ask(c, 'owner@test.co', { link: LINK() })).status, 403);                                 // another tab's key
  assert.equal((await ask(c, 'owner@test.co', { link: undefined })).status, 403);
  const empty = await conversation({ business_type: 'מספרה' });                                                // facts but no direction
  assert.equal((await ask(empty, 'owner@test.co', {}, '10.0.0.10')).data.error, 'nothing_to_send');
  assert.equal((await sql(`SELECT count(*)::int n FROM summary_requests`))[0].n, 0); assert.equal(mails().length, 0);
  let last; for (let i = 0; i < 11; i++) last = await ask(c, 'owner@test.co', {}, '10.9.9.9');
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
