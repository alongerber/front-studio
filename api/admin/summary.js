// Dashboard data (admin only).
import { json, handle } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { summary, recentOrders } from '../../lib/report.js';

export const GET = handle(async (request) => {
  await requireAdmin(request);
  const days = Math.max(1, Math.min(90, parseInt(new URL(request.url).searchParams.get('days') || '7', 10) || 7));
  const [s, orders] = await Promise.all([summary(days), recentOrders(50)]);
  return json({ ok: true, ...s, recent_orders: orders });
});
