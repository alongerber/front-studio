import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, mock } from './helpers.js';
import * as config from '../api/config.js';
import * as create from '../api/paypal/create.js';
import { checkoutStatus } from '../lib/readiness.js';
import { cfg } from '../lib/config.js';

async function withEnv(vars, run) {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : process.env[k] = v;
  try { return await run(); }
  finally { for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : process.env[k] = v; }
}
const READY = { VERCEL_ENV: 'production', CHECKOUT_ENABLED: 'true', DATABASE_URL: 'configured',
  PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'configured', PAYPAL_CLIENT_SECRET: 'secret-not-public',
  PAYPAL_WEBHOOK_ID: 'configured', PAYPAL_MERCHANT_ID: 'configured', MAKE_NOTIFY_URL: 'https://hook.example.test/x',
  MAKE_NOTIFY_KEY: 'secret-not-public', ADMIN_EMAIL: 'owner@example.test', SITE_URL: 'https://front.example.test',
  CRON_SECRET: 'secret-not-public', NOTIFY_TEST_RECIPIENTS: undefined };

test('LG1. deployed previews cannot be turned into real-money production by FRONT_ENV', () => withEnv({
  VERCEL_ENV: 'preview', FRONT_ENV: 'production', PAYPAL_ENV: 'live', CHECKOUT_ENABLED: 'true'
}, async () => {
  const { data } = await call(config.GET, 'GET', '/api/config');
  assert.equal(cfg.environment, 'preview'); assert.equal(data.paypal_env, 'sandbox'); assert.equal(data.test_mode, true);
}));

test('LG2. production requires release activation and every payment/delivery dependency; a direct API call cannot bypass it', async () => {
  for (const key of ['CHECKOUT_ENABLED', 'DATABASE_URL', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID',
    'PAYPAL_MERCHANT_ID', 'MAKE_NOTIFY_KEY', 'MAKE_NOTIFY_URL', 'ADMIN_EMAIL', 'CRON_SECRET']) {
    await withEnv({ ...READY, [key]: undefined }, async () => {
      assert.equal(checkoutStatus().open, false, key);
      const before = mock.count(/paypal/);
      const r = await call(create.POST, 'POST', '/api/paypal/create', { body: {} });
      assert.equal(r.status, 409, key); assert.equal(r.data.error, 'checkout_unavailable', key);
      assert.equal(mock.count(/paypal/), before, key + ': provider was never called');
      const publicConfig = (await call(config.GET, 'GET', '/api/config')).data;
      assert.equal(publicConfig.checkout_open, false);
      assert.equal(JSON.stringify(publicConfig).includes('secret-not-public'), false);
    });
  }
});

test('LG3. configured and explicitly activated production checkout is available without optional measurement', () => withEnv({
  ...READY, META_PIXEL_ID: undefined, META_CAPI_TOKEN: undefined
}, () => assert.equal(checkoutStatus().open, true)));

test('LG4. production Sandbox or test-recipient restrictions keep checkout closed', async () => {
  for (const bad of [{ PAYPAL_ENV: 'sandbox' }, { NOTIFY_TEST_RECIPIENTS: 'owner@example.test' }])
    await withEnv({ ...READY, ...bad }, () => assert.equal(checkoutStatus().open, false));
});

test('LG5. Bit has no exposed phone or route unless explicitly enabled with a valid target, and is never enabled in Preview', async () => {
  for (const state of [
    { VERCEL_ENV: 'production', BIT_ENABLED: undefined, BIT_WHATSAPP: '972501234567' },
    { VERCEL_ENV: 'production', BIT_ENABLED: 'true', BIT_WHATSAPP: 'javascript:bad' },
    { VERCEL_ENV: 'preview', BIT_ENABLED: 'true', BIT_WHATSAPP: '972501234567' }
  ]) await withEnv(state, async () => {
    const { data } = await call(config.GET, 'GET', '/api/config');
    assert.equal(data.bit_enabled, false); assert.equal(data.bit_phone, null);
  });
});
