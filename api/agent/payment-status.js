// Meital's check_payment tool (an ElevenLabs server tool, called by ElevenLabs, not by the browser).
// The answer comes only from the server's payment records. The conversation is identified by the page's link key,
// which only the order's owner could attach (with the order token); an order id in the request is ignored, so
// swapping it reveals nothing. Only the payment state and the order number are returned.
import { json, handle, readJson, sha256, uuid } from '../../lib/util.js';
import { orderForLink, paymentState, isLinkKey, rateLimit, serverEvent } from '../../lib/store.js';

export const config = { maxDuration: 10 };

const SAY = {
  verified: 'התשלום אומת בשרת. מותר לומר שהתשלום התקבל ולהמשיך לאפיון.',
  not_paid: 'אין תשלום מאומת. אסור לומר שהתשלום התקבל. אמרי: ״אני עדיין לא רואה אישור תשלום. אם הרגע שילמתם, נבדוק שוב בעוד רגע.״',
  pending: 'פייפאל עדיין בודקים את התשלום. אסור לומר שהתשלום התקבל. אמרי שהתשלום בבדיקה אצל פייפאל ושאפשר להמשיך לאפיון בינתיים.',
  refunded: 'התשלום להזמנה הזו הוחזר. אסור לומר שהתשלום התקבל, ואי אפשר להעביר אותה להפקה.',
  no_order: 'אין הזמנה שמקושרת לשיחה הזו. אסור לומר שהתשלום התקבל. אם הלקוח אומר ששילם, אמרי שאת לא רואה אישור והציעי וואטסאפ.',
};

export const POST = handle(async (request) => {
  const b = await readJson(request, 2 * 1024);
  const checkedAt = new Date().toISOString();
  if (!isLinkKey(b.link)) return json({ ok: true, payment: 'no_order', order_id: null, checked_at: checkedAt, instruction: SAY.no_order });
  await rateLimit('paycheck:' + sha256(b.link).slice(0, 16), 30);
  const o = await orderForLink(b.link);
  const payment = paymentState(o);
  if (o) await serverEvent('agent_payment_checked', { eventId: 'agent_payment_checked:' + uuid(), orderId: o.order_id, sessionId: o.session_id, channel: 'elevenlabs', props: { result: payment } });
  return json({ ok: true, payment, order_id: o ? o.order_id : null, checked_at: checkedAt, instruction: SAY[payment] });
});
