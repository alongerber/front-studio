// ElevenLabs post-call webhook: the only reliable source for "the call connected",
// "the customer wrote/spoke", the transcript and the structured summary. Arrives after the call.
import { createHmac } from 'node:crypto';
import { q, one } from '../../lib/db.js';
import { cfg } from '../../lib/config.js';
import { json, handle, readBody, clip, safeEqual } from '../../lib/util.js';
import { serverEvent, isLinkKey, orderForLink } from '../../lib/store.js';

export const config = { maxDuration: 20 };
const TOLERANCE_SECS = 30 * 60;

// Header "ElevenLabs-Signature: t=<unix>,v0=<hex hmac sha256 of `${t}.${body}`>"
// Returns null when valid, otherwise why it was rejected (recorded, never the secret or the signature).
export function elevenSignatureProblem(header, raw, secret, nowSecs = Math.floor(Date.now() / 1000)) {
  if (!secret) return 'secret_not_configured';
  if (!header) return 'no_signature_header';
  const parts = Object.fromEntries(String(header).split(',').map(p => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v0) return 'malformed_signature';
  if (Math.abs(nowSecs - t) > TOLERANCE_SECS) return 'stale_timestamp';
  const mac = createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  return safeEqual(mac, parts.v0) ? null : 'signature_mismatch';
}
export function verifyElevenSignature(header, raw, secret, nowSecs) { return elevenSignatureProblem(header, raw, secret, nowSecs) === null; }

// Data Collection values may be plain strings/booleans or JSON {value, basis}.
function dc(results, key) {
  const r = results && results[key];
  if (!r) return { value: null, basis: null };
  let v = r.value;
  if (typeof v === 'string') { try { const p = JSON.parse(v); if (p && typeof p === 'object' && 'value' in p) return { value: p.value, basis: p.basis || null }; } catch {} }
  if (v && typeof v === 'object' && 'value' in v) return { value: v.value, basis: v.basis || null };
  return { value: v, basis: null };
}
const truthy = (v) => v === true || v === 'true' || v === 'yes' || v === 'כן';
const known = (v) => v != null && String(v).trim() !== '' && !/^(unknown|null|none|לא ידוע)$/i.test(String(v).trim());

export function qualify(results) {
  const business = dc(results, 'business_type'), need = dc(results, 'promote_goal');
  const askedPrice = dc(results, 'asked_price'), askedPay = dc(results, 'asked_payment'), stage = dc(results, 'last_stage');
  const intent = truthy(askedPrice.value) || truthy(askedPay.value) || ['close', 'payment', 'brief'].includes(String(stage.value || ''));
  const ok = known(business.value) && known(need.value) && intent;
  const declared = dc(results, 'info_basis').value;                        // agent field (see ANALYTICS_CONTRACT §6)
  const basis = declared === 'inferred' || [business.basis, need.basis].includes('inferred') ? 'inferred' : 'stated';
  return { ok, basis };
}

// Agent turns that say the payment arrived without a verified check_payment result before them in the same
// conversation. The server cannot stop a sentence from being generated, so every such turn is recorded for review.
const PAYMENT_CLAIM = /התשלום\s+(?:כבר\s+)?(?:התקבל|אושר|עבר|נקלט|הצליח)|קיבלנו\s+את\s+התשלום|רואה\s+(?:את\s+)?(?:ה)?תשלום/;
export function unverifiedPaymentClaims(transcript) {
  let verified = false; const out = [];
  for (const t of transcript || []) {
    if (!t) continue;
    for (const r of t.tool_results || []) {
      if (r && r.tool_name === 'check_payment' && !r.is_error) verified = /"payment"\s*:\s*"verified"/.test(String(r.result_value || ''));
    }
    if (t.role === 'agent' && PAYMENT_CLAIM.test(String(t.message || '')) && !verified) out.push(t.time_in_call_secs ?? null);
  }
  return out;
}

// Agent turns that say the payment window opened, when the last open_payment result before them did not start with OPENED.
const OPEN_CLAIM = /חלון\s+(?:ה)?תשלום\s+(?:כבר\s+)?(?:נפתח|פתוח)|פתחתי\s+(?:לכם\s+)?(?:את\s+)?(?:חלון|ה?תשלום)/;
export function unconfirmedWindowClaims(transcript) {
  let opened = false; const out = [];
  for (const t of transcript || []) {
    if (!t) continue;
    for (const r of t.tool_results || []) {
      if (r && (r.tool_name === 'open_payment' || r.tool_name === 'show_payment')) opened = !r.is_error && /^OPENED\b/.test(String(r.result_value || '').trim());
    }
    if (t.role === 'agent' && OPEN_CLAIM.test(String(t.message || '')) && !opened) out.push(t.time_in_call_secs ?? null);
  }
  return out;
}

// Process one stored delivery. Throws on failure; the caller keeps the raw delivery for replay.
export async function processElevenEvent(evt) {
  const d = evt.data || {};
  const convId = clip(d.conversation_id, 120);
  const vars = (d.conversation_initiation_client_data && d.conversation_initiation_client_data.dynamic_variables) || {};
  const md = d.metadata || {};
  const transcript = Array.isArray(d.transcript) ? d.transcript : [];
  const userTurns = transcript.filter(t => t && t.role === 'user' && String(t.message || '').trim());
  const agentTurns = transcript.filter(t => t && t.role === 'agent' && String(t.message || '').trim());
  const firstUser = userTurns[0] || null;
  const analysis = d.analysis || {};
  const linkKey = isLinkKey(vars.front_link) ? vars.front_link : null;
  // The agent and the browser may claim any order id; we link only through the link key the order owner attached.
  const order = linkKey ? await orderForLink(linkKey) : null;
  const failed = evt.type === 'call_initiation_failure' || d.status === 'failed';
  const startedAt = md.start_time_unix_secs ? new Date(md.start_time_unix_secs * 1000).toISOString() : null;
  const sessionId = order && order.session_id || (typeof vars.session_id === 'string' ? clip(vars.session_id, 64) : null);
  const anonymousId = order && order.anonymous_id || (typeof vars.anonymous_id === 'string' ? clip(vars.anonymous_id, 64) : null);

  await q(`INSERT INTO conversations (conversation_id, agent_id, agent_version, environment, anonymous_id, session_id, order_id, status, started_at,
             duration_secs, user_turns, agent_turns, first_user_at_secs, data_collection, summary, transcript, termination_reason, link_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17,$18)
           ON CONFLICT (conversation_id) DO UPDATE SET status = EXCLUDED.status, duration_secs = EXCLUDED.duration_secs,
             user_turns = EXCLUDED.user_turns, agent_turns = EXCLUDED.agent_turns, first_user_at_secs = EXCLUDED.first_user_at_secs,
             data_collection = EXCLUDED.data_collection, summary = EXCLUDED.summary, transcript = EXCLUDED.transcript,
             termination_reason = EXCLUDED.termination_reason, order_id = COALESCE(conversations.order_id, EXCLUDED.order_id), received_at = now()`,
    [convId, clip(d.agent_id, 80), clip(d.version_id || d.branch_id, 80), cfg.environment, anonymousId, sessionId, order && order.order_id || null,
     clip(d.status || evt.type, 40), startedAt, Number.isFinite(md.call_duration_secs) ? Math.round(md.call_duration_secs) : null,
     userTurns.length, agentTurns.length, firstUser && Number.isFinite(firstUser.time_in_call_secs) ? firstUser.time_in_call_secs : null,
     JSON.stringify(analysis.data_collection_results || null), clip(analysis.transcript_summary, 4000),
     JSON.stringify(transcript.map(t => ({ role: t.role, message: clip(t.message, 2000), t: t.time_in_call_secs ?? null }))),
     clip(md.termination_reason, 200), linkKey]);

  const base = { conversationId: convId, orderId: order && order.order_id || null, sessionId, anonymousId, channel: 'elevenlabs', agentVersion: clip(d.version_id, 80), at: startedAt };
  if (failed) await serverEvent('agent_error', { ...base, eventId: `agent_error:${convId}`, props: { status: d.status || evt.type, reason: clip(md.termination_reason || (d.failure_reason), 200) } });
  else if (agentTurns.length) await serverEvent('agent_connected', { ...base, eventId: `agent_connected:${convId}` });
  if (firstUser) {
    const medium = firstUser.source_medium || firstUser.input_mode || null;   // only if ElevenLabs provides it
    await serverEvent('agent_first_user_message', { ...base, eventId: `agent_first_user_message:${convId}`,
      at: startedAt && Number.isFinite(firstUser.time_in_call_secs) ? new Date(md.start_time_unix_secs * 1000 + firstUser.time_in_call_secs * 1000).toISOString() : startedAt,
      props: { mode: medium === 'text' ? 'text' : medium === 'audio' || medium === 'voice' ? 'voice' : 'unknown', at_secs: firstUser.time_in_call_secs ?? null } });
  }
  const opens = unconfirmedWindowClaims(transcript);
  if (opens.length) await serverEvent('agent_unconfirmed_window_claim', { ...base, eventId: `agent_unconfirmed_window_claim:${convId}`, props: { at_secs: opens.slice(0, 10) } });
  const claims = unverifiedPaymentClaims(transcript);
  if (claims.length) await serverEvent('agent_unverified_payment_claim', { ...base, eventId: `agent_unverified_payment_claim:${convId}`, props: { at_secs: claims.slice(0, 10) } });
  const qual = qualify(analysis.data_collection_results);
  if (qual.ok) await serverEvent('lead_qualified', { ...base, eventId: `lead_qualified:${order ? order.order_id : convId}`, props: { basis: qual.basis } });

  return { linked: !!order, note: order ? null : (linkKey ? 'no_order_yet' : 'no_link_key') };
}

// Durability: the raw delivery is stored BEFORE processing.
//  - storing fails  → 500, so ElevenLabs retries the delivery;
//  - processing fails → the delivery stays in webhook_events (payload kept, processed_at NULL) and is replayed
//    by the recovery sweep (next deliveries, the daily cron, or the dashboard's "retry now"). Answer 200 so
//    ElevenLabs does not count it as a failure and disable the webhook.
export async function markElevenProcessed(eventKey, res) {
  await q(`UPDATE webhook_events SET processed_at = now(), error = $2, payload = NULL WHERE provider = 'elevenlabs' AND event_id = $1`, [eventKey, res.note]);
}

export const POST = handle(async (request) => {
  const raw = await readBody(request, 2 * 1024 * 1024);
  const problem = elevenSignatureProblem(request.headers.get('elevenlabs-signature'), raw, cfg.elevenlabs.webhookSecret);
  if (problem) {
    // Visible in the dashboard ("webhooks rejected for signature") and in the logs, so a silent 401 cannot hide a broken connection.
    let conv = null; try { conv = clip(JSON.parse(raw).data.conversation_id, 120); } catch {}
    console.warn('[elevenlabs webhook] rejected', problem, conv || '');
    try {
      await q(`INSERT INTO webhook_events (provider, event_id, event_type, verified, error, environment) VALUES ('elevenlabs',$1,$2,false,$3,$4) ON CONFLICT DO NOTHING`,
        ['unverified:' + (conv || Date.now()), 'post_call', problem, cfg.environment]);
    } catch (e) { console.error('[elevenlabs webhook] could not record rejection', e && e.message); }
    return json({ ok: false, error: 'bad_signature' }, 401);
  }
  let evt; try { evt = JSON.parse(raw); } catch { return json({ ok: false }, 400); }
  const d = evt.data || {};
  const convId = clip(d.conversation_id, 120);
  if (!convId) return json({ ok: true, ignored: 'no_conversation_id' });
  if (cfg.elevenlabs.agentId && d.agent_id && d.agent_id !== cfg.elevenlabs.agentId) return json({ ok: true, ignored: 'other_agent' });
  const eventKey = `${evt.type || 'unknown'}:${convId}`;
  const isAudio = evt.type === 'post_call_audio';                         // audio is never stored

  // 1. store (500 on failure → ElevenLabs retries)
  const fresh = await q(`INSERT INTO webhook_events (provider, event_id, event_type, verified, payload, environment, processed_at)
                         VALUES ('elevenlabs',$1,$2,true,$3::jsonb,$4, CASE WHEN $5 THEN now() END) ON CONFLICT DO NOTHING RETURNING event_id`,
    [eventKey, evt.type || null, isAudio ? null : raw, cfg.environment, isAudio]);
  if (isAudio) return json({ ok: true, ignored: 'audio' });
  if (!fresh.length) {
    const prev = await one(`SELECT processed_at FROM webhook_events WHERE provider = 'elevenlabs' AND event_id = $1`, [eventKey]);
    if (prev && prev.processed_at) return json({ ok: true, duplicate: true });
    await q(`UPDATE webhook_events SET payload = COALESCE(payload, $2::jsonb) WHERE provider = 'elevenlabs' AND event_id = $1`, [eventKey, raw]);
  }

  // 2. process (failure → kept for replay, answer 200)
  try {
    const res = await processElevenEvent(evt);
    await markElevenProcessed(eventKey, res);
    console.log('[elevenlabs webhook] processed', eventKey, res.linked ? 'linked' : (res.note || 'not_linked'));
    return json({ ok: true, linked: res.linked });
  } catch (e) {
    console.error('[elevenlabs webhook]', e && e.stack || e);
    try { await q(`UPDATE webhook_events SET error = $2, attempts = attempts + 1 WHERE provider = 'elevenlabs' AND event_id = $1`, [eventKey, clip(e.message, 300)]); } catch {}
    return json({ ok: true, queued_for_retry: true });
  }
});
