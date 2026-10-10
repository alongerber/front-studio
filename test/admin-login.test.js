// Admin sign-in by a one-time link mailed to ADMIN_EMAIL. Access is enforced by the server on every admin API call.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock, call, basic } from './helpers.js';
import * as login from '../api/admin/login.js';
import * as summary from '../api/admin/summary.js';
import * as adminOrder from '../api/admin/order.js';

const OWNER = 'owner@front.test';
beforeEach(async () => { await freshDb(); process.env.ADMIN_EMAIL = OWNER; });
afterEach(() => { delete process.env.ADMIN_EMAIL; });

const post = (body, headers = {}) => call(login.POST, 'POST', '/api/admin/login', { body, headers });
const dash = (headers = {}) => call(summary.GET, 'GET', '/api/admin/summary?days=7', { headers });
const mails = () => mock.calls.filter(c => /hook\.make\.test/.test(c.url) && c.body.includes('a=admin_login'));
const tokenFromMail = (m) => /#login=([A-Za-z0-9_-]+)/.exec(new URLSearchParams(m.body).get('link'))[1];

test('A1. a link goes only to ADMIN_EMAIL; any other address gets the same answer and no mail', async () => {
  const other = await post({ action: 'request', email: 'someone@else.test' });
  assert.equal(other.status, 200); assert.equal(mails().length, 0);
  const mine = await post({ action: 'request', email: ' Owner@Front.test ' });
  assert.equal(mine.status, 200); assert.equal(mails().length, 1);
  const sent = new URLSearchParams(mails()[0].body);
  assert.equal(sent.get('email'), OWNER);
  assert.match(sent.get('link'), /^https:\/\/front\.test\/admin#login=[A-Za-z0-9_-]{40,}$/);
  assert.equal(JSON.stringify(mine.data).includes(tokenFromMail(mails()[0])), false, 'the link is never returned to the browser');
  const rows = await sql(`SELECT token_hash FROM admin_tokens`);
  assert.equal(rows.length, 1); assert.notEqual(rows[0].token_hash, tokenFromMail(mails()[0]), 'only a hash is stored');
});

test('A2. the link signs in once; the session opens the dashboard; nothing else does', async () => {
  assert.equal((await dash()).status, 401, 'no credentials → refused by the server');
  assert.equal((await dash({ authorization: 'Bearer ' + 'x'.repeat(43) })).status, 401, 'a made-up session → refused');
  await post({ action: 'request', email: OWNER });
  const t = tokenFromMail(mails()[0]);
  assert.equal((await dash({ authorization: 'Bearer ' + t })).status, 401, 'the link token itself is not a session');
  const r = await post({ action: 'redeem', token: t });
  assert.equal(r.status, 200); assert.ok(r.data.session);
  const auth = { authorization: 'Bearer ' + r.data.session };
  assert.equal((await dash(auth)).status, 200);
  assert.equal((await call(adminOrder.GET, 'GET', '/api/admin/order?order_id=FR-AAAA-BBBB', { headers: auth })).status, 404, 'authorized; order just does not exist');
  assert.equal((await post({ action: 'redeem', token: t })).status, 401, 'one use only');
  await post({ action: 'logout' }, auth);
  assert.equal((await dash(auth)).status, 401, 'signed out on the server');
});

test('A3. expired links and sessions are refused; changing ADMIN_EMAIL ends old sessions', async () => {
  await post({ action: 'request', email: OWNER });
  const t = tokenFromMail(mails()[0]);
  await sql(`UPDATE admin_tokens SET expires_at = now() - interval '1 second'`);
  assert.equal((await post({ action: 'redeem', token: t })).status, 401);
  await post({ action: 'request', email: OWNER });
  const r = await post({ action: 'redeem', token: tokenFromMail(mails()[1]) });
  const auth = { authorization: 'Bearer ' + r.data.session };
  assert.equal((await dash(auth)).status, 200);
  process.env.ADMIN_EMAIL = 'new@front.test';
  assert.equal((await dash(auth)).status, 401);
  process.env.ADMIN_EMAIL = OWNER;
  await sql(`UPDATE admin_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'session'`);
  assert.equal((await dash(auth)).status, 401);
});

test('A4. if the mail is not confirmed sent, the link is discarded and the page is told', async () => {
  mock.makeFail = 'accepted';
  const r = await post({ action: 'request', email: OWNER });
  assert.equal(r.status, 503); assert.equal(r.data.error, 'send_failed');
  assert.equal((await sql(`SELECT count(*)::int c FROM admin_tokens`))[0].c, 0);
});

test('A5. without ADMIN_EMAIL there is no link sign-in; the password sign-in still works', async () => {
  delete process.env.ADMIN_EMAIL;
  assert.equal((await post({ action: 'request', email: OWNER })).status, 503);
  assert.equal(mails().length, 0);
  assert.equal((await dash(basic())).status, 200);
});
