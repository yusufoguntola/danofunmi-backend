// Transactional email via Zoho CPaaS (ZeptoMail) — a no-op everywhere it's
// used if ZOHO_API_KEY isn't set, matching this project's pattern for
// optional external services (ANTHROPIC_API_KEY, RECAPTCHA_SECRET_KEY, ...).
const { SendMailClient } = require('zeptomail');
const { getFrontendOrigins } = require('./frontendOrigins');
const prisma = require('../db');

const nairaFormatter = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  maximumFractionDigits: 0,
});

function isConfigured() {
  return !!(process.env.ZOHO_BASE_URL && process.env.ZOHO_API_KEY);
}

let client = null;
function getClient() {
  if (!client) {
    client = new SendMailClient({ url: process.env.ZOHO_BASE_URL, token: process.env.ZOHO_API_KEY });
  }
  return client;
}

function fromAddress() {
  return {
    address: process.env.MAIL_FROM_ADDRESS || 'noreply@danofunmi.com',
    name: process.env.MAIL_FROM_NAME || 'dánọ́fúnmi',
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The site's public origin, for building absolute URLs email clients can
// actually fetch (a bare path won't resolve for someone reading in their
// inbox). Falls back to the production domain if FRONTEND_ORIGIN isn't set
// — always used for the logo below.
function siteOrigin() {
  return getFrontendOrigins()[0] || 'https://danofunmi.com';
}

// Same green/terracotta/cream palette as the frontend (frontend/src/index.css)
// and the status-card mockups — inlined and table-based since email clients
// don't load stylesheets or Google Fonts reliably. Shared by every email this
// module sends; `heading`/`bodyHtml` are the only parts that vary. The logo
// is the same PWA icon (LogoMark's "Concept C" cooking-pot) served from the
// frontend's public/icons — real image, not a placeholder emoji, so it
// renders in email clients that don't load Google Fonts or emoji glyphs.
function emailShell({ title, heading, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f2f7ef;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f7ef;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#16321f;border-radius:20px;overflow:hidden;">
        <tr><td style="padding:40px 36px 28px;text-align:center;">
          <img src="${siteOrigin()}/icons/icon-192.png" width="64" height="64" alt="dánọ́fúnmi" style="display:block;width:64px;height:64px;margin:0 auto 18px;border-radius:50%;" />
          <div style="font-style:italic;font-weight:700;font-size:28px;color:#faf6ec;letter-spacing:0.01em;">dánọ́fúnmi</div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(250,246,236,0.75);margin-top:6px;">You choose, we cook.</div>
        </td></tr>
      </table>

      <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:20px;margin-top:16px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="padding:36px;">
          <h1 style="margin:0 0 14px;font-size:24px;font-style:italic;color:#16321f;">${heading}</h1>
          ${bodyHtml}
          <p style="margin:26px 0 0;font-size:13px;font-style:italic;color:#7a897e;"><strong style="font-style:normal;color:#16321f;">dánọ́fúnmi</strong> · from &ldquo;Dánọ́ fún mi&rdquo; — &ldquo;cook for me&rdquo;</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const MENU_BLURB = `<table role="presentation" style="width:100%;background:#f2f7ef;border-radius:14px;">
  <tr><td style="padding:18px 20px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#33443a;">
    🍲 Any soup, any combination — Buka Stew, Efo Riro, Egusi, Ewedu &amp; more<br>
    🚚 Delivered fresh, packed exactly as requested<br>
    🗓️ Ordering opens once a month
  </td></tr>
</table>`;

// Sent immediately on submission — just a receipt, not a promise of a slot.
// Whoever actually makes the final first-taste list gets a second, separate
// email (see shortlistEmailHtml) once admin picks them.
function receiptEmailHtml({ name, claimedSlot, landmark }) {
  const firstName = (name || '').trim().split(' ')[0] || 'friend';
  const message = claimedSlot
    ? `Thanks, ${firstName} — we&rsquo;ve received your request for one of the limited <strong>first taste</strong> slots. We&rsquo;re going through requests now; if you make the final list, we&rsquo;ll send you another email to confirm.`
    : `Thanks, ${firstName}! We&rsquo;ve received your interest and added you to our waitlist. If you make it onto the first-taste shortlist, we&rsquo;ll send you another email to confirm — otherwise we&rsquo;ll let you know the moment ordering opens to everyone.`;
  const landmarkRow = landmark
    ? `<tr><td style="padding:4px 0;color:#5b6b60;font-size:14px;">Popular landmark near you</td></tr>
       <tr><td style="padding:0 0 4px;color:#16321f;font-size:15px;font-weight:700;">${escapeHtml(landmark)}</td></tr>`
    : '';

  return emailShell({
    title: "We've received your request",
    heading: "Got it — you&rsquo;re on the list",
    bodyHtml: `
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#33443a;">${message}</p>
      ${landmarkRow ? `<table role="presentation" style="width:100%;margin:0 0 22px;">${landmarkRow}</table>` : ''}
      ${MENU_BLURB}
    `,
  });
}

// Sent only to the customers admin has shortlisted for the actual first
// taste — the "you made it" email that follows the receipt above.
function shortlistEmailHtml({ name }) {
  const firstName = (name || '').trim().split(' ')[0] || 'friend';
  return emailShell({
    title: "You're on the first-taste list!",
    heading: 'You made the list! 🎉',
    bodyHtml: `
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#33443a;">
        Great news, ${firstName} — you&rsquo;re one of the customers we&rsquo;ve picked for the first taste of dánọ́fúnmi. Your first perk is free from the kitchen; delivery fee is on you. We&rsquo;ll be in touch shortly with next steps.
      </p>
      ${MENU_BLURB}
    `,
  });
}

// Mirrors frontend/src/lib/format.js's formatStatus() wording, badge classes
// in frontend/src/index.css.
const STATUS_LABELS = {
  PENDING_PAYMENT: 'Pending payment',
  PAYMENT_SUBMITTED: 'Payment submitted',
  CONFIRMED: 'Confirmed',
  PACKED: 'Packed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

const STATUS_MESSAGES = {
  CONFIRMED: 'Your order is confirmed — we&rsquo;re getting it ready.',
  PACKED: 'Your order has been packed and is ready to go out.',
  OUT_FOR_DELIVERY: 'Your order is on its way to you!',
  DELIVERED: 'Your order has been delivered — enjoy!',
  CANCELLED: 'Your order has been cancelled.',
};

// Sent whenever admin moves an order to a new status — the email counterpart
// to the existing push notification (see lib/orderNotifications.js), so
// customers hear about it even without the PWA installed / push enabled.
function orderStatusEmailHtml(order) {
  const label = STATUS_LABELS[order.status] || order.status;
  const message = STATUS_MESSAGES[order.status] || `Your order status is now &ldquo;${label}&rdquo;.`;
  const origin = getFrontendOrigins()[0];
  // Once delivered, the useful next step is feedback rather than tracking
  // (the status is final) — so the CTA switches over instead of stacking
  // both links.
  const ctaLink = !origin
    ? ''
    : order.status === 'DELIVERED'
      ? `<p style="margin:0 0 22px;"><a href="${origin}/feedback/${order.id}" style="color:#c4652f;font-weight:700;text-decoration:none;">Leave feedback &rarr;</a></p>`
      : `<p style="margin:0 0 22px;"><a href="${origin}/order/${order.id}" style="color:#c4652f;font-weight:700;text-decoration:none;">Track your order &rarr;</a></p>`;
  const itemRows = (order.items || [])
    .map(
      (item) =>
        `<tr><td style="padding:6px 0;font-size:13px;color:#33443a;">${item.quantity}&times; ${escapeHtml(item.itemName)} (${escapeHtml(item.size)})</td>
         <td style="padding:6px 0;font-size:13px;color:#33443a;text-align:right;">${nairaFormatter.format(Number(item.lineTotal))}</td></tr>`
    )
    .join('');

  return emailShell({
    title: `Order ${order.narration} — ${label}`,
    heading: label,
    bodyHtml: `
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#33443a;">${message}</p>
      <table role="presentation" style="width:100%;background:#f2f7ef;border-radius:14px;margin:0 0 22px;">
        <tr><td style="padding:18px 20px;">
          <p style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#5b6b60;">Order ${escapeHtml(order.narration)}</p>
          <table role="presentation" style="width:100%;border-collapse:collapse;">
            ${itemRows}
            <tr><td style="padding:10px 0 0;font-size:13px;font-weight:700;color:#16321f;border-top:1px solid rgba(0,0,0,0.08);">Total</td>
            <td style="padding:10px 0 0;font-size:13px;font-weight:700;color:#16321f;text-align:right;border-top:1px solid rgba(0,0,0,0.08);">${nairaFormatter.format(Number(order.total))}</td></tr>
          </table>
        </td></tr>
      </table>
      ${ctaLink}
    `,
  });
}

// Sent to every AdminUser whenever a customer submits payment proof (see
// sendAdminReceiptNotificationEmail below) — never customer-facing.
function adminReceiptEmailHtml(order) {
  const origin = getFrontendOrigins()[0];
  const ctaLink = origin
    ? `<p style="margin:0 0 22px;"><a href="${origin}/restricted-path" style="color:#c4652f;font-weight:700;text-decoration:none;">Review in admin &rarr;</a></p>`
    : '';
  return emailShell({
    title: `New payment — ${order.narration}`,
    heading: 'Payment received',
    bodyHtml: `
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#33443a;">
        ${escapeHtml(order.customer?.name || 'A customer')} (${escapeHtml(order.customer?.phone || 'no phone on file')})
        submitted payment for order <strong>${escapeHtml(order.narration)}</strong> — total ${nairaFormatter.format(Number(order.total))}.
        Please confirm it in the admin dashboard.
      </p>
      ${ctaLink}
    `,
  });
}

// A crash/error/bug alert — see sendAdminAlertEmail below. `message` is
// server-generated (an error message, not admin- or customer-typed), still
// escaped since it can echo back user input (e.g. a malformed request body).
function adminAlertEmailHtml({ subject, message, context }) {
  const contextHtml = context
    ? `<pre style="margin:16px 0 0;padding:14px 16px;background:#f2f7ef;border-radius:10px;font-size:12px;line-height:1.5;color:#33443a;white-space:pre-wrap;word-break:break-word;">${escapeHtml(context)}</pre>`
    : '';
  return emailShell({
    title: subject,
    heading: '⚠️ ' + subject,
    bodyHtml: `
      <p style="margin:0;font-size:15px;line-height:1.6;color:#33443a;white-space:pre-wrap;">${escapeHtml(message)}</p>
      ${contextHtml}
    `,
  });
}

// Admin's free-text "send a broadcast" announcement (new menu, monthly
// ordering reminder, ...) — see routes/broadcast.js. `body` is admin-typed
// plain text, so it's escaped and line breaks preserved rather than treated
// as HTML.
function broadcastEmailHtml({ title, body }) {
  return emailShell({
    title,
    heading: title,
    bodyHtml: `<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#33443a;white-space:pre-wrap;">${escapeHtml(body)}</p>`,
  });
}

// The one-time "we're live!" announcement — see scripts/send-go-live-email.js.
// `items` are real-photo menu items (lib/menuCatalog.js's listPhotoItems),
// shown as a photo grid so the email actually sells the food rather than
// just announcing a link; gracefully falls back to the plain MENU_BLURB
// text when no item has a real photo on file yet. `link` carries the
// `?launch=` cache-busting marker sw.js's NavigationRoute denylist uses to
// force a fresh network load, for anyone whose browser still has the old
// "coming soon" build precached from before launch.
function goLivePhotoCellHtml(item) {
  return `<td width="50%" style="padding:6px;">
    <div style="border-radius:14px;overflow:hidden;background:#f2f7ef;">
      <img src="${escapeHtml(item.icon)}" alt="${escapeHtml(item.name)}" width="100%" style="display:block;width:100%;aspect-ratio:1;object-fit:cover;" />
      <div style="padding:8px 10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;color:#16321f;text-align:center;">${escapeHtml(item.name)}</div>
    </div>
  </td>`;
}

function goLivePhotoGridHtml(items) {
  if (!items || items.length === 0) return '';
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2);
    const cells = pair.map(goLivePhotoCellHtml).join('') + (pair.length === 1 ? '<td width="50%"></td>' : '');
    rows.push(`<tr>${cells}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">${rows.join('')}</table>`;
}

function goLiveEmailHtml({ name, items, link }) {
  const firstName = (name || '').trim().split(' ')[0] || 'friend';
  const photoGrid = goLivePhotoGridHtml(items);
  return emailShell({
    title: "We're live!",
    heading: 'We&rsquo;re live, ' + escapeHtml(firstName) + '! 🎉',
    bodyHtml: `
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#33443a;">
        The wait is over — dánọ́fúnmi is officially open for orders. Pick your favorites, any combination, and we&rsquo;ll cook it fresh and have it delivered to you.
      </p>
      ${photoGrid || MENU_BLURB}
      <table role="presentation" style="width:100%;margin:26px 0 0;">
        <tr><td align="center">
          <a href="${escapeHtml(link)}" style="display:inline-block;background:#c4652f;color:#faf6ec;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px;text-decoration:none;padding:14px 34px;border-radius:999px;">Order now &rarr;</a>
        </td></tr>
      </table>
    `,
  });
}

/** Best-effort — callers should catch and log rather than fail the request
 * over a delivery problem. A no-op (with a console notice) if ZOHO_API_KEY
 * isn't set. */
async function sendFirstTasteConfirmationEmail({ to, name, claimedSlot, landmark }) {
  if (!isConfigured()) {
    console.log(`[email] ZOHO_API_KEY not set — skipping receipt email to ${to}`);
    return;
  }
  await getClient().sendMail({
    from: fromAddress(),
    to: [{ email_address: { address: to, name: name || '' } }],
    subject: "We've received your dánọ́fúnmi interest request",
    htmlbody: receiptEmailHtml({ name, claimedSlot, landmark }),
  });
}

/** Same best-effort/graceful-absence contract as above. Sent by the admin
 * "email shortlisted customers" bulk action once someone's been picked for
 * the final first-taste list. */
async function sendShortlistConfirmationEmail({ to, name }) {
  if (!isConfigured()) {
    console.log(`[email] ZOHO_API_KEY not set — skipping shortlist email to ${to}`);
    return;
  }
  await getClient().sendMail({
    from: fromAddress(),
    to: [{ email_address: { address: to, name: name || '' } }],
    subject: "You're in! You made the dánọ́fúnmi first-taste list 🎉",
    htmlbody: shortlistEmailHtml({ name }),
  });
}

/** Same best-effort/graceful-absence contract as above. A no-op if the order
 * has no customer email on file (order.customer.email) — the push
 * notification (lib/orderNotifications.js) still covers that case. */
async function sendOrderStatusEmail(order) {
  const to = order.customer?.email;
  if (!to) return;
  if (!isConfigured()) {
    console.log(`[email] ZOHO_API_KEY not set — skipping order status email to ${to}`);
    return;
  }
  const label = STATUS_LABELS[order.status] || order.status;
  await getClient().sendMail({
    from: fromAddress(),
    to: [{ email_address: { address: to, name: order.customer.name || '' } }],
    subject: `Order ${order.narration} — ${label}`,
    htmlbody: orderStatusEmailHtml(order),
  });
}

/** Same best-effort/graceful-absence contract as above. Sent to every
 * AdminUser's email — see lib/orderNotifications.js's notifyAdminOfPayment,
 * fired whenever a customer submits payment proof (POST
 * /api/orders/:id/receipt) — so admin doesn't have to keep refreshing the
 * Orders tab to notice. A no-op if there are no admin accounts, same as the
 * "no recipient" guards on the customer-facing sends above. */
async function sendAdminReceiptNotificationEmail(order) {
  if (!isConfigured()) {
    console.log(`[email] ZOHO_API_KEY not set — skipping admin receipt notification for order ${order.narration}`);
    return;
  }
  const admins = await prisma.adminUser.findMany({ select: { email: true, name: true } });
  if (admins.length === 0) return;
  const htmlbody = adminReceiptEmailHtml(order);
  await Promise.all(
    admins.map((admin) =>
      getClient().sendMail({
        from: fromAddress(),
        to: [{ email_address: { address: admin.email, name: admin.name || '' } }],
        subject: `New payment for order ${order.narration} — please confirm`,
        htmlbody,
      })
    )
  );
}

// ADMIN_EMAILS is a comma-separated list, e.g.
// "owner@example.com, dev@example.com" — deliberately a separate config
// from the AdminUser table above: a crash/error alert should reach whoever
// is actually on call (which may include people with no admin login at
// all), not just accounts that happen to exist in the app.
function getAdminAlertEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Same best-effort/graceful-absence contract as above, plus a second no-op
 * guard: skipped (not just logged) if ADMIN_EMAILS isn't set, same
 * "optional, never blocks the caller" shape as everything else here. Used
 * for crash/error/bug alerts — see lib/errorLog.js (general unexpected
 * errors) and routes/chat.js (the AI chat failing or running out of
 * credit). `context` is optional extra detail (e.g. a request path, a stack
 * trace) shown in a preformatted block. */
async function sendAdminAlertEmail({ subject, message, context }) {
  const to = getAdminAlertEmails();
  if (to.length === 0) return;
  if (!isConfigured()) {
    console.log(`[email] ZOHO_API_KEY not set — skipping admin alert: ${subject}`);
    return;
  }
  const htmlbody = adminAlertEmailHtml({ subject, message, context });
  await Promise.all(
    to.map((email) =>
      getClient().sendMail({
        from: fromAddress(),
        to: [{ email_address: { address: email } }],
        subject: `[dánọ́fúnmi alert] ${subject}`,
        htmlbody,
      })
    )
  );
}

/** Same best-effort/graceful-absence contract as above. Sent by
 * scripts/send-go-live-email.js — `items` should come from
 * lib/menuCatalog.js's listPhotoItems(), `launchToken` is shared across the
 * whole send so every recipient's link carries the same `?launch=` marker
 * (sw.js forces a fresh network load for it rather than serving a
 * precached pre-launch shell). */
async function sendGoLiveEmail({ to, name, items, launchToken }) {
  if (!isConfigured()) {
    console.log(`[email] ZOHO_API_KEY not set — skipping go-live email to ${to}`);
    return;
  }
  const origin = siteOrigin();
  const link = `${origin}/?launch=${encodeURIComponent(launchToken || Date.now())}`;
  await getClient().sendMail({
    from: fromAddress(),
    to: [{ email_address: { address: to, name: name || '' } }],
    subject: "We're live! dánọ́fúnmi is open for orders 🎉",
    htmlbody: goLiveEmailHtml({ name, items, link }),
  });
}

/** Same best-effort/graceful-absence contract as above. Sent by the admin
 * multi-channel broadcast tool (routes/broadcast.js) to every customer with
 * an email on file. */
async function sendBroadcastEmail({ to, name, title, body }) {
  if (!isConfigured()) {
    console.log(`[email] ZOHO_API_KEY not set — skipping broadcast email to ${to}`);
    return;
  }
  await getClient().sendMail({
    from: fromAddress(),
    to: [{ email_address: { address: to, name: name || '' } }],
    subject: title,
    htmlbody: broadcastEmailHtml({ title, body }),
  });
}

module.exports = {
  isConfigured,
  sendFirstTasteConfirmationEmail,
  sendShortlistConfirmationEmail,
  sendOrderStatusEmail,
  sendAdminReceiptNotificationEmail,
  sendAdminAlertEmail,
  sendBroadcastEmail,
  sendGoLiveEmail,
};
