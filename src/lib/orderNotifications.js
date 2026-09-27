const { sendPushToPhone } = require('./push');
const { sendOrderStatusEmail } = require('./email');

/**
 * Tells a customer their order's status changed — push (in-app) and email,
 * side by side, so they hear about it whether or not the PWA is installed.
 * Both are best-effort: a customer with no push subscription, or no email on
 * file, is silently skipped for that channel rather than erroring.
 *
 * `order` must include `customer` and `items` (see orderIncludes in
 * routes/orders.js). `title`/`body` override the push copy; the email always
 * derives its own copy from `order.status` (see lib/email.js).
 */
function notifyOrderStatusChange(order, { title, body } = {}) {
  sendPushToPhone(order.customer.phone, {
    title: title || `Order ${order.narration}`,
    body: body || `Now ${order.status.replaceAll('_', ' ')}`,
    url: `/order/${order.id}`,
  }).catch((err) => console.error('sendPushToPhone failed:', err));

  sendOrderStatusEmail(order).catch((err) => console.error('sendOrderStatusEmail failed:', err));
}

module.exports = { notifyOrderStatusChange };
