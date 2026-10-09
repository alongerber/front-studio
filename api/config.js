// Public, non-secret configuration for the browser.
import { cfg } from '../lib/config.js';
import { json, handle } from '../lib/util.js';

export const GET = handle(async () => json({
  environment: cfg.environment,
  site_version: cfg.siteVersion,
  paypal_client_id: cfg.paypal.clientId || null,      // client id is public by design; the secret never leaves the server
  paypal_env: cfg.paypal.env,
  test_mode: cfg.environment !== 'production',        // preview/test: no real money (no Bit, PayPal sandbox only)
  currency: cfg.product.currency,
  amount: cfg.product.amount,
  consent_mode: cfg.consentMode,
  agent_id: cfg.elevenlabs.agentId,
}, 200, { 'cache-control': 'public, max-age=60' }));
