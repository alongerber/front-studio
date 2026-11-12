// Manual Bit verification. Needs an admin login and a bank/Bit reference. A screenshot is not proof:
// the admin confirms they saw the money in the account, and the reference + who + when are audited.
import { json, handle, readJson, isOrderId, httpError } from '../../lib/util.js';
import { requireAdmin } from '../../lib/admin.js';
import { applyManual } from '../../lib/payment.js';

export const POST = handle(async (request) => {
  const admin = await requireAdmin(request);
  const b = await readJson(request, 4 * 1024);
  if (!isOrderId(b.order_id)) throw httpError(400, 'bad_order_id');
  if (b.confirm_seen_in_account !== true) throw httpError(400, 'confirm_seen_in_account_required');
  const r = await applyManual(b.order_id, admin, b.reference, b.note);
  if (!r.ok) throw httpError(r.reason === 'unknown_order' ? 404 : 400, r.reason);
  return json({ ok: true, paid: true, first: r.first });
});
