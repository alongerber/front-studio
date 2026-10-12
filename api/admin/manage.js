// Owner actions on one order (admin only, every change audited): continuation link, production stage,
// customer delays, delivery-target correction, linking stored webhook rows to the order. None of them sends a message or touches payment or brief.
import { json, handle, readJson, httpError } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { rateLimit } from '../../lib/store.js';
import { linkWebhookEvents } from '../../lib/webhook-link.js';
import { setStage, addDelay, endDelay, cancelDelay, setDueOverride, issueLink, revokeLinks } from '../../lib/production.js';

export const POST = handle(async (request) => {
  const admin = await requireAdmin(request);
  const b = await readJson(request, 4 * 1024);
  await rateLimit('manage:' + admin, 60);
  const id = String(b.order_id || '');
  switch (b.action) {
    case 'issue_link':   return json({ ok: true, ...(await issueLink(id, b.request_id, admin)) });
    case 'revoke_links': return json({ ok: true, ...(await revokeLinks(id, admin)) });
    case 'set_stage':    return json({ ok: true, ...(await setStage(id, b.to, b.from, admin)) });
    case 'add_delay':    return json({ ok: true, ...(await addDelay(id, b, admin)) });
    case 'end_delay':    return json({ ok: true, ...(await endDelay(id, Number(b.delay_id), b.ended_on, admin)) });
    case 'cancel_delay': return json({ ok: true, ...(await cancelDelay(id, Number(b.delay_id), admin)) });
    case 'set_due':      return json({ ok: true, ...(await setDueOverride(id, b.date === null ? null : String(b.date || ''), b.reason, admin)) });
    case 'link_webhooks': return json({ ok: true, ...(await linkWebhookEvents(id, b.event_ids, admin)) });   // metadata only, never reprocessed
    default: throw httpError(400, 'bad_action');
  }
});
