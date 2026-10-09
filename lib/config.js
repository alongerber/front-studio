// Server-side configuration. Secrets come only from environment variables.
const env = (k, d = '') => (process.env[k] ?? d);

export const cfg = {
  // production | preview | development | test  (VERCEL_ENV is set by Vercel; FRONT_ENV overrides, e.g. in tests)
  get environment() { return env('FRONT_ENV') || env('VERCEL_ENV') || 'development'; },
  get siteUrl() { return env('SITE_URL', 'https://front-studio.vercel.app').replace(/\/$/, ''); },
  get siteVersion() { return env('SITE_VERSION') || ('v5.0.0' + (env('VERCEL_GIT_COMMIT_SHA') ? '+' + env('VERCEL_GIT_COMMIT_SHA').slice(0, 7) : '')); },

  // The one product. Price and currency are decided here, never by the browser.
  product: { id: 'ad_1290', name: 'פרסומת לעסק', amount: '1290.00', currency: 'ILS' },

  paypal: {
    // sandbox | live. Live money only in production: a preview or test deployment is sandbox whatever PAYPAL_ENV says.
    get env() { return cfg.environment === 'production' && env('PAYPAL_ENV') === 'live' ? 'live' : 'sandbox'; },
    get base() { return cfg.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; },
    get clientId() { return env('PAYPAL_CLIENT_ID'); },
    get secret() { return env('PAYPAL_CLIENT_SECRET'); },
    get webhookId() { return env('PAYPAL_WEBHOOK_ID'); },
    get merchantId() { return env('PAYPAL_MERCHANT_ID'); },             // payee check; if empty the check is reported as skipped
  },
  meta: {
    get pixelId() { return env('META_PIXEL_ID'); },
    get token() { return env('META_CAPI_TOKEN'); },
    get version() { return env('META_GRAPH_VERSION', 'v25.0'); },
    get testCode() { return env('META_TEST_EVENT_CODE'); },              // set only in preview/test
  },
  elevenlabs: {
    get webhookSecret() { return env('ELEVENLABS_WEBHOOK_SECRET'); },
    get agentId() { return env('ELEVENLABS_AGENT_ID', 'agent_5801m4a74w3dfawt9hdjhbe1nrjc'); },
  },
  make: {
    get notifyUrl() { return env('MAKE_NOTIFY_URL'); },                 // emails only
  },
  admin: {
    get user() { return env('ADMIN_USER'); },
    get passwordHash() { return env('ADMIN_PASSWORD_HASH'); },          // scrypt$<salt hex>$<hash hex>
  },
  get cronSecret() { return env('CRON_SECRET'); },
  get consentMode() { return env('CONSENT_MODE', 'opt_in'); },          // opt_in until a policy is decided
};
