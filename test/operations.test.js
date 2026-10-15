// Owner operations: continuation links, production stages, delivery targets and delays, password sign-in.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, basic, adminCookie } from './helpers.js';
import { sha256 } from '../lib/util.js';
import * as order from '../api/order.js';
import * as manage from '../api/admin/manage.js';
import * as adminOrder from '../api/admin/order.js';
import * as summary from '../api/admin/summary.js';
import * as login from '../api/admin/login.js';
import { dueBaseFor, delayBusinessDays, israelDate, addBusinessDays } from '../lib/production.js';

process.env.ADMIN_EMAIL = 'owner@front.test';
beforeEach(freshDb);

async function newOrder() {
  const r = await call(order.POST, 'POST', '/api/order', { body: { anonymous_id: crypto.randomUUID(), session_id: crypto.randomUUID(), consent: {} } });
  return { order_id: r.data.order_id, token: r.data.token };
}
async function paidOrder(extra = '') {
  const o = await newOrder();
  await sql(`UPDATE orders SET paid_at = now(), status = 'paid', paid_via = 'paypal' ${extra} WHERE order_id = $1`, [o.order_id]);
  return o;
}
const act = (body, headers = basic()) => call(manage.POST, 'POST', '/api/admin/manage', { body, headers });
const readOrder = (id, token) => call(order.GET, 'GET', '/api/order?order_id=' + id, { headers: { 'x-order-token': token } });
const rid = () => crypto.randomUUID();
const tokenOf = (link) => decodeURIComponent(/[#&]t=([^&]+)/.exec(link)[1]);

/* ── continuation link ── */
test('OP1. without a signed-in admin nothing is issued or changed', async () => {
  const o = await paidOrder();
  for (const body of [{ action: 'issue_link', order_id: o.order_id, request_id: rid() }, { action: 'set_stage', order_id: o.order_id, from: 'awaiting_brief', to: 'script_writing' },
    { action: 'add_delay', order_id: o.order_id, started_on: israelDate(Date.now()), reason: 'x' }]) {
    const r = await act(body, {});
    assert.equal(r.status, 401, body.action);
  }
  const bad = await act({ action: 'issue_link', order_id: o.order_id, request_id: rid() }, basic('alon', 'wrong'));
  assert.equal(bad.status, 401);
  assert.equal((await sql(`SELECT count(*)::int c FROM order_access`))[0].c, 0);
  assert.equal((await sql(`SELECT production_stage FROM orders WHERE order_id = $1`, [o.order_id]))[0].production_stage, null);
});

test('OP2. an issued link opens only its order, changes nothing, sends nothing, and is audited without the token', async () => {
  const o = await paidOrder(), other = await paidOrder();
  const before = (await sql(`SELECT status, paid_at, brief, production_stage FROM orders WHERE order_id = $1`, [o.order_id]))[0];
  const calls0 = mock.calls.length;
  const r = await act({ action: 'issue_link', order_id: o.order_id, request_id: rid() });
  assert.equal(r.status, 200);
  assert.match(r.data.link, new RegExp('^https://front\\.test/thanks#o=' + o.order_id + '&t='));
  assert.equal(r.data.days, 30);
  const t = tokenOf(r.data.link);
  assert.equal((await readOrder(o.order_id, t)).status, 200, 'opens its order');
  assert.equal((await readOrder(other.order_id, t)).status, 404, 'never another order');
  assert.equal((await readOrder(o.order_id, o.token)).status, 200, 'the customer\'s own link still works');
  const after = (await sql(`SELECT status, paid_at, brief, production_stage FROM orders WHERE order_id = $1`, [o.order_id]))[0];
  assert.deepEqual(after, before);
  assert.equal(mock.calls.length, calls0, 'no email or any outside call');
  assert.equal((await sql(`SELECT count(*)::int c FROM notify_outbox WHERE order_id = $1`, [o.order_id]))[0].c, 0);
  const audit = await sql(`SELECT admin_user, details::text AS d FROM admin_audit WHERE action = 'continuation_link_issued' AND order_id = $1`, [o.order_id]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].admin_user, 'alon');
  assert.equal(audit[0].d.includes(t), false, 'token never in the audit');
  assert.equal((await sql(`SELECT count(*)::int c FROM order_access WHERE token_hash = $1`, [sha256(t)]))[0].c, 1, 'only the hash is stored');
});

test('OP3. the same click twice issues one link; a second click issues a second link and the first keeps working', async () => {
  const o = await paidOrder(), id = rid();
  const a = await act({ action: 'issue_link', order_id: o.order_id, request_id: id });
  const b = await act({ action: 'issue_link', order_id: o.order_id, request_id: id });
  assert.equal(a.status, 200); assert.equal(b.status, 409); assert.equal(b.data.error, 'already_issued');
  const c = await act({ action: 'issue_link', order_id: o.order_id, request_id: rid() });
  assert.equal((await sql(`SELECT count(*)::int c FROM order_access`))[0].c, 2);
  assert.equal((await readOrder(o.order_id, tokenOf(a.data.link))).status, 200);
  assert.equal((await readOrder(o.order_id, tokenOf(c.data.link))).status, 200);
});

test('OP4. revoking ends issued links only; an expired link is refused', async () => {
  const o = await paidOrder();
  const a = await act({ action: 'issue_link', order_id: o.order_id, request_id: rid() });
  const rv = await act({ action: 'revoke_links', order_id: o.order_id });
  assert.equal(rv.data.revoked, 1);
  assert.equal((await readOrder(o.order_id, tokenOf(a.data.link))).status, 404);
  assert.equal((await readOrder(o.order_id, o.token)).status, 200);
  const b = await act({ action: 'issue_link', order_id: o.order_id, request_id: rid() });
  await sql(`UPDATE order_access SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL`);
  assert.equal((await readOrder(o.order_id, tokenOf(b.data.link))).status, 404);
});

/* ── production stages ── */
test('OP5. stages: only paid, not refunded; logged; a repeated click is refused, not duplicated; first delivery kept', async () => {
  const unpaid = await newOrder();
  assert.equal((await act({ action: 'set_stage', order_id: unpaid.order_id, from: null, to: 'in_production' })).data.error, 'not_paid');
  const refunded = await paidOrder();
  await sql(`UPDATE orders SET status = 'refunded' WHERE order_id = $1`, [refunded.order_id]);
  assert.equal((await act({ action: 'set_stage', order_id: refunded.order_id, from: 'awaiting_brief', to: 'in_production' })).data.error, 'refunded');

  const o = await paidOrder();
  const d0 = (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data.work;
  assert.deepEqual([d0.stage, d0.stage_inferred], ['awaiting_brief', true]);
  const s1 = await act({ action: 'set_stage', order_id: o.order_id, from: 'awaiting_brief', to: 'script_writing' });
  const s1again = await act({ action: 'set_stage', order_id: o.order_id, from: 'awaiting_brief', to: 'script_writing' });
  assert.equal(s1.status, 200); assert.equal(s1again.status, 409); assert.equal(s1again.data.error, 'stage_changed');
  for (const [from, to] of [['script_writing', 'awaiting_script_approval'], ['awaiting_script_approval', 'in_production'], ['in_production', 'delivered']])
    assert.equal((await act({ action: 'set_stage', order_id: o.order_id, from, to })).status, 200);
  const first = (await sql(`SELECT first_delivered_at FROM orders WHERE order_id = $1`, [o.order_id]))[0].first_delivered_at;
  await new Promise(r => setTimeout(r, 20));
  await act({ action: 'set_stage', order_id: o.order_id, from: 'delivered', to: 'revisions' });
  await act({ action: 'set_stage', order_id: o.order_id, from: 'revisions', to: 'delivered' });
  const row = (await sql(`SELECT first_delivered_at, last_delivered_at, status, paid_at IS NOT NULL AS paid FROM orders WHERE order_id = $1`, [o.order_id]))[0];
  assert.equal(String(row.first_delivered_at), String(first), 'first delivery is never overwritten');
  assert.ok(new Date(row.last_delivered_at) > new Date(first));
  assert.deepEqual([row.status, row.paid], ['paid', true], 'payment untouched');
  const log = await sql(`SELECT from_stage, to_stage, changed_by FROM order_stage_log WHERE order_id = $1 ORDER BY id`, [o.order_id]);
  assert.deepEqual(log.map(l => l.from_stage + '>' + l.to_stage), ['awaiting_brief>script_writing', 'script_writing>awaiting_script_approval',
    'awaiting_script_approval>in_production', 'in_production>delivered', 'delivered>revisions', 'revisions>delivered']);
  assert.ok(log.every(l => l.changed_by === 'alon'));
  assert.equal((await sql(`SELECT count(*)::int c FROM notify_outbox WHERE order_id = $1`, [o.order_id]))[0].c, 0, 'no customer message');
});

/* ── delivery target ── */
test('OP6. target = 7 business days (Sun–Thu, Israel time) after the paid day', () => {
  assert.equal(dueBaseFor('2026-10-14T09:00:00Z'), '2026-10-25');            // Wednesday in Israel
  assert.equal(dueBaseFor('2026-10-14T22:30:00Z'), '2026-10-26');            // 01:30 Thursday in Israel: counts from Thursday
  assert.equal(delayBusinessDays([{ started_on: '2026-10-18', ended_on: '2026-10-21' }, { started_on: '2026-10-20', ended_on: '2026-10-23' }], '2026-10-30'), 5,
    'overlapping delays count once: Sun 18 – Thu 22 is 5 business days, not 3 + 3');
  assert.equal(delayBusinessDays([{ started_on: '2026-10-18', ended_on: '2026-10-21', cancelled_at: '2026-10-19' }], '2026-10-30'), 0);
});

test('OP7. delays and target corrections: stored, need a reason, no double counting, survive a re-read', async () => {
  // Fixed dates (independent of the weekday the suite runs on): paid Sunday 4/10/2026, target = 7 business days later.
  const o = await paidOrder();
  await sql(`UPDATE orders SET paid_at = '2026-10-04T08:00:00Z', due_base = NULL WHERE order_id = $1`, [o.order_id]);
  const today = israelDate(Date.now());
  assert.equal((await act({ action: 'add_delay', order_id: o.order_id, started_on: '2026-10-05' })).data.error, 'reason_required');
  assert.equal((await act({ action: 'add_delay', order_id: o.order_id, started_on: '2020-01-01', reason: 'חומרים' })).data.error, 'before_payment');
  const future = addBusinessDays(today, 3);
  assert.equal((await act({ action: 'add_delay', order_id: o.order_id, started_on: future, reason: 'חומרים' })).data.error, 'start_in_future');
  assert.equal((await act({ action: 'add_delay', order_id: o.order_id, started_on: '2026-10-05', ended_on: future, reason: 'חומרים' })).data.error, 'end_in_future');
  const a = await act({ action: 'add_delay', order_id: o.order_id, started_on: '2026-10-05', reason: 'מחכים ללוגו מהלקוח' });     // Monday
  const dup = await act({ action: 'add_delay', order_id: o.order_id, started_on: '2026-10-05', reason: 'מחכים ללוגו מהלקוח' });
  assert.equal(a.data.duplicate, false); assert.equal(dup.data.duplicate, true);
  assert.equal((await sql(`SELECT count(*)::int c FROM order_delays WHERE order_id = $1`, [o.order_id]))[0].c, 1);
  const w1 = (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data;
  assert.equal(w1.work.delay_open, true);
  const delayId = w1.delays[0].id;
  assert.equal((await act({ action: 'end_delay', order_id: o.order_id, delay_id: delayId, ended_on: future })).data.error, 'end_in_future');
  assert.equal((await act({ action: 'end_delay', order_id: o.order_id, delay_id: delayId, ended_on: '2026-10-07' })).status, 200);   // Wednesday
  assert.equal((await act({ action: 'end_delay', order_id: o.order_id, delay_id: delayId, ended_on: '2026-10-07' })).status, 409, 'cannot end twice');
  const w2 = (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data.work;
  // Mon 5 – Tue 6 (the end day is when the material arrived): 2 business days; base 4/10 + 7 = Tue 13/10, current = Thu 15/10.
  assert.deepEqual([w2.delay_days, w2.due_base, w2.due_current], [2, '2026-10-13', '2026-10-15'], JSON.stringify(w2));
  assert.equal((await act({ action: 'set_due', order_id: o.order_id, date: '2026-12-01', reason: '' })).data.error, 'reason_required');
  assert.equal((await act({ action: 'set_due', order_id: o.order_id, date: '2026-12-01', reason: 'סוכם עם הלקוח' })).status, 200);
  const w3 = (await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=' + o.order_id, { headers: basic() })).data.work;
  assert.deepEqual([w3.due_current, w3.due_overridden, w3.due_override_reason], ['2026-12-01', true, 'סוכם עם הלקוח']);
  const au = await sql(`SELECT action FROM admin_audit WHERE order_id = $1 AND (action LIKE 'delay%' OR action LIKE 'due%') ORDER BY id`, [o.order_id]);
  assert.deepEqual(au.map(x => x.action), ['delay_added', 'delay_ended', 'due_override_set']);
  const stored = (await sql(`SELECT due_base IS NOT NULL AS b FROM orders WHERE order_id = $1`, [o.order_id]))[0].b;
  assert.equal(stored, true, 'base target is stored, not only computed for display');
});

test('OP7b. delay day rule: weekends never count, the end day is excluded, an open delay runs through today', () => {
  assert.equal(delayBusinessDays([{ started_on: '2026-10-16', ended_on: '2026-10-18' }], '2026-10-20'), 0, 'Fri–Sat only');
  assert.equal(delayBusinessDays([{ started_on: '2026-10-15', ended_on: '2026-10-18' }], '2026-10-20'), 1, 'Thu, then the weekend');
  assert.equal(delayBusinessDays([{ started_on: '2026-10-18', ended_on: '2026-10-18' }], '2026-10-20'), 0, 'same day: nothing was late');
  assert.equal(delayBusinessDays([{ started_on: '2026-10-18' }], '2026-10-20'), 3, 'open since Sunday, today Tuesday: Sun, Mon, Tue');
  assert.equal(addBusinessDays('2026-10-15', 1), '2026-10-18', 'one business day after Thursday is Sunday');
});

/* ── work list ── */
test('OP8. an old active order stays on the work list however many newer orders exist', async () => {
  const old = await paidOrder();
  await sql(`UPDATE orders SET created_at = now() - interval '60 days', paid_at = now() - interval '60 days' WHERE order_id = $1`, [old.order_id]);
  const done = await paidOrder(", production_stage = 'completed'");
  for (let i = 0; i < 105; i++) await sql(`INSERT INTO orders (order_id, token_hash, environment, amount, currency, product) VALUES ($1,'x','test',1290,'ILS','ad_1290')`,
    ['FR-' + String(1000 + i) + '-ZZZZ']);
  const s = (await call(summary.GET, 'GET', '/api/admin/summary?days=7', { headers: basic() })).data;
  assert.equal(s.recent_orders.some(r => r.order_id === old.order_id), false, 'not among the newest 100');
  assert.equal(s.recent_more, true);
  assert.ok(s.work_orders.some(r => r.order_id === old.order_id && r.work.overdue === true), 'but on the work list, late');
  assert.equal(s.work_orders.some(r => r.order_id === done.order_id), false, 'completed orders leave the work list');
});

/* ── password sign-in ── */
async function linkSession(remember = false) {
  const tok = 'L'.repeat(40);
  await sql(`INSERT INTO admin_tokens (token_hash, kind, email, expires_at) VALUES ($1, 'login', 'owner@front.test', now() + interval '15 minutes')`, [sha256(tok)]);
  const r = await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'redeem', token: tok, remember } });
  return adminCookie(r);
}
const pwLogin = (email, password, remember = false) => call(login.POST, 'POST', '/api/admin/login', { body: { action: 'login', email, password, remember } });

test('OP9. a password is set only right after a mailed-link sign-in; then email + password signs in with "remember me"', async () => {
  const viaBasic = await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'password' }, headers: basic() });
  const r0 = await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'set_password', password: 'long enough pass' }, headers: adminCookie(viaBasic) });
  assert.equal(r0.status, 403); assert.equal(r0.data.error, 'link_session_required');
  const ck = await linkSession();
  const st = await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'status' }, headers: ck });
  assert.deepEqual([st.data.has_password, st.data.can_set_password], [false, true]);
  assert.equal((await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'set_password', password: 'short' }, headers: ck })).data.error, 'password_length');
  assert.equal((await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'set_password', password: 'correct horse 2026' }, headers: ck })).status, 200);
  const h = (await sql(`SELECT password_hash FROM admin_credentials`))[0].password_hash;
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/); assert.equal(h.includes('correct horse'), false);
  // the session opened with Basic before the change was signed out; the link session that set it stays
  assert.equal((await call(summary.GET, 'GET', '/api/admin/summary', { headers: adminCookie(viaBasic) })).status, 401);
  assert.equal((await call(summary.GET, 'GET', '/api/admin/summary', { headers: ck })).status, 200);
  assert.equal((await pwLogin('owner@front.test', 'wrong password!')).status, 401);
  assert.equal((await pwLogin('someone@else.test', 'correct horse 2026')).status, 401);
  const ok = await pwLogin('Owner@Front.test', 'correct horse 2026', true);
  assert.equal(ok.status, 200);
  const c = ok.headers.get('set-cookie');
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Strict/); assert.match(c, /Max-Age=2592000/);
  const session = adminCookie(ok);
  assert.equal((await call(summary.GET, 'GET', '/api/admin/summary', { headers: session })).status, 200);
  // a password session cannot change the password (needs a fresh link)
  assert.equal((await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'set_password', password: 'another long one' }, headers: session })).status, 403);
  // sign out ends the session; "sign out everywhere" ends all
  await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'logout' }, headers: session });
  assert.equal((await call(summary.GET, 'GET', '/api/admin/summary', { headers: session })).status, 401);
  const s2 = adminCookie(await pwLogin('owner@front.test', 'correct horse 2026'));
  await call(login.POST, 'POST', '/api/admin/login', { body: { action: 'logout_all' }, headers: s2 });
  assert.equal((await call(summary.GET, 'GET', '/api/admin/summary', { headers: ck })).status, 401);
});

test('OP10. repeated wrong passwords are slowed down (rate limit)', async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await pwLogin('owner@front.test', 'nope nope nope')).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[6], 429);
});
