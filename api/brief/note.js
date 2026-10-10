// Save one brief fact immediately (called by Meital's save_brief_note tool, before or after payment).
import { json, handle, readJson } from '../../lib/util.js';
import { ownedOrder, saveNote, archiveBrief, rateLimit } from '../../lib/store.js';

export const POST = handle(async (request) => {
  const b = await readJson(request, 4 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  await rateLimit('note:' + o.order_id, 60);
  // switch_ad(change_direction): archive the previous direction (kept as an event), start an empty brief.
  if (b.action === 'change_direction') { const a = await archiveBrief(o); return json({ ok: true, archived: true, fields: Object.keys(a.brief || {}) }); }
  const updated = await saveNote(o, String(b.field || 'other'), b.value);
  return json({ ok: true, fields: Object.keys(updated.brief || {}) });
});
