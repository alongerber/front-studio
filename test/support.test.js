// "Help with an order": saved on our server before anything else, one request per send, an order attached only with
// its token, a typed number grants nothing, rate limited, shown in the dashboard and closed there.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, uuid4, basic } from './helpers.js';
import * as order from '../api/order.js';
import * as support from '../api/support.js';
import * as summary from '../api/admin/summary.js';
import * as manage from '../api/admin/manage.js';
import * as recover from '../api/admin/recover.js';
import { CLIENT_TOOLS } from '../lib/agent-tools.js';

beforeEach(freshDb);
const newOrder = async () => (await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4() } })).data;
const send = (body, ip = '10.0.0.1') => call(support.POST, 'POST', '/api/support', { body, headers: { 'x-forwarded-for': ip } });
const makeCalls = () => mock.calls.filter(c => /hook\.make\.test/.test(c.url) && c.body.includes('a=support'));

test('SU1. a request is saved, gets a reference, and the owner email goes through Make once', async () => {
  const before = makeCalls().length;
  const r = await send({ client_ref: uuid4(), email: 'c@x.co', message: 'החלון של התשלום לא נפתח', source: 'home' });
  assert.equal(r.status, 200); assert.equal(r.data.saved, true); assert.match(r.data.ref, /^P-\d{5}$/);
  const [row] = await sql(`SELECT email, message, order_id, claimed_order_ref, notify_status, status FROM support_requests`);
  assert.equal(row.email, 'c@x.co'); assert.equal(row.order_id, null); assert.equal(row.status, 'open'); assert.equal(row.notify_status, 'sent');
  assert.equal(makeCalls().length - before, 1);
});

test('SU2. a repeated send (double click, lost answer) is the same request: one row, one email, same reference', async () => {
  const ref = uuid4(), before = makeCalls().length;
  const a = await send({ client_ref: ref, email: 'c@x.co', message: 'שאלה על ההזמנה' });
  const b = await send({ client_ref: ref, email: 'c@x.co', message: 'שאלה על ההזמנה' });
  assert.equal(a.data.ref, b.data.ref);
  assert.equal((await sql(`SELECT count(*)::int n FROM support_requests`))[0].n, 1);
  assert.equal(makeCalls().length - before, 1);
});

test('SU3. from a verified order page the order is attached; the answer carries no order details', async () => {
  const o = await newOrder();
  const r = await send({ client_ref: uuid4(), email: 'c@x.co', message: 'לא מצליח לשלוח את האפיון', order_id: o.order_id, token: o.token, source: 'thanks' });
  assert.equal(r.data.order_attached, true);
  assert.deepEqual(Object.keys(r.data).sort(), ['ok', 'order_attached', 'ref', 'saved']);
  assert.equal((await sql(`SELECT order_id FROM support_requests`))[0].order_id, o.order_id);
});

test('SU4. a typed or forged order number grants nothing: stored as a claim, nothing about the order is returned', async () => {
  const o = await newOrder();
  const typed = await send({ client_ref: uuid4(), email: 'c@x.co', message: 'שאלה על הזמנה', order_ref: o.order_id });
  const forged = await send({ client_ref: uuid4(), email: 'c@x.co', message: 'שאלה על הזמנה', order_id: o.order_id, token: 'x'.repeat(40) });
  for (const r of [typed, forged]) {
    assert.equal(r.status, 200); assert.equal(r.data.order_attached, false);
    assert.equal(JSON.stringify(r.data).includes(o.order_id), false);
  }
  const rows = await sql(`SELECT order_id, claimed_order_ref FROM support_requests ORDER BY id`);
  assert.deepEqual(rows.map(r => [r.order_id, r.claimed_order_ref]), [[null, o.order_id], [null, o.order_id]]);
});

test('SU5. validation: bad email or empty text is refused and nothing is saved', async () => {
  assert.equal((await send({ client_ref: uuid4(), email: 'nope', message: 'שאלה ארוכה' })).data.error, 'invalid_email');
  assert.equal((await send({ client_ref: uuid4(), email: 'c@x.co', message: '  ' })).data.error, 'message_required');
  assert.equal((await send({ email: 'c@x.co', message: 'שאלה ארוכה' })).status, 400);
  assert.equal((await sql(`SELECT count(*)::int n FROM support_requests`))[0].n, 0);
});

test('SU6. rate limit per sender', async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await send({ client_ref: uuid4(), email: 'c@x.co', message: 'הודעה מספר ' + i }, '10.9.9.9')).status);
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(codes[5], 429);
});

test('SU7. Make down: the request is still saved and reported as saved; the email is retried by recovery', async () => {
  mock.makeFail = true;
  const r = await send({ client_ref: uuid4(), email: 'c@x.co', message: 'שאלה כשהמייל לא עובד' });
  mock.makeFail = false;
  assert.equal(r.data.saved, true);
  assert.equal((await sql(`SELECT notify_status FROM support_requests`))[0].notify_status, 'pending');
  await sql(`UPDATE support_requests SET notify_next_at = now()`);
  await call(recover.POST, 'POST', '/api/admin/recover', { headers: basic(), body: {} });
  assert.equal((await sql(`SELECT notify_status FROM support_requests`))[0].notify_status, 'sent');
});

test('SU8. the dashboard lists requests (verified vs typed) and marks one handled, audited, once', async () => {
  const o = await newOrder();
  await send({ client_ref: uuid4(), email: 'a@x.co', message: 'מאומתת', order_id: o.order_id, token: o.token });
  await send({ client_ref: uuid4(), email: 'b@x.co', message: 'מוקלדת', order_ref: 'FR-AAAA-BBBB' });
  const s = await call(summary.GET, 'GET', '/api/admin/summary', { headers: basic() });
  assert.equal(s.data.support.length, 2);
  const typed = s.data.support.find(x => x.email === 'b@x.co');
  assert.equal(typed.order_id, null); assert.equal(typed.claimed_order_ref, 'FR-AAAA-BBBB');
  const id = Number(s.data.support.find(x => x.email === 'a@x.co').id);
  const c1 = await call(manage.POST, 'POST', '/api/admin/manage', { headers: basic(), body: { action: 'support_done', support_id: id } });
  const c2 = await call(manage.POST, 'POST', '/api/admin/manage', { headers: basic(), body: { action: 'support_done', support_id: id } });
  assert.equal(c1.data.closed, true); assert.equal(c2.data.closed, false);
  assert.equal((await sql(`SELECT count(*)::int n FROM admin_audit WHERE action = 'support_done'`))[0].n, 1);
  assert.equal((await call(summary.GET, 'GET', '/api/admin/summary')).status, 401, 'not without admin');
});

test('SU9. the page offers Meital the help-form tool', () => {
  assert.ok(CLIENT_TOOLS.includes('open_support'));
});

test('SU10. no personal contact in the marketing path or in Meital\'s instructions', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (f) => readFile(new URL('../' + f, import.meta.url), 'utf8');
  for (const f of ['index.html', 'thanks.html', 'assets/page-thanks.js', 'docs/agent/meital-v5-prompt.md']) {
    const t = await read(f);
    for (const bad of ['גרבר', '055-950-1280', '0559501280', 'wa.me', 'tel:', 'data-wa'])
      assert.equal(t.includes(bad), false, f + ' contains ' + bad);
  }
  const prompt = await read('docs/agent/meital-v5-prompt.md');
  assert.ok(prompt.includes('open_support') && !/וואטסאפ|show_whatsapp/.test(prompt), 'Meital routes people to the help form, never WhatsApp');
});
