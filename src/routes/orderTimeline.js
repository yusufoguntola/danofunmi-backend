const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { getOrderTimeline, validateOrderTimeline, saveOrderTimeline } = require('../lib/orderTimeline');

// ---------------------------------------------------------------------------
// Public — read by the site's order-window flyer.
// ---------------------------------------------------------------------------
const publicRouter = express.Router();

// GET /api/order-timeline — the current ordering timeline, or null if unset.
publicRouter.get('/', async (req, res) => {
  res.json(await getOrderTimeline());
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// GET /api/admin/order-timeline
adminRouter.get('/', async (req, res) => {
  res.json(await getOrderTimeline());
});

// PUT /api/admin/order-timeline — replace the timeline. Body:
// { opensOn, closesOn, deliveryStartsOn, deliveryEndsOn } as 'YYYY-MM-DD'.
adminRouter.put('/', async (req, res) => {
  const { data, error } = validateOrderTimeline(req.body);
  if (error) return res.status(400).json({ error });
  res.json(await saveOrderTimeline(data));
});

module.exports = { publicRouter, adminRouter };
