// Self-fill brief: the same note API and finish rules as Meital; a repeated send never duplicates production or email.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, uuid4 } from './helpers.js';
import * as order from '../api/order.js';
import * as ppCreate from '../api/paypal/create.js';
import * as ppCapture from '../api/paypal/capture.js';
import * as note from '../api/brief/note.js';
import * as contact from '../api/brief/contact.js';
import * as finish from '../api/brief/finish.js';

beforeEach(freshDb);
async function newOrder() { return (await call(order.POST, 'POST', '/api/order', { body: { consent: { analytics: 'granted', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4() } })).data; }
async function pay(o) {
  const pp = await call(ppCreate.POST, 'POST', '/api/paypal/create', { body: { order_id: o.order_id, token: o.token } });
  mock.approve(pp.data.id);
  await call(ppCapture.POST, 'POST', '/api/paypal/capture', { body: { order_id: o.order_id, token: o.token, paypal_order_id: pp.data.id } });
}
const put = (o, field, value) => call(note.POST, 'POST', '/api/brief/note', { body: { order_id: o.order_id, token: o.token, field, value, phase: 'brief' } });
const fin = (o) => call(finish.POST, 'POST', '/api/brief/finish', { body: { order_id: o.order_id, token: o.token } });
const withContact = (o) => call(contact.POST, 'POST', '/api/brief/contact', { body: { order_id: o.order_id, token: o.token, name: 'בדיקה', phone: '0501234567', email: 'a@b.co' } });

test('BS1. paid order with contact and an empty brief (the SNQA case): finish says exactly which fields are missing', async () => {
  const o = await newOrder(); await pay(o); await withContact(o);
  const r = await fin(o);
  assert.equal(r.status, 409); assert.equal(r.data.error, 'brief_incomplete'); assert.deepEqual(r.data.missing, ['business_type', 'promote']);
  await put(o, 'business_name', 'מספרת דני');
  assert.deepEqual((await fin(o)).data.missing, ['promote'], 'business name alone satisfies the business requirement');
});

test('BS2. an empty value never deletes a saved field; an edit replaces it', async () => {
  const o = await newOrder(); await put(o, 'promote', 'תספורת גברים');
  assert.equal((await put(o, 'promote', '   ')).data.saved, null);
  assert.equal((await sql(`SELECT brief->>'promote' p FROM orders WHERE order_id = $1`, [o.order_id]))[0].p, 'תספורת גברים');
  await put(o, 'promote', 'צבע לשיער');
  assert.equal((await sql(`SELECT brief->>'promote' p FROM orders WHERE order_id = $1`, [o.order_id]))[0].p, 'צבע לשיער');
});

test('BS3. unpaid: fields are saved, completion stays blocked, payment untouched', async () => {
  const o = await newOrder(); await withContact(o);
  await put(o, 'business_type', 'מספרה'); await put(o, 'promote', 'תספורת');
  const r = await fin(o);
  assert.equal(r.status, 409); assert.equal(r.data.error, 'payment_required');
  const [row] = await sql(`SELECT status, brief_done_at FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.equal(row.brief_done_at, null); assert.notEqual(row.status, 'paid');
});

test('BS4. repeated and parallel sends: one completion, one production email, payment unchanged', async () => {
  const o = await newOrder(); await pay(o); await withContact(o);
  await put(o, 'business_type', 'מספרה'); await put(o, 'promote', 'תספורת');
  const payBefore = await sql(`SELECT capture_id, status, amount FROM payments WHERE order_id = $1 ORDER BY capture_id`, [o.order_id]);
  const [ordBefore] = await sql(`SELECT status, paid_at FROM orders WHERE order_id = $1`, [o.order_id]);
  const makeBefore = mock.count(/hook\.make\.test/);
  const rs = await Promise.all([fin(o), fin(o), fin(o)]);
  rs.push(await fin(o));
  for (const r of rs) { assert.equal(r.status, 200); assert.equal(r.data.saved, true); }
  assert.equal(rs.filter(r => !r.data.already).length, 1, 'exactly one request completed it');
  assert.equal((await sql(`SELECT count(*)::int n FROM notify_outbox WHERE order_id = $1 AND action = 'finish'`, [o.order_id]))[0].n, 1);
  assert.equal((await sql(`SELECT count(*)::int n FROM events WHERE order_id = $1 AND event_name = 'brief_completed'`, [o.order_id]))[0].n, 1);
  const finishMails = mock.calls.slice(0).filter(c => /hook\.make\.test/.test(c.url) && /(^|&)a=finish(&|$)/.test(c.body)).length;
  assert.equal(finishMails, 1, 'one production email'); assert.ok(mock.count(/hook\.make\.test/) - makeBefore >= 1);
  assert.deepEqual(await sql(`SELECT capture_id, status, amount FROM payments WHERE order_id = $1 ORDER BY capture_id`, [o.order_id]), payBefore);
  const [ordAfter] = await sql(`SELECT status, paid_at FROM orders WHERE order_id = $1`, [o.order_id]);
  assert.deepEqual(ordAfter, ordBefore);
});
