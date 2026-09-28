#!/usr/bin/env node
// One-off backfill: creates the free "First Taste" order for every shortlisted
// InterestRegistration that doesn't have one yet. Going forward, shortlisting
// someone (PATCH /api/admin/interest/:id with a locationId — see
// AdminInterest.jsx) creates this order automatically; this script is for
// registrations that were shortlisted before that existed.
//
// The delivery location can't be reliably parsed from the free-text
// landmark/address, so this doesn't try too hard: it looks for a location's
// name inside that text, and falls back to a random active location when
// nothing matches (or when --location isn't given either). A wrongly-
// assigned location isn't a dead end — admin can fix it afterwards from
// Admin → Orders → select the order → "Change" next to the delivery
// location (see routes/orders.js's PATCH .../location).
//
// Pass --location=<id or name> to use one location for everyone instead,
// skipping detection/randomness entirely.
require('dotenv').config();
// Reuses the same shared client createFirstTasteOrder itself uses (src/db.js),
// rather than opening a second connection pool for this script.
const prisma = require('../src/db');
const { createFirstTasteOrder } = require('../src/lib/firstTaste');
const { OrderValidationError } = require('../src/lib/orderCreation');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--location=(.+)$/.exec(arg);
    if (m) out.location = m[1];
  }
  return out;
}

// Looks for a location's name (the part before the city suffix, e.g. "Akobo"
// out of "Akobo, Ibadan") inside the registration's landmark/address text.
function detectLocation(registration, locations) {
  const haystack = `${registration.landmark || ''} ${registration.address || ''}`.toLowerCase();
  return locations.find((l) => {
    const key = l.name.split(',')[0].trim().toLowerCase();
    return key && haystack.includes(key);
  });
}

function randomLocation(locations) {
  return locations[Math.floor(Math.random() * locations.length)];
}

async function main() {
  const { location: locationArg } = parseArgs(process.argv.slice(2));

  const pending = await prisma.interestRegistration.findMany({
    where: { shortlisted: true, orderId: null, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  if (pending.length === 0) {
    console.log('No shortlisted registrations are missing an order — nothing to do.');
    return;
  }

  const locations = await prisma.location.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });
  if (locations.length === 0) {
    console.error('No active locations configured — add one in admin before running this.');
    process.exitCode = 1;
    return;
  }

  let fixedLocation = null;
  if (locationArg) {
    fixedLocation = locations.find(
      (l) => l.id === locationArg || l.name.toLowerCase() === locationArg.toLowerCase()
    );
    if (!fixedLocation) {
      console.error(
        `No active location matches "${locationArg}". Available: ${locations.map((l) => l.name).join(', ')}`
      );
      process.exitCode = 1;
      return;
    }
  }

  console.log(`Found ${pending.length} shortlisted registration(s) without an order.`);
  if (fixedLocation) console.log(`Using "${fixedLocation.name}" for all of them.\n`);

  let created = 0;
  let failed = 0;

  for (const registration of pending) {
    let location = fixedLocation;
    let how = 'forced';
    if (!location) {
      location = detectLocation(registration, locations);
      how = 'detected';
    }
    if (!location) {
      location = randomLocation(locations);
      how = 'random — please double-check';
    }

    try {
      const order = await createFirstTasteOrder(registration, location.id);
      console.log(`  Created order ${order.narration} for ${registration.name} — ${location.name} (${how}).`);
      created += 1;
    } catch (err) {
      console.error(`  Failed for ${registration.name}: ${err instanceof OrderValidationError ? err.message : err.message}`);
      failed += 1;
    }
  }

  console.log(`\nDone — ${created} created, ${failed} failed.`);
  if (created > 0) {
    console.log('Detected/random assignments are guesses — review them under Admin → Orders and use "Change" next to the delivery location to correct any that are wrong.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
