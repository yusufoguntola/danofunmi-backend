const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { authRateLimit, requireBrowserOrigin } = require('../middleware/security');
const { requireRecaptcha } = require('../lib/recaptcha');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Public — the coming-soon "I'm interested" form.
// ---------------------------------------------------------------------------
const publicRouter = express.Router();
publicRouter.use(requireBrowserOrigin);

// POST /api/interest — register interest to be contacted when ordering opens.
publicRouter.post('/', authRateLimit, requireRecaptcha(), async (req, res, next) => {
  try {
    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 180).toLowerCase();
    const phone = clean(req.body.phone, 40);
    const address = clean(req.body.address, 400);
    const excites = clean(req.body.excites, 1000) || null;

    if (!name || !email || !phone || !address) {
      return res.status(400).json({ error: 'Name, email, phone, and address are all required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'That email address doesn\'t look right.' });
    }

    // Re-submitting with the same email refreshes the existing entry (and
    // marks it unread again) rather than piling up duplicates.
    const existing = await prisma.interestRegistration.findFirst({ where: { email } });
    if (existing) {
      await prisma.interestRegistration.update({
        where: { id: existing.id },
        data: { name, phone, address, excites, readAt: null },
      });
    } else {
      await prisma.interestRegistration.create({ data: { name, email, phone, address, excites } });
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin — review who registered.
// ---------------------------------------------------------------------------
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// GET /api/admin/interest — all registrations, newest first
adminRouter.get('/', async (req, res) => {
  const rows = await prisma.interestRegistration.findMany({ orderBy: { createdAt: 'desc' } });
  console.log(rows);
  res.json(rows);
});

// GET /api/admin/interest/unread-count — for the admin nav tab badge
adminRouter.get('/unread-count', async (req, res) => {
  const count = await prisma.interestRegistration.count({ where: { readAt: null } });
  res.json({ count });
});

// PATCH /api/admin/interest/read-all — mark every unread registration as read
adminRouter.patch('/read-all', async (req, res) => {
  await prisma.interestRegistration.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

// PATCH /api/admin/interest/:id — mark a single registration read/unread
adminRouter.patch('/:id', async (req, res) => {
  const { read } = req.body;
  try {
    const row = await prisma.interestRegistration.update({
      where: { id: req.params.id },
      data: { readAt: read === false ? null : new Date() },
    });
    res.json(row);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Registration not found' });
    throw err;
  }
});

module.exports = { publicRouter, adminRouter };
