const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { authRateLimit, requireBrowserOrigin } = require('../middleware/security');
const { requireRecaptcha } = require('../lib/recaptcha');
const { sendFirstTasteConfirmationEmail, sendShortlistConfirmationEmail } = require('../lib/email');
const { createFirstTasteOrder, ensureCustomerForFirstTaste } = require('../lib/firstTaste');
const { OrderValidationError } = require('../lib/orderCreation');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SETTINGS_ID = 'singleton';

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// Reads (creating with the schema default if missing) and reports the
// current first-taste slot counts. Used by both the public status endpoint
// and the admin settings endpoint.
async function getSlotStatus(client = prisma) {
  const settings = await client.launchSettings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID },
  });
  const slotsClaimed = await client.interestRegistration.count({
    where: { claimedSlot: true, deletedAt: null },
  });
  return {
    slotsTotal: settings.firstTasteSlots,
    slotsClaimed,
    slotsRemaining: Math.max(0, settings.firstTasteSlots - slotsClaimed),
  };
}

// ---------------------------------------------------------------------------
// Public — the coming-soon "I'm interested" form.
// ---------------------------------------------------------------------------
const publicRouter = express.Router();
publicRouter.use(requireBrowserOrigin);

// GET /api/interest/status — first-taste slot counts, for the coming-soon
// page's live counter and CTA state.
publicRouter.get('/status', async (req, res, next) => {
  try {
    res.json(await getSlotStatus());
  } catch (err) {
    next(err);
  }
});

// POST /api/interest — register interest to be contacted when ordering
// opens. When `claimSlot` is true the caller is asking to lock in one of the
// limited first-taste slots (and must supply `landmark`); whether that
// actually happens depends on slots still being available at the moment of
// submission — the response's `claimedSlot` reflects the real outcome.
publicRouter.post('/', authRateLimit, requireRecaptcha(), async (req, res, next) => {
  try {
    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 180).toLowerCase();
    const phone = clean(req.body.phone, 40);
    const address = clean(req.body.address, 400);
    const excites = clean(req.body.excites, 1000) || null;
    const wantsSlot = req.body.claimSlot === true;
    const landmark = wantsSlot ? clean(req.body.landmark, 200) : null;

    if (!name || !email || !phone || !address) {
      return res.status(400).json({ error: 'Name, email, phone, and address are all required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'That email address doesn\'t look right.' });
    }
    if (wantsSlot && !landmark) {
      return res.status(400).json({ error: 'A popular landmark near you is required to lock in a slot.' });
    }

    const { claimedSlot, alreadyShortlisted } = await prisma.$transaction(async (tx) => {
      // Lock the singleton settings row for the duration of the transaction
      // so two concurrent submissions can't both claim the last slot.
      await tx.$queryRawUnsafe(
        `SELECT id FROM "LaunchSettings" WHERE id = $1 FOR UPDATE`,
        SETTINGS_ID
      );
      const settings = await tx.launchSettings.upsert({
        where: { id: SETTINGS_ID },
        update: {},
        create: { id: SETTINGS_ID },
      });

      // Re-submitting with the same email refreshes the existing entry (and
      // marks it unread again) rather than piling up duplicates. A slot,
      // once claimed, stays claimed even if the person later resubmits via
      // the general form — and `shortlisted` is never touched here at all,
      // it's admin-only.
      // A soft-deleted registration is invisible here — resubmitting after
      // admin deleted you starts a fresh row rather than resurrecting it.
      const existing = await tx.interestRegistration.findFirst({ where: { email, deletedAt: null } });
      let claimed = existing?.claimedSlot ?? false;
      if (wantsSlot && !claimed) {
        const slotsClaimed = await tx.interestRegistration.count({
          where: { claimedSlot: true, deletedAt: null },
        });
        claimed = slotsClaimed < settings.firstTasteSlots;
      }

      if (existing) {
        await tx.interestRegistration.update({
          where: { id: existing.id },
          data: {
            name,
            phone,
            address,
            excites,
            readAt: null,
            claimedSlot: claimed,
            landmark: landmark || existing.landmark,
          },
        });
      } else {
        await tx.interestRegistration.create({
          data: { name, email, phone, address, excites, landmark, claimedSlot: claimed },
        });
      }
      return { claimedSlot: claimed, alreadyShortlisted: existing?.shortlisted ?? false };
    });

    // Someone already on the final shortlist doesn't need the generic
    // "we've received your request" receipt again — they either already got
    // the "you made the list" email, or will via the admin bulk-send.
    if (!alreadyShortlisted) {
      try {
        await sendFirstTasteConfirmationEmail({ to: email, name, claimedSlot, landmark });
      } catch (err) {
        console.error('Failed to send first-taste confirmation email:', err);
      }
    }

    // Anyone who actually claimed a first-taste slot becomes a real Customer
    // right away — not just a row on this list — so they already exist in
    // the system by the time admin gets to shortlisting/ordering for them.
    if (claimedSlot) {
      try {
        await ensureCustomerForFirstTaste({ name, phone, email, address, landmark });
      } catch (err) {
        console.error('Failed to create customer for first-taste registration:', err);
      }
    }

    res.status(201).json({ ok: true, claimedSlot, alreadyShortlisted });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin — review who registered.
// ---------------------------------------------------------------------------
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// GET /api/admin/interest/settings — current first-taste slot counts.
adminRouter.get('/settings', async (req, res, next) => {
  try {
    res.json(await getSlotStatus());
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/interest/settings — configure the total number of
// first-taste slots on offer.
adminRouter.patch('/settings', async (req, res, next) => {
  try {
    const slots = Number(req.body.firstTasteSlots);
    if (!Number.isInteger(slots) || slots < 0) {
      return res.status(400).json({ error: 'firstTasteSlots must be a whole number, 0 or greater.' });
    }
    await prisma.launchSettings.upsert({
      where: { id: SETTINGS_ID },
      update: { firstTasteSlots: slots },
      create: { id: SETTINGS_ID, firstTasteSlots: slots },
    });
    res.json(await getSlotStatus());
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/interest — all (non-deleted) registrations, newest first
adminRouter.get('/', async (req, res) => {
  const rows = await prisma.interestRegistration.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows);
});

// GET /api/admin/interest/unread-count — for the admin nav tab badge
adminRouter.get('/unread-count', async (req, res) => {
  const count = await prisma.interestRegistration.count({ where: { readAt: null, deletedAt: null } });
  res.json({ count });
});

// PATCH /api/admin/interest/read-all — mark every unread registration as read
adminRouter.patch('/read-all', async (req, res) => {
  await prisma.interestRegistration.updateMany({
    where: { readAt: null, deletedAt: null },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});

// POST /api/admin/interest/send-shortlist-emails — the "you made the final
// list" email, sent only to registrations admin has marked `shortlisted`
// that haven't been emailed yet (finalEmailSentAt is null). Safe to click
// repeatedly — already-emailed rows are skipped, and a failed send for one
// person doesn't stop the rest or get recorded as sent (so it's retried next
// time this is run).
adminRouter.post('/send-shortlist-emails', async (req, res, next) => {
  try {
    const pending = await prisma.interestRegistration.findMany({
      where: { shortlisted: true, finalEmailSentAt: null, deletedAt: null },
    });

    const results = await Promise.allSettled(
      pending.map(async (row) => {
        await sendShortlistConfirmationEmail({ to: row.email, name: row.name });
        await prisma.interestRegistration.update({
          where: { id: row.id },
          data: { finalEmailSentAt: new Date() },
        });
      })
    );

    const failed = [];
    let sent = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        sent += 1;
      } else {
        failed.push(pending[i].email);
        console.error(`Failed to send shortlist email to ${pending[i].email}:`, r.reason);
      }
    });

    res.json({ ok: true, sent, failed });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/interest/:id/create-order — pushes a shortlisted person
// into the standard ordering flow: a free "First Taste" order (menu item
// created on first use), confirmed immediately since there's nothing to pay.
// `locationId` is picked by admin rather than guessed from the free-text
// landmark/address, since it determines the delivery fee charged.
adminRouter.post('/:id/create-order', async (req, res, next) => {
  try {
    const { locationId } = req.body;
    if (!locationId) {
      return res.status(400).json({ error: 'locationId is required.' });
    }

    const registration = await prisma.interestRegistration.findUnique({ where: { id: req.params.id } });
    if (!registration || registration.deletedAt) return res.status(404).json({ error: 'Registration not found' });
    if (!registration.shortlisted) {
      return res.status(400).json({ error: 'Only shortlisted registrations can be pushed into the ordering flow.' });
    }

    const order = await createFirstTasteOrder(registration, locationId);
    res.status(201).json({ ok: true, order });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// PATCH /api/admin/interest/:id — mark a single registration read/unread,
// shortlisted, and/or claimedSlot (only the keys present in the body are
// touched). Admin can move someone to/from "First taste" by hand here —
// deliberately no cap against the configured slot total, since this is a
// manual override; GET /status's slotsClaimed count reflects the change
// immediately either way (it just counts claimedSlot: true rows).
adminRouter.patch('/:id', async (req, res) => {
  const { read, shortlisted, claimedSlot } = req.body;
  const data = {};
  if (read !== undefined) data.readAt = read === false ? null : new Date();
  if (shortlisted !== undefined) data.shortlisted = !!shortlisted;
  if (claimedSlot !== undefined) data.claimedSlot = !!claimedSlot;

  try {
    const row = await prisma.interestRegistration.update({
      where: { id: req.params.id, deletedAt: null },
      data,
    });

    // Same as the public submission path — admin manually moving someone
    // into "First taste" also registers them as a real Customer.
    if (data.claimedSlot) {
      try {
        await ensureCustomerForFirstTaste(row);
      } catch (err) {
        console.error('Failed to create customer for first-taste registration:', err);
      }
    }

    res.json(row);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Registration not found' });
    throw err;
  }
});

// DELETE /api/admin/interest/:id — soft-delete: the row stays in the DB (and
// keeps counting toward historical records) but disappears from every admin
// list/count/action above and frees up its slot if it had claimed one.
adminRouter.delete('/:id', async (req, res) => {
  try {
    await prisma.interestRegistration.update({
      where: { id: req.params.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Registration not found' });
    throw err;
  }
});

module.exports = { publicRouter, adminRouter };
