// Test harness: real handlers + real SQL on an in-memory Postgres (PGlite), all external HTTP mocked.
import { PGlite } from '@electric-sql/pglite';
import { createHmac, scryptSync } from 'node:crypto';
import { setDb } from '../lib/db.js';
import { resetPaypalToken } from '../lib/paypal.js';

const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
export const ADMIN = { user: 'alon', pass: 'correct horse battery staple' };
Object.assign(process.env, {
  FRONT_ENV: 'test', SITE_URL: 'https://front.test',
  PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'csecret', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_MERCHANT_ID: 'MERCH1',
  META_PIXEL_ID: '871649018702910', META_CAPI_TOKEN: 'test-token', META_GRAPH_VERSION: 'v25.0', META_TEST_EVENT_CODE: 'TEST123',
  ELEVENLABS_WEBHOOK_SECRET: 'el-secret', ELEVENLABS_AGENT_ID: 'agent_test',
  MAKE_NOTIFY_URL: 'https://hook.make.test/x',
  ADMIN_USER: ADMIN.user, ADMIN_PASSWORD_HASH: 'scrypt$' + salt.toString('hex') + '$' + scryptSync(ADMIN.pass, salt, 32).toString('hex'),
  CRON_SECRET: 'cron-secret',
});

export let pg;
// Failure injection: the next N statements matching `re` throw, as a crashed DB call would.
const injections = [];
export function failNext(re, times = 1) { injections.push({ re, times }); }
export async function freshDb() {
  pg = new PGlite();
  injections.length = 0;
  setDb(async (text, params) => {
    for (const inj of injections) if (inj.times > 0 && inj.re.test(text)) { inj.times--; throw new Error('injected failure: ' + inj.re); }
    return (await pg.query(text, params)).rows;
  });
  resetPaypalToken();
  mock.reset();
}
export const sql = async (text, params = []) => (await pg.query(text, params)).rows;

/* ── external services ── */
export const mock = {
  reset() {
    this.calls = []; this.pp = new Map(); this.n = 0;
    this.metaFail = false; this.makeFail = false; this.payee = 'MERCH1'; this.amount = '1290.00'; this.captureStatus = 'COMPLETED';
  },
  approve(id) { this.pp.get(id).status = 'APPROVED'; },
  count(re) { return this.calls.filter(c => re.test(c.url)).length; },
};
mock.reset();

const res = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input); const method = (init.method || 'GET').toUpperCase();
  const body = init.body && typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
  mock.calls.push({ url, method, body, headers: init.headers || {} });
  const u = new URL(url);
  if (u.hostname === 'api-m.sandbox.paypal.com') {
    if (u.pathname === '/v1/oauth2/token') return res(200, { access_token: 'tok', expires_in: 3600 });
    if (u.pathname === '/v1/notifications/verify-webhook-signature') {
      const sig = init.body && JSON.parse(init.body).transmission_sig;
      return res(200, { verification_status: sig === 'good' ? 'SUCCESS' : 'FAILURE' });
    }
    if (u.pathname === '/v2/checkout/orders' && method === 'POST') {
      const b = JSON.parse(body); const id = 'PP' + (++mock.n);
      const pu = b.purchase_units[0];
      mock.pp.set(id, { id, status: 'CREATED', purchase_units: [{ reference_id: pu.reference_id, custom_id: pu.custom_id, invoice_id: pu.invoice_id, amount: pu.amount, payee: { merchant_id: mock.payee } }] });
      return res(201, mock.pp.get(id));
    }
    const m = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(u.pathname);
    if (m) {
      const o = mock.pp.get(decodeURIComponent(m[1]));
      if (!o) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      if (!m[2]) return res(200, o);
      if (o.status === 'COMPLETED') return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      if (o.status !== 'APPROVED') return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
      o.status = 'COMPLETED';
      o.purchase_units[0].payee = { merchant_id: mock.payee };
      o.purchase_units[0].payments = { captures: [{ id: 'CAP-' + o.id, status: mock.captureStatus, amount: { currency_code: 'ILS', value: mock.amount },
        custom_id: o.purchase_units[0].custom_id, invoice_id: o.purchase_units[0].invoice_id,
        supplementary_data: { related_ids: { order_id: o.id } } }] };
      return res(201, o);
    }
  }
  if (u.hostname === 'graph.facebook.com') {
    if (mock.metaFail === 'throw') throw new Error('network down');
    return mock.metaFail ? res(500, { error: { message: 'boom' } }) : res(200, { events_received: 1, fbtrace_id: 'x' });
  }
  if (u.hostname === 'hook.make.test') {
    if (mock.makeFail === 'accepted') return new Response('Accepted', { status: 200 });   // Make with no route answering
    return mock.makeFail ? res(500, { error: 'x' }) : res(200, { ok: true });
  }
  throw new Error('unexpected fetch ' + url);
};

/* ── request helpers ── */
export function req(method, path, { body, headers = {}, raw } = {}) {
  const h = new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 (iPhone) FBAV/400', ...headers });
  const init = { method, headers: h };
  if (raw !== undefined) init.body = raw; else if (body !== undefined) { init.body = JSON.stringify(body); h.set('content-type', 'application/json'); }
  return new Request('https://front.test' + path, init);
}
export async function call(handler, method, path, opts) {
  const r = await handler(req(method, path, opts));
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
export const basic = (u = ADMIN.user, p = ADMIN.pass) => ({ authorization: 'Basic ' + Buffer.from(u + ':' + p).toString('base64') });
export const ppHeaders = (sig = 'good') => ({
  'paypal-transmission-id': 't1', 'paypal-transmission-time': new Date().toISOString(), 'paypal-transmission-sig': sig,
  'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-1', 'paypal-auth-algo': 'SHA256withRSA',
});
export function elSign(raw, secret = 'el-secret', t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v0=` + createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
}
export const uuid4 = () => crypto.randomUUID();
