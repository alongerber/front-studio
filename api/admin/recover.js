// "Retry now" from the dashboard: same recovery run as the daily cron. Audited.
import { q } from '../../lib/db.js';
import { json, handle } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { recover } from '../../lib/recovery.js';

export const config = { maxDuration: 60 };

export const POST = handle(async (request) => {
  const admin = await requireAdmin(request);
  const r = await recover();
  await q(`INSERT INTO admin_audit (admin_user, action, details) VALUES ($1,'run_recovery',$2::jsonb)`,
    [admin, JSON.stringify({ repaired_payments: r.repaired_payments, side_effects: r.side_effects, replayed: r.conversations_replayed,
      meta_sent: r.meta.filter(x => x.ok).length, emails_sent: r.notify.filter(x => x.ok).length })]);
  return json({ ok: true, ...r });
});
