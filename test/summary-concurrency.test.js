// Parallel summary reservations must share the same caps, including across different orders and addresses.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, call, uuid4 } from './helpers.js';
import * as orderApi from '../api/order.js';
import { saveSummary } from '../lib/summary.js';
import { transaction } from '../lib/db.js';

const addresses = Array.from({ length: 8 }, (_, i) => `summary${i}@test.co`);
beforeEach(async () => {
  delete process.env.SUMMARY_DAILY_CAP;
  process.env.NOTIFY_TEST_RECIPIENTS = addresses.join(',');
  await freshDb();
});
const newOrder = async () => (await call(orderApi.POST, 'POST', '/api/order', { body: {
  consent: { analytics: 'denied', ads: 'denied' }, anonymous_id: uuid4(), session_id: uuid4(),
} })).data;
const save = (order, email) => saveSummary({ order, email, content: { direction: 'כיוון מוסכם' } });
async function orders() {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(await newOrder());
  return rows;
}
async function counts() {
  return Object.fromEntries((await sql(`SELECT status, count(*)::int n FROM summary_requests GROUP BY status`)).map(r => [r.status, r.n]));
}

test('SC1. simultaneous requests to different addresses cannot exceed the per-order cap', async () => {
  const order = await newOrder();
  await Promise.all(addresses.map(email => save(order, email)));
  assert.deepEqual(await counts(), { pending: 2, limited: 6 });
});

test('SC2. simultaneous orders cannot exceed the daily cap for a case-insensitive address', async () => {
  await Promise.all((await orders()).map((order, i) => save(order, i % 2 ? addresses[0].toUpperCase() : addresses[0])));
  assert.deepEqual(await counts(), { pending: 2, limited: 6 });
});

test('SC3. simultaneous distinct orders and addresses cannot exceed the site-wide daily cap', async () => {
  process.env.SUMMARY_DAILY_CAP = '3';
  await Promise.all((await orders()).map((order, i) => save(order, addresses[i])));
  assert.deepEqual(await counts(), { pending: 3, limited: 5 });
});

test('SC4. duplicates reserve one slot; disallowed recipients reserve none; failed deliveries keep their slot', async () => {
  const order = await newOrder();
  const saved = await Promise.all(Array.from({ length: 8 }, () => save(order, addresses[0])));
  assert.equal(new Set(saved.map(r => r.id)).size, 1);
  assert.equal(saved.filter(r => !r.duplicate).length, 1);
  await save(order, 'not-allowed@test.co');
  await sql(`UPDATE summary_requests SET status = 'failed' WHERE status = 'pending'`);
  await Promise.all(addresses.slice(1).map(email => save(order, email)));
  assert.deepEqual(await counts(), { failed: 1, not_allowed: 1, pending: 1, limited: 6 });
});

test('SC5. expired daily reservations free daily slots but retain the lifetime per-order cap', async () => {
  process.env.SUMMARY_DAILY_CAP = '2';
  const first = await newOrder();
  await save(first, addresses[0]);
  await save(first, addresses[1]);
  await sql(`UPDATE summary_requests SET created_at = now() - interval '25 hours'`);
  await save(first, addresses[2]);
  const second = await newOrder();
  await Promise.all([save(second, addresses[0]), save(second, addresses[1])]);
  assert.deepEqual(await counts(), { pending: 4, limited: 1 });
});

test('SC6. a transaction failure rolls back the reservation and releases its lock for a retry', async () => {
  const order = await newOrder();
  await assert.rejects(transaction([
    { text: `SELECT pg_advisory_xact_lock(1179799124, hashtext('test'))` },
    { text: `INSERT INTO summary_requests (client_ref, environment, email, direction, order_id)
      VALUES ('rollback-test', 'test', $1, 'direction', $2)`, params: [addresses[0], order.order_id] },
    { text: `SELECT 1 / 0` },
  ]), /division by zero/);
  assert.deepEqual(await counts(), {});
  await save(order, addresses[0]);
  assert.deepEqual(await counts(), { pending: 1 });
});

test('SC7. a malformed configured daily cap cannot disable the global limit', async () => {
  process.env.SUMMARY_DAILY_CAP = 'not-a-number';
  await Promise.all((await orders()).map((order, i) => save(order, addresses[i])));
  assert.deepEqual(await counts(), { pending: 1, limited: 7 });
});
