// Dashboard numbers. Every rate is computed in the UI from the absolute counts returned here.
import { q, one } from './db.js';
import { cfg } from './config.js';

const n = (v) => Number(v || 0);

export async function summary(days = 7) {
  const env = cfg.environment;
  const since = `now() - ($2::int * interval '1 day')`;
  const P = [env, days];

  const sess = async (name) => n((await one(
    `SELECT count(DISTINCT session_id) c FROM events WHERE environment = $1 AND event_name = $3 AND occurred_at > ${since}`, [...P, name])).c);

  const [entries, agentOpen, agentStart, checkoutPresented, checkoutClicked] = await Promise.all(
    ['landing_view', 'agent_opened', 'agent_start_requested', 'checkout_presented', 'checkout_clicked'].map(sess));

  const conv = await one(
    `SELECT count(*) total,
            count(*) FILTER (WHERE agent_turns > 0 AND status <> 'failed') connected,
            count(*) FILTER (WHERE user_turns > 0) with_user_message,
            count(*) FILTER (WHERE status = 'failed') failed,
            count(*) FILTER (WHERE order_id IS NOT NULL) linked_to_order,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_secs) median_duration_secs
     FROM conversations WHERE environment = $1 AND COALESCE(started_at, received_at) > ${since}`, P);

  const ord = await one(
    `SELECT count(*) created,
            count(*) FILTER (WHERE paypal_order_id IS NOT NULL) checkout_created,
            count(*) FILTER (WHERE paid_at IS NOT NULL) paid,
            count(*) FILTER (WHERE paid_at IS NOT NULL AND paid_via = 'paypal') paid_paypal,
            count(*) FILTER (WHERE paid_at IS NOT NULL AND paid_via = 'bit_manual') paid_bit,
            count(*) FILTER (WHERE paid_at IS NOT NULL AND brief_done_at IS NOT NULL) brief_done,
            count(*) FILTER (WHERE paid_at IS NOT NULL AND brief_done_at IS NULL AND paid_at < now() - interval '24 hours') brief_overdue,
            count(*) FILTER (WHERE status = 'refunded') refunded,
            count(*) FILTER (WHERE status = 'pending') pending,
            count(*) FILTER (WHERE status = 'failed') failed,
            count(*) FILTER (WHERE paid_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.order_id = o.order_id)
                              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = o.session_id AND e.event_name = 'agent_opened')) paid_direct,
            COALESCE(sum(amount) FILTER (WHERE paid_at IS NOT NULL AND status <> 'refunded'), 0) revenue
     FROM orders o WHERE environment = $1 AND created_at > ${since}`, P);

  // Estimated active time per consenting session (sum of time_summary deltas).
  const time = await one(
    `SELECT count(*) sessions, percentile_cont(0.5) WITHIN GROUP (ORDER BY active) median_active_ms, avg(active) avg_active_ms
     FROM (SELECT session_id, sum((props->>'active_ms')::bigint) active FROM events
           WHERE environment = $1 AND event_name = 'time_summary' AND occurred_at > ${since} GROUP BY session_id) t`, P);

  const sources = await q(
    `SELECT COALESCE(s.first_touch->>'utm_source', CASE WHEN s.first_touch ? 'fbclid' THEN 'facebook (fbclid)' END, s.first_touch->>'referrer_host', 'direct') source,
            COALESCE(s.first_touch->>'utm_campaign', '') campaign,
            count(DISTINCT s.session_id) sessions,
            count(DISTINCT e.session_id) FILTER (WHERE e.event_name = 'agent_opened') agent_open,
            count(DISTINCT e.session_id) FILTER (WHERE e.event_name = 'checkout_clicked') checkout_click
     FROM sessions s LEFT JOIN events e ON e.session_id = s.session_id AND e.occurred_at > ${since}
     WHERE s.environment = $1 AND s.started_at > ${since}
     GROUP BY 1, 2 ORDER BY sessions DESC LIMIT 20`, P);
  const paidBySource = await q(
    `SELECT COALESCE(attribution->'last'->>'utm_source', CASE WHEN attribution->'last' ? 'fbclid' THEN 'facebook (fbclid)' END, CASE WHEN attribution IS NULL THEN 'unknown (no consent)' END, 'direct') source,
            count(*) paid FROM orders WHERE environment = $1 AND paid_at IS NOT NULL AND created_at > ${since} GROUP BY 1 ORDER BY 2 DESC`, P);

  const devices = await q(
    `SELECT device, count(*) sessions FROM sessions WHERE environment = $1 AND started_at > ${since} GROUP BY 1 ORDER BY 2 DESC`, P);

  const lastStage = await q(
    `SELECT COALESCE(NULLIF(data_collection->'last_stage'->>'value', ''), 'unknown') stage, count(*) c
     FROM conversations WHERE environment = $1 AND COALESCE(started_at, received_at) > ${since} GROUP BY 1 ORDER BY 2 DESC`, P);

  const health = await one(
    `SELECT
       (SELECT count(*) FROM webhook_events WHERE provider = 'paypal' AND received_at > ${since} AND error IS NOT NULL) paypal_webhook_errors,
       (SELECT count(*) FROM webhook_events WHERE provider = 'paypal' AND received_at > ${since} AND verified = false) paypal_bad_signatures,
       (SELECT count(*) FROM webhook_events WHERE provider = 'paypal' AND received_at > ${since} AND error = 'unmatched_order') paypal_unmatched,
       (SELECT count(*) FROM webhook_events WHERE provider = 'elevenlabs' AND processed_at IS NULL AND payload IS NOT NULL AND (environment IS NULL OR environment = $1)) elevenlabs_unprocessed,
       (SELECT count(*) FROM webhook_events WHERE provider = 'elevenlabs' AND verified AND received_at > ${since}) elevenlabs_received,
       (SELECT count(*) FROM webhook_events WHERE provider = 'elevenlabs' AND NOT verified AND received_at > ${since}) elevenlabs_bad_signatures,
       (SELECT count(*) FROM meta_outbox m JOIN orders o USING (order_id) WHERE o.environment = $1 AND m.status = 'pending') meta_pending,
       (SELECT count(*) FROM meta_outbox m JOIN orders o USING (order_id) WHERE o.environment = $1 AND m.status = 'no_consent') meta_no_consent,
       (SELECT count(*) FROM meta_outbox m JOIN orders o USING (order_id) WHERE o.environment = $1 AND m.status IN ('failed','expired')) meta_gave_up,
       (SELECT count(*) FROM meta_outbox m JOIN orders o USING (order_id) WHERE o.environment = $1 AND m.status = 'sent' AND m.created_at > ${since}) meta_sent,
       (SELECT count(*) FROM notify_outbox n JOIN orders o USING (order_id) WHERE o.environment = $1 AND n.status = 'pending'
          AND (n.action <> 'receipt' OR o.status IN ('paid', 'partially_refunded', 'refunded'))) emails_pending,
       (SELECT count(*) FROM notify_outbox n JOIN orders o USING (order_id) WHERE o.environment = $1 AND n.status = 'failed') emails_failed,
       (SELECT count(*) FROM payments p JOIN orders o USING (order_id) WHERE o.environment = $1 AND p.status = 'COMPLETED' AND p.provider = 'paypal' AND o.paid_at IS NULL) captured_not_marked,
       (SELECT count(*) FROM events WHERE environment = $1 AND event_name = 'agent_error' AND occurred_at > ${since}) agent_errors,
       (SELECT count(*) FROM events WHERE environment = $1 AND event_name = 'agent_tool_result' AND props->>'ok' = 'false' AND occurred_at > ${since}) agent_tool_failures,
       (SELECT count(*) FROM events WHERE environment = $1 AND event_name = 'client_error' AND occurred_at > ${since}) client_errors,
       (SELECT count(*) FROM payments p JOIN orders o USING (order_id) WHERE o.environment = $1 AND p.status LIKE 'REJECTED_%' AND p.created_at > ${since}) rejected_captures`, P);

  // Deliveries refused for a bad signature: shown one by one so a planned security test can be told apart from a real attempt.
  const rejectedWebhooks = await q(
    `SELECT provider, event_id, event_type, error, received_at FROM webhook_events
     WHERE verified = false AND received_at > ${since} AND (environment IS NULL OR environment = $1) ORDER BY received_at DESC LIMIT 20`, P);
  // Why each Meta Purchase is still waiting (outside production nothing is sent without a test code).
  const metaWaiting = await q(
    `SELECT m.order_id, m.status, m.attempts, m.last_error, m.next_attempt_at FROM meta_outbox m JOIN orders o USING (order_id)
     WHERE o.environment = $1 AND m.status = 'pending' ORDER BY m.created_at DESC LIMIT 20`, [env]);

  const toNum = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v === null ? null : Number(v)]));
  return {
    environment: env, days, generated_at: new Date().toISOString(),
    consenting_sessions: entries,
    funnel: [
      { key: 'entries', label: 'כניסות (מסכימים למדידה)', count: entries, source: 'events' },
      { key: 'agent_open', label: 'פתחו את מיטל', count: agentOpen, source: 'events' },
      { key: 'agent_start_requested', label: 'בקשת התחלת שיחה', count: agentStart, source: 'events' },
      { key: 'first_user_message', label: 'הודעה ראשונה של לקוח', count: n(conv.with_user_message), source: 'conversations (webhook, באיחור)' },
      { key: 'checkout_presented', label: 'הוצג תשלום', count: checkoutPresented, source: 'events' },
      { key: 'checkout_clicked', label: 'לחצו לשלם', count: checkoutClicked, source: 'events' },
      { key: 'purchase_verified', label: 'רכישה מאומתת', count: n(ord.paid), source: 'orders (כולם)' },
      { key: 'brief_completed', label: 'אפיון הושלם', count: n(ord.brief_done), source: 'orders (כולם)' },
    ],
    orders: toNum(ord),
    conversations: toNum(conv),
    time: toNum(time),
    sources: sources.map(toNum0), paid_by_source: paidBySource.map(toNum0), devices: devices.map(toNum0), last_stage: lastStage.map(toNum0),
    health: toNum(health),
    rejected_webhooks: rejectedWebhooks, meta_waiting: metaWaiting,
  };
}
function toNum0(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v; return o; }

export async function recentOrders(limit = 50) {
  return q(`SELECT order_id, status, amount, currency, paid_at, paid_via, brief_done_at, created_at,
                   contact->>'name' AS name, attribution->'last'->>'utm_source' AS source,
                   (SELECT count(*) FROM conversations c WHERE c.order_id = o.order_id) AS conversations
            FROM orders o WHERE environment = $1 ORDER BY created_at DESC LIMIT $2`, [cfg.environment, limit]);
}

export async function orderDetail(orderId) {
  const order = await one(`SELECT * FROM orders WHERE order_id = $1 AND environment = $2`, [orderId, cfg.environment]);
  if (!order) return null;
  delete order.token_hash;
  const [payments, events, conversations, audit, outbox, notify, webhooks, verified] = await Promise.all([
    q(`SELECT provider, capture_id, status, amount, currency, payee_merchant, verified_by, reference, created_at FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId]),
    // The newest 300 (a long call can log hundreds before payment); shown oldest first.
    q(`SELECT * FROM (SELECT event_name, occurred_at, channel, props FROM events WHERE order_id = $1 OR (session_id IS NOT NULL AND session_id = $2)
       ORDER BY occurred_at DESC LIMIT 300) e ORDER BY occurred_at`, [orderId, order.session_id]),
    q(`SELECT conversation_id, status, started_at, duration_secs, user_turns, agent_turns, summary, data_collection, transcript, termination_reason, received_at
       FROM conversations WHERE order_id = $1 ORDER BY started_at`, [orderId]),
    q(`SELECT admin_user, action, details, at FROM admin_audit WHERE order_id = $1 ORDER BY at`, [orderId]),
    q(`SELECT event_name, status, attempts, sent_at, last_error FROM meta_outbox WHERE event_id = $1`, [orderId]),
    // Never the personal link (secret_link): only what was sent and when.
    q(`SELECT action, status, attempts, sent_at, last_error, created_at FROM notify_outbox WHERE order_id = $1 ORDER BY created_at`, [orderId]),
    q(`SELECT event_type, verified, received_at, last_received_at, deliveries, processed_at, error FROM webhook_events
       WHERE provider = 'paypal' AND order_id = $1 ORDER BY received_at`, [orderId]),
    // Counted on its own: never depends on how many other events the session has.
    one(`SELECT count(*)::int c FROM events WHERE event_name = 'purchase_verified' AND order_id = $1`, [orderId]),
  ]);
  const meta = outbox[0] || null;
  return { order, payments, events, conversations, audit, meta, notify, webhooks, checks: paymentChecks(order, payments, events, meta, webhooks, verified.c) };
}

// The payment facts an owner needs to sign off one order, computed from the records (not from emails or logs).
export function paymentChecks(order, payments, events, meta, webhooks, verifiedCount) {
  const done = payments.filter(p => p.status === 'COMPLETED' || p.status === 'MANUAL_OK');
  const captured = done.reduce((s, p) => s + Number(p.amount || 0), 0);
  const payees = [...new Set(done.map(p => p.payee_merchant).filter(Boolean))];
  return {
    environment: order.environment,
    status: order.status,
    completed_payments: done.length,
    distinct_captures: new Set(done.map(p => p.capture_id)).size,
    captured_total: captured.toFixed(2),
    expected_total: Number(order.amount).toFixed(2),
    amount_matches: done.length > 0 && captured.toFixed(2) === Number(order.amount).toFixed(2),
    currency: [...new Set(done.map(p => p.currency))].join(',') || null,
    currency_matches: done.length > 0 && done.every(p => p.currency === order.currency),
    payee: payees.join(',') || null,
    payee_matches: !cfg.paypal.merchantId ? null : done.length > 0 && done.every(p => p.provider !== 'paypal' || p.payee_merchant === cfg.paypal.merchantId),
    purchase_verified_events: verifiedCount ?? events.filter(e => e.event_name === 'purchase_verified').length,
    meta_purchase: meta ? meta.status : 'none',
    meta_sent_as: !meta || meta.status !== 'sent' ? null : cfg.meta.testCode ? 'test_event_code' : 'production',
    webhook_deliveries: webhooks.reduce((s, w) => s + (w.deliveries || 1), 0),
    webhook_resends: webhooks.reduce((s, w) => s + Math.max(0, (w.deliveries || 1) - 1), 0),
  };
}
