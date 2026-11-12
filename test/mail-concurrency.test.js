import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, mock } from './helpers.js';
import { q } from '../lib/db.js';
import { flushNotify } from '../lib/notify.js';
import { flushSupport } from '../lib/support.js';
import { flushSummary, retryNow } from '../lib/summary.js';

beforeEach(freshDb);

// Hold the first delivery open while another worker (cron/webhook/request) runs.
// Real SQL and handlers run; the external mail provider stays mocked.
async function overlap(flush, during = async () => {}) {
  const original = globalThis.fetch;
  let started, release;
  const entered = new Promise(r => { started = r; });
  const held = new Promise(r => { release = r; });
  let deliveries = 0;
  globalThis.fetch = async (...args) => {
    if (String(args[0]).includes('hook.make.test')) {
      deliveries++;
      if (deliveries === 1) { started(); await held; }
    }
    return original(...args);
  };
  const first = flush();
  try {
    await entered;
    await during();
    await flush();
  } finally { release(); await first; globalThis.fetch = original; }
  assert.equal(deliveries, 1, 'only the worker owning the delivery lease may send');
}

test('MQ1. concurrent support delivery workers send one owner notification', async () => {
  await q(`INSERT INTO support_requests (client_ref, environment, email, message) VALUES ('support-race','test','owner@example.test','test')`);
  await overlap(() => flushSupport());
  assert.equal((await sql(`SELECT notify_status FROM support_requests`))[0].notify_status, 'sent');
});

test('MQ2. a repeated summary request cannot reset an active delivery lease', async () => {
  const [row] = await q(`INSERT INTO summary_requests (client_ref, environment, email, direction) VALUES ('summary-race','test','owner@example.test','test') RETURNING id`);
  await overlap(() => flushSummary(), () => retryNow(row.id));
  assert.equal((await sql(`SELECT status FROM summary_requests`))[0].status, 'sent');
});

test('MQ3. concurrent payment notification workers claim one queued message', async () => {
  await q(`INSERT INTO orders (order_id, token_hash, environment, amount, currency, product, status, paid_via) VALUES ('FR-MAIL-RACE','hash','test','1290.00','ILS','ad_1290','paid','paypal')`);
  await sql(`INSERT INTO notify_outbox (id, action, order_id) VALUES ('paid:FR-MAIL-RACE','paid','FR-MAIL-RACE')`);
  await overlap(() => flushNotify());
  assert.equal((await sql(`SELECT status FROM notify_outbox`))[0].status, 'sent');
});

test('MQ4. an expired delivery lease recovers after a worker stops', async () => {
  await q(`INSERT INTO support_requests (client_ref, environment, email, message, notify_next_at) VALUES ('support-crash','test','owner@example.test','test', now() + interval '5 minutes')`);
  await flushSupport();
  assert.equal(mock.count(/hook.make.test/), 0);
  await sql(`UPDATE support_requests SET notify_next_at = now() - interval '1 second'`);
  await flushSupport();
  assert.equal(mock.count(/hook.make.test/), 1);
});
