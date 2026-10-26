const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const {
  getOrderTimeline,
  listOrderTimelineHistory,
  validateOrderTimeline,
  saveOrderTimeline,
} = require('../lib/orderTimeline');

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

// GET /api/admin/order-timeline/history — every saved timeline, newest
// (current) first.
adminRouter.get('/history', async (req, res) => {
  res.json(await listOrderTimelineHistory());
});

// POST /api/admin/order-timeline — save a new current timeline, keeping the
// previous ones as history. Body: { opensOn, closesOn, deliveryStartsOn,
// deliveryEndsOn } as 'YYYY-MM-DD'.
adminRouter.post('/', async (req, res) => {
  const { data, error } = validateOrderTimeline(req.body);
  if (error) return res.status(400).json({ error });
  res.status(201).json(await saveOrderTimeline(data, { createdByName: req.admin?.name || req.admin?.email }));
});

module.exports = { publicRouter, adminRouter };
