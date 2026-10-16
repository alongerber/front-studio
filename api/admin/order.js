// One order with payments, events, conversations and audit (admin only). Every view is audited.
import { q } from '../../lib/db.js';
import { json, handle, isOrderId, httpError } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { orderDetail } from '../../lib/report.js';

export const GET = handle(async (request) => {
  const admin = await requireAdmin(request);
  const id = new URL(request.url).searchParams.get('order_id');
  if (!isOrderId(id)) throw httpError(400, 'bad_order_id');
  const d = await orderDetail(id);
  if (!d) throw httpError(404, 'not_found');
  await q(`INSERT INTO admin_audit (admin_user, action, order_id) VALUES ($1,'view_order',$2)`, [admin, id]);
  // A call was requested from this order's tab but the post-call webhook has not arrived (yet).
  const waiting = (d.order.agent_links || []).length > 0 && d.conversations.length === 0;
  const stale = waiting && Date.now() - new Date(d.order.updated_at).getTime() > 60 * 60 * 1000;
  return json({ ok: true, ...d, awaiting_conversation_data: waiting && !stale, conversation_data_missing: stale });
});
