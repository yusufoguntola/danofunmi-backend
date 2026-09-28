const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { broadcastPush } = require('../lib/push');
const { sendBroadcastEmail } = require('../lib/email');

const router = express.Router();
router.use(requireAdmin);

// SMS and WhatsApp aren't wired up yet (per the coming-soon channel picker in
// AdminNotifications.jsx) — filtered out here too, so a stale/tampered
// client can't ask for a channel that doesn't exist.
const ACTIVE_CHANNELS = ['in_app', 'email'];

// POST /api/admin/broadcast — send one announcement through any combination
// of active channels at once (new menu, monthly ordering reminder, ...).
// Order-status notifications are separate and automatic — see
// lib/orderNotifications.js — and don't go through here.
router.post('/', async (req, res, next) => {
  try {
    const { title, body } = req.body;
    const channels = Array.isArray(req.body.channels)
      ? req.body.channels.filter((c) => ACTIVE_CHANNELS.includes(c))
      : [];

    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
    if (channels.length === 0) {
      return res.status(400).json({ error: 'Select at least one channel to send through.' });
    }

    const results = {};

    if (channels.includes('in_app')) {
      results.in_app = await broadcastPush({ title, body, url: '/' });
    }

    if (channels.includes('email')) {
      const customers = await prisma.customer.findMany({ where: { email: { not: null } } });
      const settled = await Promise.allSettled(
        customers.map((c) => sendBroadcastEmail({ to: c.email, name: c.name, title, body }))
      );
      const failed = [];
      let sent = 0;
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          sent += 1;
        } else {
          failed.push(customers[i].email);
          console.error(`Broadcast email failed for ${customers[i].email}:`, r.reason);
        }
      });
      results.email = { sent, failed };
    }

    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
