// "Retry now" from the dashboard: same recovery run as the daily cron. Audited.
import { q } from '../../lib/db.js';
import { json, handle } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { recover } from '../../lib/recovery.js';
import { cfg } from '../../lib/config.js';

export const config = { maxDuration: 60 };

export const POST = handle(async (request) => {
  const admin = await requireAdmin(request);
  // A Purchase that waited only for missing Meta settings is due at once on a manual retry (after the settings were added),
  // not an hour later. Rows backing off after a real Meta error keep their backoff. This environment's orders only.
  await q(`UPDATE meta_outbox m SET next_attempt_at = now() FROM orders o
           WHERE o.order_id = m.order_id AND o.environment = $1 AND m.status = 'pending'
             AND m.last_error IN ('not_configured','test_code_required') AND m.next_attempt_at > now()`, [cfg.environment]);
  const r = await recover();
  await q(`INSERT INTO admin_audit (admin_user, action, details) VALUES ($1,'run_recovery',$2::jsonb)`,
    [admin, JSON.stringify({ repaired_payments: r.repaired_payments, side_effects: r.side_effects, replayed: r.conversations_replayed,
      meta_sent: r.meta.filter(x => x.ok).length, emails_sent: r.notify.filter(x => x.ok).length })]);
  return json({ ok: true, ...r });
});
