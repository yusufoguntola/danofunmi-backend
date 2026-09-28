#!/usr/bin/env node
// Manually moves an order to a given status from the command line — the CLI
// equivalent of PATCH /api/orders/admin/:id/status (see routes/orders.js),
// for support/debugging situations where going through the admin UI isn't
// practical. Same side effects as that endpoint: the relevant per-status
// timestamp field, statusUpdatedAt (see project_danofunmi_status_updated_at),
// and the customer push/email notification (skippable with --notify=false).
require('dotenv').config();
// Reuses the same shared client/helpers the route itself uses (src/db.js),
// rather than opening a second connection pool for this script.
const prisma = require('../src/db');
const { notifyOrderStatusChange } = require('../src/lib/orderNotifications');

const VALID_STATUSES = [
  'PENDING_PAYMENT',
  'PAYMENT_SUBMITTED',
  'CONFIRMED',
  'PACKED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
];

const STATUS_TIMESTAMP_FIELD = {
  PACKED: 'packedAt',
  OUT_FOR_DELIVERY: 'outForDeliveryAt',
  DELIVERED: 'deliveredAt',
  CANCELLED: 'cancelledAt',
};

function usage() {
  console.error('Usage: npm run order:set-status -- <orderId|narration|orderNumber> <STATUS> [riderContact...]');
  console.error(`  STATUS:        one of ${VALID_STATUSES.join(', ')}`);
  console.error('  riderContact:  optional free text, only meaningful for OUT_FOR_DELIVERY');
  console.error('  --notify=false to skip the customer push/email notification');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const skipNotify = rawArgs.includes('--notify=false');
  const [idArg, statusArg, ...riderParts] = rawArgs.filter((a) => a !== '--notify=false');

  if (!idArg || !statusArg) {
    usage();
    process.exit(1);
  }

  const status = statusArg.toUpperCase();
  if (!VALID_STATUSES.includes(status)) {
    console.error(`Invalid status "${statusArg}".`);
    usage();
    process.exit(1);
  }
  const riderContact = riderParts.join(' ').trim() || undefined;

  const or = [{ id: idArg }, { narration: idArg }];
  if (/^\d+$/.test(idArg)) or.push({ orderNumber: Number(idArg) });
  const existing = await prisma.order.findFirst({ where: { OR: or } });
  if (!existing) {
    console.error(`No order found matching "${idArg}".`);
    process.exit(1);
  }

  const now = new Date();
  const data = { status, statusUpdatedAt: now };
  const timestampField = STATUS_TIMESTAMP_FIELD[status];
  if (timestampField) data[timestampField] = now;
  if (riderContact !== undefined) data.riderContact = riderContact;

  const order = await prisma.order.update({
    where: { id: existing.id },
    data,
    include: { customer: true, location: true, items: true, receipts: true },
  });

  console.log(`Order ${order.narration} (#${order.orderNumber}) moved from ${existing.status} to ${order.status}.`);
  if (riderContact) console.log(`Rider contact set: "${riderContact}"`);

  if (skipNotify) {
    console.log('Skipped customer notification (--notify=false).');
  } else {
    // Unlike the admin route (which fires this and moves on), this is a
    // short-lived process — await it so prisma.$disconnect() below doesn't
    // cut the notification off mid-flight (sendPushToPhone queries prisma).
    await notifyOrderStatusChange(order);
    console.log('Customer notified (push/email, best-effort).');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
