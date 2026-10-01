jest.mock('../../src/db', () => ({ order: { findMany: jest.fn() }, costEntry: { findMany: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const router = require('../../src/routes/reports');

function buildApp() {
  const app = express();
  app.use('/api/admin/reports', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/admin/reports/pnl', () => {
  test('computes revenue/foodRevenue/logisticsRevenue/totalCost/netProfit and cost-by-category', async () => {
    prisma.order.findMany.mockResolvedValue([
      { subtotal: 20000, logisticsFee: 1000, total: 21000 },
      { subtotal: 10000, logisticsFee: 500, total: 10500 },
    ]);
    prisma.costEntry.findMany.mockResolvedValue([
      { amount: 5000, category: 'Ingredients' },
      { amount: 2000, category: 'Ingredients' },
      { amount: 1000, category: 'Fuel' },
    ]);

    const res = await request(buildApp()).get('/api/admin/reports/pnl');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      range: { from: null, to: null },
      ordersCount: 2,
      revenue: 31500,
      foodRevenue: 30000,
      logisticsRevenue: 1500,
      totalCost: 8000,
      costByCategory: { Ingredients: 7000, Fuel: 1000 },
      netProfit: 23500,
    });
  });

  test('only counts paid-onward statuses as revenue', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.costEntry.findMany.mockResolvedValue([]);
    await request(buildApp()).get('/api/admin/reports/pnl');

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED'] } },
      })
    );
  });

  test('applies a from/to date range filter to both orders and costs', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.costEntry.findMany.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/admin/reports/pnl?from=2026-01-01&to=2026-01-31');

    expect(res.body.range).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    const orderWhere = prisma.order.findMany.mock.calls[0][0].where;
    expect(orderWhere.createdAt.gte).toEqual(new Date('2026-01-01'));
    expect(orderWhere.createdAt.lte).toEqual(new Date('2026-01-31'));
    const costWhere = prisma.costEntry.findMany.mock.calls[0][0].where;
    expect(costWhere.incurredOn.gte).toEqual(new Date('2026-01-01'));
  });

  test('handles an empty result set without dividing by zero or crashing', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    prisma.costEntry.findMany.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/admin/reports/pnl');
    expect(res.body).toMatchObject({ ordersCount: 0, revenue: 0, totalCost: 0, netProfit: 0, costByCategory: {} });
  });

  // This route has no try/catch of its own — relies on express-async-errors
  // (see app.js) to forward a rejected promise to the error handler.
  test('an unexpected DB error reaches the error handler via express-async-errors', async () => {
    prisma.order.findMany.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).get('/api/admin/reports/pnl');
    expect(res.status).toBe(500);
  });
});
