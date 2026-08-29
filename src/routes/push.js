const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { broadcastPush } = require('../lib/push');

const router = express.Router();

// GET /api/push/vapid-public-key — public, so the frontend never needs its own copy
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// POST /api/push/subscribe — public, upsert by endpoint
router.post('/subscribe', async (req, res) => {
  const { endpoint, keys, customerPhone } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint and keys.p256dh/keys.auth are required' });
  }
  const sub = await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { p256dh: keys.p256dh, auth: keys.auth, customerPhone: customerPhone || null },
    create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, customerPhone: customerPhone || null },
  });
  res.status(201).json({ id: sub.id });
});

// POST /api/push/unsubscribe — public
router.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
  res.status(204).send();
});

// GET /api/push/admin/subscriptions — admin, just for the subscriber count
router.get('/admin/subscriptions', requireAdmin, async (req, res) => {
  const subscriptions = await prisma.pushSubscription.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(subscriptions);
});

// POST /api/push/admin/broadcast — admin, send to everyone subscribed
router.post('/admin/broadcast', requireAdmin, async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
  const result = await broadcastPush({ title, body, url: '/' });
  res.json(result);
});

module.exports = router;
