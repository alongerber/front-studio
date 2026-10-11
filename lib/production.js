// Owner operations on a paid order: continuation links, production stage, delivery target and customer delays.
// Everything here is admin-only (enforced by the API that calls it) and audited. Nothing here sends a message,
// changes a payment or changes the brief.
import { q, one } from './db.js';
import { cfg } from './config.js';
import { httpError, sha256, newToken, clip } from './util.js';

/* ── stages ── */
export const STAGES = ['awaiting_brief', 'script_writing', 'awaiting_script_approval', 'in_production', 'delivered', 'revisions', 'completed'];
export const STAGE_LABEL = {
  awaiting_brief: 'ממתין לאפיון', script_writing: 'כתיבת תסריט', awaiting_script_approval: 'ממתין לאישור תסריט',
  in_production: 'בהפקה', delivered: 'נמסר', revisions: 'בתיקונים', completed: 'הושלם',
};
const ACTIVE = (o) => !!o.paid_at && o.status !== 'refunded';

// The stored stage, or (never stored yet) the only stages the stored data supports: brief done → script writing,
// otherwise awaiting brief. Nothing later (approved script, delivery) is ever inferred.
export function effectiveStage(o) {
  if (!ACTIVE(o)) return { stage: null, inferred: false };
  if (o.production_stage) return { stage: o.production_stage, inferred: false };
  return { stage: o.brief_done_at ? 'script_writing' : 'awaiting_brief', inferred: true };
}

export async function setStage(orderId, to, from, admin) {
  if (!STAGES.includes(to)) throw httpError(400, 'bad_stage');
  const o = await one(`SELECT * FROM orders WHERE order_id = $1 AND environment = $2`, [orderId, cfg.environment]);
  if (!o) throw httpError(404, 'not_found');
  if (!o.paid_at) throw httpError(409, 'not_paid');
  if (o.status === 'refunded') throw httpError(409, 'refunded');
  const cur = effectiveStage(o).stage;
  if (from !== cur) throw httpError(409, 'stage_changed');          // someone (or a double click) already changed it
  if (to === cur && o.production_stage) return { unchanged: true, stage: cur };
  // One statement: the order and its log row are written together, and only if the stage is still `from`.
  const r = await one(`
    WITH upd AS (
      UPDATE orders SET production_stage = $2, production_stage_at = now(), updated_at = now(),
        first_delivered_at = CASE WHEN $2 = 'delivered' THEN COALESCE(first_delivered_at, now()) ELSE first_delivered_at END,
        last_delivered_at  = CASE WHEN $2 = 'delivered' THEN now() ELSE last_delivered_at END
      WHERE order_id = $1 AND environment = $5 AND paid_at IS NOT NULL AND status <> 'refunded'
        AND COALESCE(production_stage, CASE WHEN brief_done_at IS NOT NULL THEN 'script_writing' ELSE 'awaiting_brief' END) = $3
      RETURNING order_id),
    log AS (INSERT INTO order_stage_log (order_id, from_stage, to_stage, changed_by) SELECT order_id, $3, $2, $4 FROM upd RETURNING id)
    SELECT (SELECT count(*) FROM upd)::int AS n`, [orderId, to, cur, admin, cfg.environment]);
  if (!r || !r.n) throw httpError(409, 'stage_changed');
  return { unchanged: false, stage: to };
}

/* ── delivery target: Israel time, business days Sunday–Thursday, no holidays (shown as an estimate) ── */
export const DUE_RULE = '7 ימי עסקים (א׳–ה׳) לפי שעון ישראל, מהיום שאחרי יום התשלום. ימי עיכוב לקוח (ימי עסקים, תקופות חופפות נספרות פעם אחת) מוסיפים לו. חגים לא נכללים, ולכן זה יעד משוער.';
export const DELIVERY_DAYS = 7;
export function israelDate(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
const toDate = (s) => new Date(s + 'T00:00:00Z');
// A DATE column as 'YYYY-MM-DD' whatever the driver returns (a string, or a Date at local midnight).
export function dstr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  return String(v).slice(0, 10);
}
const fmt = (d) => d.toISOString().slice(0, 10);
const isWorkday = (d) => { const w = d.getUTCDay(); return w !== 5 && w !== 6; };
export function addBusinessDays(dateStr, n) {
  const d = toDate(dateStr); let k = 0;
  while (k < n) { d.setUTCDate(d.getUTCDate() + 1); if (isWorkday(d)) k++; }
  return fmt(d);
}
// Business days in the union of [start, end) intervals (an open interval runs through today). Overlaps count once.
export function delayBusinessDays(delays, today) {
  const iv = delays.filter(x => !x.cancelled_at).map(x => [dstr(x.started_on), x.ended_on ? dstr(x.ended_on) : fmt(new Date(toDate(today).getTime() + 864e5))])
    .filter(([a, b]) => a < b).sort((x, y) => x[0] < y[0] ? -1 : 1);
  const merged = [];
  for (const [a, b] of iv) { const last = merged[merged.length - 1]; if (last && a <= last[1]) { if (b > last[1]) last[1] = b; } else merged.push([a, b]); }
  let n = 0;
  for (const [a, b] of merged) for (let d = toDate(a); fmt(d) < b; d.setUTCDate(d.getUTCDate() + 1)) if (isWorkday(d)) n++;
  return n;
}
export function dueBaseFor(paidAt) { return addBusinessDays(israelDate(paidAt), DELIVERY_DAYS); }

// Persist the base target for paid orders that do not have one yet (payment path and dashboard reads). Idempotent.
export async function ensureDueBase(orders) {
  for (const o of orders) {
    if (!o.paid_at || o.due_base) continue;
    o.due_base = dueBaseFor(o.paid_at);
    await q(`UPDATE orders SET due_base = $2 WHERE order_id = $1 AND due_base IS NULL`, [o.order_id, o.due_base]);
  }
}

// What the owner needs for one order: stage, targets, delays, whether it is late. Pure (no DB).
export function workState(o, delays, today = israelDate(Date.now())) {
  const { stage, inferred } = effectiveStage(o);
  const base = o.due_base ? dstr(o.due_base) : (o.paid_at ? dueBaseFor(o.paid_at) : null);
  const delayDays = delayBusinessDays(delays || [], today);
  const override = o.due_override ? dstr(o.due_override) : null;
  const current = override || (base ? addBusinessDays(base, delayDays) : null);
  const open = (delays || []).some(d => !d.cancelled_at && !d.ended_on);
  const done = stage === 'delivered' || stage === 'completed';
  return { stage, stage_label: stage ? STAGE_LABEL[stage] : null, stage_inferred: inferred, due_base: base, due_current: current,
    due_overridden: !!override, due_override_reason: o.due_override_reason || null, delay_days: delayDays, delay_open: open,
    overdue: !!current && !done && !open && today > current, first_delivered_at: o.first_delivered_at || null, last_delivered_at: o.last_delivered_at || null };
}

/* ── customer delays ── */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
async function paidOrder(orderId) {
  const o = await one(`SELECT * FROM orders WHERE order_id = $1 AND environment = $2`, [orderId, cfg.environment]);
  if (!o) throw httpError(404, 'not_found');
  if (!o.paid_at || o.status === 'refunded') throw httpError(409, 'not_active');
  return o;
}
export async function addDelay(orderId, { started_on, ended_on, reason }, admin) {
  const o = await paidOrder(orderId);
  reason = clip(String(reason || '').trim(), 200);
  if (!reason) throw httpError(400, 'reason_required');
  if (!DATE.test(started_on || '') || (ended_on && !DATE.test(ended_on))) throw httpError(400, 'bad_date');
  if (started_on < israelDate(o.paid_at)) throw httpError(400, 'before_payment');
  if (ended_on && ended_on < started_on) throw httpError(400, 'end_before_start');
  const row = await one(`INSERT INTO order_delays (order_id, started_on, ended_on, reason, created_by) VALUES ($1,$2,$3,$4,$5)
                         ON CONFLICT (order_id, started_on, reason) WHERE cancelled_at IS NULL DO NOTHING RETURNING id`,
    [orderId, started_on, ended_on || null, reason, admin]);
  if (row) await audit(admin, 'delay_added', orderId, { delay_id: row.id, started_on, ended_on: ended_on || null, reason });
  return { duplicate: !row };
}
export async function endDelay(orderId, delayId, endedOn, admin) {
  if (!DATE.test(endedOn || '')) throw httpError(400, 'bad_date');
  const r = await one(`UPDATE order_delays SET ended_on = $3, ended_by = $4, ended_at = now()
                       WHERE id = $1 AND order_id = $2 AND ended_on IS NULL AND cancelled_at IS NULL AND started_on <= $3::date RETURNING id`,
    [delayId, orderId, endedOn, admin]);
  if (!r) throw httpError(409, 'delay_not_open');
  await audit(admin, 'delay_ended', orderId, { delay_id: delayId, ended_on: endedOn });
  return {};
}
export async function cancelDelay(orderId, delayId, admin) {
  const r = await one(`UPDATE order_delays SET cancelled_at = now(), cancelled_by = $3 WHERE id = $1 AND order_id = $2 AND cancelled_at IS NULL RETURNING id`,
    [delayId, orderId, admin]);
  if (!r) throw httpError(409, 'delay_not_found');
  await audit(admin, 'delay_cancelled', orderId, { delay_id: delayId });
  return {};
}
export async function setDueOverride(orderId, date, reason, admin) {
  await paidOrder(orderId);
  reason = clip(String(reason || '').trim(), 200);
  if (!reason) throw httpError(400, 'reason_required');
  if (date !== null && !DATE.test(date || '')) throw httpError(400, 'bad_date');
  const prev = await one(`SELECT due_override FROM orders WHERE order_id = $1`, [orderId]);
  await q(`UPDATE orders SET due_override = $2, due_override_reason = $3, updated_at = now() WHERE order_id = $1`, [orderId, date, date === null ? null : reason]);
  await audit(admin, date === null ? 'due_override_cleared' : 'due_override_set', orderId,
    { from: prev && prev.due_override ? dstr(prev.due_override) : null, to: date, reason });
  return {};
}

/* ── continuation links ── */
export const LINK_DAYS = 30;
export async function issueLink(orderId, requestId, admin) {
  const o = await one(`SELECT order_id FROM orders WHERE order_id = $1 AND environment = $2`, [orderId, cfg.environment]);
  if (!o) throw httpError(404, 'not_found');
  if (!/^[0-9a-f-]{36}$/i.test(requestId || '')) throw httpError(400, 'request_id_required');
  const token = newToken();
  const row = await one(`INSERT INTO order_access (order_id, token_hash, request_id, issued_by, expires_at)
                         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) ON CONFLICT (request_id) DO NOTHING RETURNING id, expires_at`,
    [orderId, sha256(token), requestId.toLowerCase(), admin, LINK_DAYS]);
  if (!row) throw httpError(409, 'already_issued');                 // the same click arrived twice: the first answer holds the link
  await audit(admin, 'continuation_link_issued', orderId, { access_id: row.id, expires_at: row.expires_at });   // never the token
  return { link: cfg.siteUrl + '/thanks#o=' + encodeURIComponent(orderId) + '&t=' + encodeURIComponent(token), expires_at: row.expires_at, days: LINK_DAYS };
}
export async function revokeLinks(orderId, admin) {
  const rows = await q(`UPDATE order_access SET revoked_at = now(), revoked_by = $2 WHERE order_id = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING id`, [orderId, admin]);
  await audit(admin, 'continuation_links_revoked', orderId, { count: rows.length });
  return { revoked: rows.length };
}
export async function linkSummary(orderId) {
  return q(`SELECT id, issued_by, created_at, expires_at, revoked_at FROM order_access WHERE order_id = $1 ORDER BY created_at DESC`, [orderId]);
}

async function audit(admin, action, orderId, details) {
  await q(`INSERT INTO admin_audit (admin_user, action, order_id, details) VALUES ($1,$2,$3,$4::jsonb)`, [admin, action, orderId, JSON.stringify(details || {})]);
}
