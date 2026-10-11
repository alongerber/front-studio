// Public, non-secret configuration for the browser.
import { cfg } from '../lib/config.js';
import { json, handle } from '../lib/util.js';
import { CLIENT_TOOLS, PAGE_PROTOCOL } from '../lib/agent-tools.js';

export const GET = handle(async () => {
  const agentId = cfg.elevenlabs.agentId || null;
  if (!agentId) console.error('[config] CONFIGURATION ERROR: ELEVENLABS_AGENT_ID is not set in ' + cfg.environment + '; the conversation is disabled (no fallback to the test agent)');
  return json({
  environment: cfg.environment,
  site_version: cfg.siteVersion,
  paypal_client_id: cfg.paypal.clientId || null,      // client id is public by design; the secret never leaves the server
  paypal_env: cfg.paypal.env,
  test_mode: cfg.environment !== 'production',        // preview/test: no real money (no Bit, PayPal sandbox only)
  delivery_time: cfg.deliveryTime || null,
  checkout_open: cfg.checkoutOpen,                    // false in production until a delivery time is approved
  currency: cfg.product.currency,
  amount: cfg.product.amount,
  consent_mode: cfg.consentMode,
  agent_id: agentId,                                  // null = no conversation in this environment
  agent_error: agentId ? null : 'agent_not_configured',
  agent_client_tools: CLIENT_TOOLS,                   // the page checks it has all of these before a conversation starts
  page_protocol: PAGE_PROTOCOL,
  site_build: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
}, 200, { 'cache-control': 'public, max-age=60' });
});
