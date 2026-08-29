const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(requireAdmin);

const REVENUE_STATUSES = ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED'];

function dateRangeFilter(from, to) {
  if (!from && !to) return undefined;
  const range = {};
  if (from) range.gte = new Date(from);
  if (to) range.lte = new Date(to);
  return range;
}

// GET /api/admin/reports/pnl?from=&to=
// Revenue = paid orders (payment confirmed onward) in range. Cost = manually
// entered cost ledger in range. This is the "revenue vs cost at any point" view.
router.get('/pnl', async (req, res) => {
  const { from, to } = req.query;
  const createdAt = dateRangeFilter(from, to);
  const incurredOn = dateRangeFilter(from, to);

  const [orders, costs] = await Promise.all([
    prisma.order.findMany({
      where: { status: { in: REVENUE_STATUSES }, ...(createdAt ? { createdAt } : {}) },
      select: { subtotal: true, logisticsFee: true, total: true },
    }),
    prisma.costEntry.findMany({
      where: incurredOn ? { incurredOn } : undefined,
      select: { amount: true, category: true },
    }),
  ]);

  const revenue = orders.reduce((sum, o) => sum + Number(o.total), 0);
  const foodRevenue = orders.reduce((sum, o) => sum + Number(o.subtotal), 0);
  const logisticsRevenue = orders.reduce((sum, o) => sum + Number(o.logisticsFee), 0);
  const totalCost = costs.reduce((sum, c) => sum + Number(c.amount), 0);

  const costByCategory = {};
  for (const c of costs) {
    costByCategory[c.category] = (costByCategory[c.category] || 0) + Number(c.amount);
  }

  res.json({
    range: { from: from || null, to: to || null },
    ordersCount: orders.length,
    revenue,
    foodRevenue,
    logisticsRevenue,
    totalCost,
    costByCategory,
    netProfit: revenue - totalCost,
  });
});

module.exports = router;
