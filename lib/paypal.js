// PayPal REST: OAuth, Orders v2 (create/capture/get), webhook signature postback.
import { cfg } from './config.js';

let tokenCache = { value: null, exp: 0 };

async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  if (!cfg.paypal.clientId || !cfg.paypal.secret) throw new Error('PayPal credentials are not configured');
  const r = await fetch(cfg.paypal.base + '/v1/oauth2/token', {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(cfg.paypal.clientId + ':' + cfg.paypal.secret).toString('base64'),
               'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('PayPal auth failed: ' + r.status);
  const j = await r.json();
  tokenCache = { value: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 300) - 60) * 1000 };
  return tokenCache.value;
}
export function resetPaypalToken() { tokenCache = { value: null, exp: 0 }; }

async function call(method, path, body, requestId) {
  const headers = { authorization: 'Bearer ' + await accessToken(), 'content-type': 'application/json', prefer: 'return=representation' };
  if (requestId) headers['paypal-request-id'] = requestId;
  const r = await fetch(cfg.paypal.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

export async function createPaypalOrder(orderId) {
  const p = cfg.product;
  const res = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: orderId, custom_id: orderId, invoice_id: orderId,
      description: p.name,
      amount: { currency_code: p.currency, value: p.amount },
    }],
    application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', brand_name: 'FRONT' },
  }, 'create-' + orderId);
  if (!res.ok) throw Object.assign(new Error('PayPal create failed: ' + res.status), { status: 502 });
  return res.data;
}

export async function capturePaypalOrder(paypalOrderId) {
  return call('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {}, 'capture-' + paypalOrderId);
}

export async function getPaypalOrder(paypalOrderId) {
  const res = await call('GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
  if (!res.ok) throw new Error('PayPal get order failed: ' + res.status);
  return res.data;
}

// One capture as PayPal holds it now (read only).
export async function getPaypalCapture(captureId) {
  const res = await call('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`);
  return { ok: res.ok, status: res.status, data: res.data };
}

// Ask PayPal whether this delivery is authentic. Needs the exact raw body.
export async function verifyWebhook(headers, rawBody) {
  if (!cfg.paypal.webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not configured');
  const h = (k) => headers.get(k);
  const certUrl = h('paypal-cert-url') || '';
  try { if (!/(^|\.)paypal\.com$/.test(new URL(certUrl).hostname)) return false; } catch { return false; }
  const res = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'), cert_url: certUrl,
    transmission_id: h('paypal-transmission-id'), transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'), webhook_id: cfg.paypal.webhookId,
    webhook_event: JSON.parse(rawBody),
  });
  return res.ok && res.data && res.data.verification_status === 'SUCCESS';
}

// Pull the captures out of an order representation.
export function capturesOf(order) {
  const out = [];
  for (const pu of (order && order.purchase_units) || []) {
    for (const c of (pu.payments && pu.payments.captures) || []) out.push({ ...c, custom_id: c.custom_id || pu.custom_id, payee: pu.payee });
  }
  return out;
}
