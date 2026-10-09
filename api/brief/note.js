// Save one brief fact immediately (called by Meital's save_brief_note tool, before or after payment).
import { json, handle, readJson } from '../../lib/util.js';
import { ownedOrder, saveNote, rateLimit } from '../../lib/store.js';

export const POST = handle(async (request) => {
  const b = await readJson(request, 4 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  await rateLimit('note:' + o.order_id, 60);
  const updated = await saveNote(o, String(b.field || 'other'), b.value);
  return json({ ok: true, fields: Object.keys(updated.brief || {}) });
});
