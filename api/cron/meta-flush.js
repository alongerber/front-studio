// Daily recovery run (Vercel Cron sends "Authorization: Bearer $CRON_SECRET"):
// repairs half-done payments, replays stored webhook deliveries, delivers queued Meta events and emails.
import { q } from '../../lib/db.js';
import { cfg } from '../../lib/config.js';
import { json, handle, safeEqual, httpError } from '../../lib/util.js';
import { recover } from '../../lib/recovery.js';

export const config = { maxDuration: 60 };

export const GET = handle(async (request) => {
  const auth = request.headers.get('authorization') || '';
  if (!cfg.cronSecret || !safeEqual(auth, `Bearer ${cfg.cronSecret}`)) throw httpError(401, 'unauthorized');
  const r = await recover();
  await q(`DELETE FROM rate_limits WHERE win_start < now() - interval '1 day'`);
  return json({ ok: true, ...r, attempted: r.meta.length, sent: r.meta.filter(x => x.ok).length, emails_sent: r.notify.filter(x => x.ok).length });
});
