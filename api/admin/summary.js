// Dashboard data (admin only).
import { json, handle } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { DUE_RULE } from '../../lib/production.js';
import { summary, recentOrders, workOrders } from '../../lib/report.js';
import { openSupport, supportRef } from '../../lib/support.js';

export const GET = handle(async (request) => {
  await requireAdmin(request);
  const days = Math.max(1, Math.min(90, parseInt(new URL(request.url).searchParams.get('days') || '7', 10) || 7));
  const [s, orders, work, support] = await Promise.all([summary(days), recentOrders(100), workOrders(), openSupport(50)]);
  return json({ ok: true, ...s, recent_orders: orders, recent_more: orders.length === 100, work_orders: work, due_rule: DUE_RULE,
    support: support.map(r => ({ ...r, ref: supportRef(r.id) })) });
});
