// Production readiness: names what is missing, never values; the test agent and test-only settings block production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readiness } from '../lib/readiness.js';

function withEnv(vars, fn) {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const FULL = { FRONT_ENV: 'production', DATABASE_URL: 'x', PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'x', PAYPAL_WEBHOOK_ID: 'x',
  PAYPAL_MERCHANT_ID: 'x', ELEVENLABS_AGENT_ID: 'agent_prod', ELEVENLABS_WEBHOOK_SECRET: 'x', MAKE_NOTIFY_URL: 'x', ADMIN_EMAIL: 'a@b.c',
  META_PIXEL_ID: 'x', META_CAPI_TOKEN: 'x', SITE_URL: 'https://front.example', CRON_SECRET: 'x', NOTIFY_TEST_RECIPIENTS: undefined, META_TEST_EVENT_CODE: undefined };

test('R1. a complete production configuration is ready', () => withEnv(FULL, () => assert.equal(readiness().ok, true)));
test('R2. the test agent, sandbox PayPal and test-only settings block production', () => withEnv({ ...FULL, ELEVENLABS_AGENT_ID: 'agent_5801m4a74w3dfawt9hdjhbe1nrjc', PAYPAL_ENV: 'sandbox',
  NOTIFY_TEST_RECIPIENTS: 'a@b.c', META_TEST_EVENT_CODE: 'TEST1' }, () => {
  const bad = readiness().checks.filter(c => !c.ok).map(c => c.key).sort();
  assert.deepEqual(bad, ['agent', 'meta_no_test_code', 'no_test_recipients', 'paypal_live']);
  assert.equal(JSON.stringify(readiness()).includes('a@b.c'), false, 'values are never reported');
}));
