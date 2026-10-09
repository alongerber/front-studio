// Browser analytics intake. Only with analytics consent, only whitelisted events and props.
// A failure here must never affect the page: the client fires and forgets (sendBeacon).
import { q, one } from '../lib/db.js';
import { cfg } from '../lib/config.js';
import { json, handle, readBody, clientIp, clip, isUuid, isOrderId, sha256, safeEqual, deviceOf } from '../lib/util.js';
import { rateLimit } from '../lib/store.js';

// event name → allowed prop keys (anything else is dropped silently)
export const BROWSER_EVENTS = {
  landing_view: ['referrer_host', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'campaign_id', 'adset_id', 'ad_id', 'has_fbclid', 'viewport'],
  section_view: ['section'],
  cta_click: ['cta_target'],
  video_start: ['video'], video_progress: ['video', 'pct'], video_complete: ['video'],
  time_summary: ['open_ms', 'visible_ms', 'active_ms', 'final'],
  whatsapp_click: [],
  consent_updated: ['analytics', 'ads'],
  agent_opened: [],
  agent_start_requested: [],
  agent_tool_result: ['tool', 'ok', 'error'],
  checkout_presented: ['method'],
  checkout_clicked: ['method'],
  payment_cancelled: ['method'],
  client_error: ['where', 'message'],
};
const CTA = new Set(['hero', 'offer', 'final', 'dock', 'topbar', 'agent', 'thanks']);
const TOUCH = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign_id', 'adset_id', 'ad_id', 'referrer_host', 'landing_path', 'ts'];

function cleanProps(name, p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const k of BROWSER_EVENTS[name]) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number') out[k] = Number.isFinite(v) ? Math.max(-1e9, Math.min(1e9, Math.round(v))) : null;
    else if (typeof v === 'boolean') out[k] = v;
    else out[k] = clip(String(v), 200);
  }
  return out;
}
function cleanTouch(t) {
  if (!t || typeof t !== 'object') return null;
  const o = {}; for (const k of TOUCH) if (t[k] != null) o[k] = clip(String(t[k]), 500);
  if (t.fbclid) o.fbclid = clip(String(t.fbclid), 1000);
  return Object.keys(o).length ? o : null;
}
function cleanPath(p) {
  const s = String(p || '/').split('?')[0].split('#')[0];
  return /^\/[\w\-./]*$/.test(s) ? clip(s, 120) : '/';
}

async function tokenOk(orderId, token) {
  if (!isOrderId(orderId) || typeof token !== 'string' || token.length < 20) return false;
  const o = await one(`SELECT token_hash FROM orders WHERE order_id = $1 AND environment = $2`, [orderId, cfg.environment]);
  return !!o && safeEqual(o.token_hash, sha256(token));
}

export const POST = handle(async (request) => {
  const raw = await readBody(request, 32 * 1024);            // sendBeacon sends text/plain
  let b; try { b = JSON.parse(raw); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  const consent = b && b.consent || {};
  // No analytics consent → we store nothing (the client should not even call us).
  if (consent.analytics !== 'granted') return json({ ok: true, stored: 0, reason: 'no_consent' }, 202);
  if (!isUuid(b.anonymous_id) || !isUuid(b.session_id)) return json({ ok: false, error: 'bad_ids' }, 400);
  const events = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
  if (!events.length) return json({ ok: true, stored: 0 });

  const ip = clientIp(request) || 'noip';
  await rateLimit('track:' + sha256(ip).slice(0, 16), 240);
  await rateLimit('track_anon:' + b.anonymous_id, 120);

  const ua = request.headers.get('user-agent') || '';
  const device = deviceOf(ua);
  await q(`INSERT INTO sessions (session_id, anonymous_id, environment, first_touch, last_touch, device)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
           ON CONFLICT (session_id) DO UPDATE SET last_seen_at = now(),
             last_touch = COALESCE(EXCLUDED.last_touch, sessions.last_touch),
             first_touch = COALESCE(sessions.first_touch, EXCLUDED.first_touch)`,
    [b.session_id, b.anonymous_id, cfg.environment, JSON.stringify(cleanTouch(b.first_touch)), JSON.stringify(cleanTouch(b.last_touch)), device]);

  // An order id is accepted only together with its token.
  const orderId = b.order_id && await tokenOk(b.order_id, b.order_token) ? b.order_id : null;
  const consentState = JSON.stringify({ analytics: 'granted', ads: consent.ads === 'granted' ? 'granted' : 'denied' });
  const now = Date.now();
  let stored = 0, rejected = 0;
  for (const e of events) {
    if (!e || !BROWSER_EVENTS[e.name] || !isUuid(e.id)) { rejected++; continue; }
    let at = Date.parse(e.at); if (!Number.isFinite(at) || Math.abs(at - now) > 24 * 3600e3) at = now;   // browser clocks lie
    const props = cleanProps(e.name, e.props);
    props.device = device;
    const rows = await q(
      `INSERT INTO events (event_id, event_name, occurred_at, anonymous_id, session_id, lead_id, order_id, page_path, cta_location, channel, site_version, environment, consent_state, props)
       VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$6,$7,$8,'web',$9,$10,$11::jsonb,$12::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [e.id, e.name, at, b.anonymous_id, b.session_id, orderId, cleanPath(e.path), CTA.has(e.cta) ? e.cta : null,
       clip(b.site_version, 40) || cfg.siteVersion, cfg.environment, consentState, JSON.stringify(props)]);
    stored += rows.length;
  }
  return json({ ok: true, stored, rejected });
});
