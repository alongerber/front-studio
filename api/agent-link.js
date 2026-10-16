// The page attaches its agent link key to an order it owns (needed when the order existed before the call).
import { json, handle, readJson, httpError } from '../lib/util.js';
import { ownedOrder, attachAgentLink, rateLimit } from '../lib/store.js';

export const POST = handle(async (request) => {
  const b = await readJson(request, 2 * 1024);
  const o = await ownedOrder(b.order_id, b.token);
  await rateLimit('link:' + o.order_id, 20);
  if (!(await attachAgentLink(o.order_id, b.agent_link))) throw httpError(400, 'bad_link');
  return json({ ok: true });
});
