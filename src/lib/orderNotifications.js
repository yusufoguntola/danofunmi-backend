const { sendPushToPhone } = require('./push');
const { sendOrderStatusEmail, sendAdminReceiptNotificationEmail } = require('./email');
const { getOrderTimeline, formatDeliveryRange } = require('./orderTimeline');

/**
 * The admin-set delivery window (lib/orderTimeline.js) to quote on a newly
 * CONFIRMED order, e.g. '16th – 18th of November' — or null for any other
 * status, when no timeline is set, or when the order is batched for a
 * different month than the timeline's delivery (e.g. a combo that missed its
 * cutoff and rolled into next month's run), so it's never told a wrong date.
 */
async function deliveryRangeFor(order) {
  if (order.status !== 'CONFIRMED') return null;
  const timeline = await getOrderTimeline().catch((err) => {
    console.error('getOrderTimeline failed:', err);
    return null;
  });
  if (!timeline) return null;
  if (order.orderMonth && order.orderMonth !== timeline.deliveryStartsOn.slice(0, 7)) return null;
  return formatDeliveryRange(timeline);
}

/**
 * Tells a customer their order's status changed — push (in-app) and email,
 * side by side, so they hear about it whether or not the PWA is installed.
 * Both are best-effort: a customer with no push subscription, or no email on
 * file, is silently skipped for that channel rather than erroring.
 *
 * `order` must include `customer` and `items` (see orderIncludes in
 * routes/orders.js). `title`/`body` override the push copy; the email always
 * derives its own copy from `order.status` (see lib/email.js). A CONFIRMED
 * order's push and email both also carry its scheduled delivery window (see
 * deliveryRangeFor above).
 *
 * Returns a promise that settles once both channels are done — existing
 * callers (the HTTP routes) fire-and-forget it same as always, but a
 * short-lived process (e.g. scripts/set-order-status.js) can `await` it to
 * make sure delivery actually happens before the process exits.
 */
async function notifyOrderStatusChange(order, { title, body } = {}) {
  const deliveryRange = await deliveryRangeFor(order);
  const pushBody = body || `Now ${order.status.replaceAll('_', ' ')}`;

  const pushDone = sendPushToPhone(order.customer.phone, {
    title: title || `Order ${order.narration}`,
    body: deliveryRange ? `${pushBody} Delivery: ${deliveryRange}.` : pushBody,
    url: `/order/${order.id}`,
  }).catch((err) => console.error('sendPushToPhone failed:', err));

  const emailDone = sendOrderStatusEmail(order, { deliveryRange }).catch((err) =>
    console.error('sendOrderStatusEmail failed:', err)
  );

  return Promise.all([pushDone, emailDone]);
}

/**
 * Tells admin a customer just submitted payment proof (a receipt image, or
 * sender name + bank) for an order, so it doesn't sit unnoticed until
 * someone happens to refresh the Orders tab. Fire-and-forget, same as
 * notifyOrderStatusChange above — best-effort, never blocks the route that
 * triggered it.
 */
function notifyAdminOfPayment(order) {
  return sendAdminReceiptNotificationEmail(order).catch((err) =>
    console.error('sendAdminReceiptNotificationEmail failed:', err)
  );
}

module.exports = { notifyOrderStatusChange, notifyAdminOfPayment };
