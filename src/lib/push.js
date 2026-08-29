const webpush = require('web-push');
const prisma = require('../db');

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return false;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

async function sendToSubscription(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
    } else {
      console.error('Push send failed:', err.statusCode, err.body || err.message);
    }
  }
}

/** Notifies every subscription tied to a customer's phone number (order-specific updates). */
async function sendPushToPhone(phone, payload) {
  if (!phone || !ensureConfigured()) return;
  const subs = await prisma.pushSubscription.findMany({ where: { customerPhone: phone } });
  await Promise.all(subs.map((sub) => sendToSubscription(sub, payload)));
}

/** Notifies every subscription (admin broadcasts — new menu, reminders, etc). */
async function broadcastPush(payload) {
  if (!ensureConfigured()) return { sent: 0 };
  const subs = await prisma.pushSubscription.findMany();
  await Promise.all(subs.map((sub) => sendToSubscription(sub, payload)));
  return { sent: subs.length };
}

module.exports = { sendPushToPhone, broadcastPush, isConfigured: ensureConfigured };
