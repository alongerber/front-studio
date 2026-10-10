// Orders, events and rate limiting on top of Postgres.
import { q, one } from './db.js';
import { cfg } from './config.js';
import { newOrderId, newToken, sha256, safeEqual, isOrderId, httpError, clip } from './util.js';

/* ── server-side events (deterministic ids → idempotent) ── */
export async function serverEvent(name, { eventId, orderId = null, sessionId = null, anonymousId = null, conversationId = null, channel = 'server', props = {}, at = null, agentVersion = null } = {}) {
  const id = eventId || `${name}:${orderId || conversationId || sessionId}`;
  const rows = await q(
    `INSERT INTO events (event_id, event_name, occurred_at, anonymous_id, session_id, conversation_id, lead_id, order_id, channel, site_version, agent_version, environment, props)
     VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [id, name, at, anonymousId, sessionId, conversationId, orderId, channel, cfg.siteVersion, agentVersion, cfg.environment, JSON.stringify(props)]);
  return rows.length > 0;
}

/* ── rate limiting: fixed one-minute windows in Postgres ── */
export async function rateLimit(bucket, limit) {
  const rows = await q(
    `INSERT INTO rate_limits (bucket, win_start, hits) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (bucket, win_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`, [bucket]);
  if (rows[0].hits > limit) throw httpError(429, 'rate_limited');
}

/* ── orders ── */
export async function createOrder({ anonymousId, sessionId, consent, attribution, metaUser }) {
  const token = newToken();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newOrderId();
    const rows = await q(
      `INSERT INTO orders (order_id, token_hash, environment, amount, currency, product, anonymous_id, session_id, attribution, consent, meta_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb) ON CONFLICT (order_id) DO NOTHING RETURNING order_id`,
      [id, sha256(token), cfg.environment, cfg.product.amount, cfg.product.currency, cfg.product.id,
       anonymousId || null, sessionId || null, JSON.stringify(attribution || null), JSON.stringify(consent || {}), JSON.stringify(metaUser || null)]);
    if (rows.length) {
      await serverEvent('order_created', { orderId: id, sessionId, anonymousId });
      return { orderId: id, token };
    }
  }
  throw new Error('could not allocate order id');
}

// Load an order only for its owner. Wrong token and missing order look the same (404).
export async function ownedOrder(orderId, token) {
  if (!isOrderId(orderId) || typeof token !== 'string' || token.length < 20) throw httpError(404, 'not_found');
  const o = await one(`SELECT * FROM orders WHERE order_id = $1 AND environment = $2`, [orderId, cfg.environment]);
  if (!o || !safeEqual(o.token_hash, sha256(token))) throw httpError(404, 'not_found');
  return o;
}

export const BRIEF_FIELDS = ['business_type', 'business_name', 'promote', 'audience', 'customer_questions', 'past_experience',
  'concern', 'avoid', 'call_to_action', 'tone', 'contact_details', 'other'];

export async function saveNote(order, field, value) {
  if (!BRIEF_FIELDS.includes(field)) field = 'other';
  const v = clip(String(value || '').trim(), 240);
  if (!v) return order;
  const o = await one(
    `UPDATE orders SET brief = brief || jsonb_build_object($2::text, $3::text), updated_at = now(),
       brief_started_at = CASE WHEN paid_at IS NOT NULL AND brief_started_at IS NULL THEN now() ELSE brief_started_at END
     WHERE order_id = $1 RETURNING *`, [order.order_id, field, v]);
  if (isPaid(o) && o.brief_started_at) await serverEvent('brief_started', { orderId: o.order_id, sessionId: o.session_id });
  return o;
}

// An order counts as paid only while its payment stands: a full refund ends it (paid_at stays as history).
export const isPaid = (o) => !!o && !!o.paid_at && (o.status === 'paid' || o.status === 'partially_refunded');

// Minimum content before a brief can be handed to production.
export const BRIEF_REQUIRED = [['business_type', 'business_name'], ['promote']];
export function briefMissing(brief) {
  brief = brief || {};
  return BRIEF_REQUIRED.filter(any => !any.some(k => String(brief[k] || '').trim().length >= 2)).map(any => any[0]);
}

export function publicOrder(o) {
  const brief = o.brief || {};
  return {
    order_id: o.order_id,
    status: o.status,
    paid: isPaid(o),
    refunded: o.status === 'refunded',
    paid_via: o.paid_via || null,
    brief,
    brief_missing: briefMissing(brief),
    has_contact: !!(o.contact && o.contact.name && o.contact.phone),
    contact: o.contact ? { name: o.contact.name || '', phone: o.contact.phone || '', email: o.contact.email || '' } : null,
    brief_done: !!o.brief_done_at,
    consent: o.consent || null,
    amount: o.amount, currency: o.currency,
  };
}

/* ── agent ↔ order linkage (see migration 002) ── */

export const isLinkKey = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(s);

// Attach a page's agent link key to an order the caller owns, and back-fill any conversation
// that already arrived with that key (webhook before order).
export async function attachAgentLink(orderId, key) {
  if (!isLinkKey(key)) return false;
  await q(`UPDATE orders SET agent_links = CASE WHEN $2 = ANY(agent_links) THEN agent_links ELSE array_append(agent_links, $2) END
           WHERE order_id = $1 AND cardinality(agent_links) < 20`, [orderId, key]);
  await q(`UPDATE conversations SET order_id = $1 WHERE link_key = $2 AND order_id IS NULL AND environment = $3`, [orderId, key, cfg.environment]);
  return true;
}

// The order a conversation belongs to: the newest order its link key was attached to (a tab that started a new
// checkout after an older order carries the key on both).
export async function orderForLink(key) {
  if (!isLinkKey(key)) return null;
  return one(`SELECT * FROM orders WHERE $1 = ANY(agent_links) AND environment = $2 ORDER BY created_at DESC LIMIT 1`, [key, cfg.environment]);
}

// What may be said about payment. Only the server's payment records decide; nothing the customer or the agent says.
export function paymentState(o) {
  if (!o) return 'no_order';
  if (isPaid(o)) return 'verified';
  if (o.status === 'refunded') return 'refunded';
  if (o.status === 'pending') return 'pending';
  return 'not_paid';
}
