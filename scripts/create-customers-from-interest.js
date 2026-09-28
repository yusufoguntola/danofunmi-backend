#!/usr/bin/env node
// One-off backfill: registers a real Customer for every existing first-taste
// interest registration (claimedSlot: true) that predates
// lib/firstTaste.js's ensureCustomerForFirstTaste being called automatically
// on new submissions. Safe to re-run — it's the same conservative
// get-or-create/backfill-only-if-empty logic used everywhere else, so
// already-processed registrations are just skipped over harmlessly.
require('dotenv').config();
// Reuses the same shared client ensureCustomerForFirstTaste itself uses
// (src/db.js), rather than opening a second connection pool for this script.
const prisma = require('../src/db');
const { ensureCustomerForFirstTaste } = require('../src/lib/firstTaste');

async function main() {
  const registrations = await prisma.interestRegistration.findMany({
    where: { claimedSlot: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  if (registrations.length === 0) {
    console.log('No first-taste registrations found — nothing to do.');
    return;
  }

  console.log(`Found ${registrations.length} first-taste registration(s).`);

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const registration of registrations) {
    const before = registration.phone
      ? await prisma.customer.findUnique({ where: { phone: registration.phone } })
      : null;

    try {
      const customer = await ensureCustomerForFirstTaste(registration);
      if (!customer) {
        console.warn(`  Skipped ${registration.name} (${registration.email}) — no phone on file.`);
        failed += 1;
      } else if (!before) {
        console.log(`  Created customer for ${customer.name} (${customer.phone}).`);
        created += 1;
      } else if (
        before.address !== customer.address ||
        before.landmark !== customer.landmark ||
        before.email !== customer.email
      ) {
        console.log(`  Backfilled existing customer for ${customer.name} (${customer.phone}).`);
        updated += 1;
      } else {
        unchanged += 1;
      }
    } catch (err) {
      console.error(`  Failed for ${registration.name} (${registration.email}):`, err.message);
      failed += 1;
    }
  }

  console.log(
    `\nDone — ${created} created, ${updated} backfilled, ${unchanged} already up to date, ${failed} failed/skipped.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
