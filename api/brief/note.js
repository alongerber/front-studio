// Save one brief fact immediately (called by Meital's save_brief_note tool, before or after payment).
import { json, handle, readJson, httpError } from '../../lib/util.js';
import { PAGE_PROTOCOL } from '../../lib/agent-tools.js';
import { ownedOrder, saveNote, archiveBrief, rateLimit, isPaid } from '../../lib/store.js';

export const POST = handle(async (request) => {
  // A tab opened before the current release runs old page code (e.g. no switch_ad): its notes are refused,
  // so the agent hears "not saved" instead of writing a new business onto the wrong order.
  if (Number(request.headers.get('x-front-proto') || 0) < PAGE_PROTOCOL) throw httpError(409, 'page_outdated');
  const b = await readJson(request, 4 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  // A sales conversation never writes onto an order that is already paid (that brief belongs to the paid ad).
  if (b.phase === 'sales' && isPaid(o)) throw httpError(409, 'paid_order');
  await rateLimit('note:' + o.order_id, 60);
  // switch_ad(change_direction): archive the previous direction (kept as an event), start an empty brief.
  if (b.action === 'change_direction') { const a = await archiveBrief(o); return json({ ok: true, archived: true, fields: Object.keys(a.brief || {}) }); }
  const updated = await saveNote(o, String(b.field || 'other'), b.value);
  return json({ ok: true, order_id: o.order_id, saved: updated.saved_field, fields: Object.keys(updated.brief || {}) });
});
