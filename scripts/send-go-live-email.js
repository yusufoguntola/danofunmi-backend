#!/usr/bin/env node
// Sends the one-time "we're live!" announcement email (see
// lib/email.js's sendGoLiveEmail) — either to every customer with an email
// on file, or to a specific list of addresses. Two npm aliases cover both
// (see package.json): `email:go-live:all` and `email:go-live:to`.
require('dotenv').config();
const prisma = require('../src/db');
const { sendGoLiveEmail, isConfigured } = require('../src/lib/email');
const { listPhotoItems, listActiveItems } = require('../src/lib/menuCatalog');

function usage() {
  console.error('Usage: npm run email:go-live:all');
  console.error('       npm run email:go-live:to -- customer@example.com another@example.com');
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== '--all' && mode !== '--to') {
    usage();
    process.exit(1);
  }
  if (mode === '--to' && rest.length === 0) {
    usage();
    process.exit(1);
  }

  if (!isConfigured()) {
    console.error('ZOHO_BASE_URL/ZOHO_API_KEY are not set — cannot send email.');
    process.exit(1);
  }

  let targets;
  if (mode === '--all') {
    targets = await prisma.customer.findMany({
      where: { email: { not: null } },
      select: { email: true, name: true },
    });
  } else {
    const emails = [...new Set(rest.flatMap((a) => a.split(',')).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const customers = await prisma.customer.findMany({
      where: { email: { in: emails } },
      select: { email: true, name: true },
    });
    const byEmail = new Map(customers.map((c) => [c.email.toLowerCase(), c]));
    // Sends even to addresses with no matching Customer row (e.g. someone
    // from the pre-launch waitlist who never placed an order) — just
    // without a name to personalize the greeting with.
    targets = emails.map((email) => ({ email, name: byEmail.get(email)?.name || '' }));
  }

  if (targets.length === 0) {
    console.log('No recipients to email.');
    return;
  }

  const [items, allItems] = await Promise.all([listPhotoItems(6), listActiveItems()]);
  if (items.length === 0) {
    console.warn('No menu items have a real photo yet (lib/menuCatalog.js listPhotoItems) — the email will go out without a photo grid.');
  }

  // One shared token so every recipient's link carries the same `?launch=`
  // marker — see sw.js's NavigationRoute denylist.
  const launchToken = Date.now();

  console.log(`Sending go-live email to ${targets.length} recipient(s)...`);
  const settled = await Promise.allSettled(
    targets.map((t) => sendGoLiveEmail({ to: t.email, name: t.name, items, allItems, launchToken }))
  );

  let sent = 0;
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sent += 1;
    } else {
      failed.push(targets[i].email);
      console.error(`Failed for ${targets[i].email}:`, r.reason?.message || r.reason);
    }
  });

  console.log(`Sent ${sent}/${targets.length} go-live emails.`);
  if (failed.length > 0) console.log('Failed:', failed.join(', '));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
