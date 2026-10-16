// Older orders for the dashboard, page by page (admin only). Active work is never paged: see summary.work_orders.
import { json, handle } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { recentOrders } from '../../lib/report.js';

export const GET = handle(async (request) => {
  await requireAdmin(request);
  const u = new URL(request.url), before = u.searchParams.get('before');
  const rows = await recentOrders(100, before && !isNaN(Date.parse(before)) ? before : null);
  return json({ ok: true, orders: rows, more: rows.length === 100 });
});
