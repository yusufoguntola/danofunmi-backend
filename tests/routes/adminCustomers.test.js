jest.mock('../../src/db', () => ({
  customer: { findMany: jest.fn(), findUnique: jest.fn() },
  order: { findMany: jest.fn() },
  feedback: { findMany: jest.fn() },
  extraneousRequest: { findMany: jest.fn() },
  whatsappMessageLog: { findMany: jest.fn() },
}));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const router = require('../../src/routes/adminCustomers');

function buildApp() {
  const app = express();
  app.use('/api/admin/customers', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/admin/customers', () => {
  test('summarizes order count and total spend per customer, omitting the raw orders array', async () => {
    prisma.customer.findMany.mockResolvedValue([
      { id: 'c1', name: 'Ada', orders: [{ total: 10000 }, { total: 5000 }] },
      { id: 'c2', name: 'Bayo', orders: [] },
    ]);

    const res = await request(buildApp()).get('/api/admin/customers');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 'c1', name: 'Ada', orderCount: 2, totalSpent: 15000 },
      { id: 'c2', name: 'Bayo', orderCount: 0, totalSpent: 0 },
    ]);
  });

  // This route has no try/catch of its own — relies on express-async-errors
  // (see app.js) to forward a rejected promise to the error handler.
  test('an unexpected DB error reaches the error handler via express-async-errors', async () => {
    prisma.customer.findMany.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).get('/api/admin/customers');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/admin/customers/:id', () => {
  test('404s when the customer does not exist', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/admin/customers/missing');
    expect(res.status).toBe(404);
  });

  test('returns orders, feedback, requests, and WhatsApp messages (matched by phone)', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'c1', phone: '08012345678' });
    prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
    prisma.feedback.findMany.mockResolvedValue([{ id: 'f1' }]);
    prisma.extraneousRequest.findMany.mockResolvedValue([{ id: 'r1' }]);
    prisma.whatsappMessageLog.findMany.mockResolvedValue([{ id: 'w1' }]);

    const res = await request(buildApp()).get('/api/admin/customers/c1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customer: { id: 'c1', phone: '08012345678' },
      orders: [{ id: 'o1' }],
      feedback: [{ id: 'f1' }],
      requests: [{ id: 'r1' }],
      whatsappMessages: [{ id: 'w1' }],
    });
    expect(prisma.whatsappMessageLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fromPhone: '08012345678' } })
    );
  });

  test('skips the WhatsApp lookup entirely when the customer has no phone on file', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'c1', phone: null });
    prisma.order.findMany.mockResolvedValue([]);
    prisma.feedback.findMany.mockResolvedValue([]);
    prisma.extraneousRequest.findMany.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/admin/customers/c1');

    expect(res.body.whatsappMessages).toEqual([]);
    expect(prisma.whatsappMessageLog.findMany).not.toHaveBeenCalled();
  });

  test('only non-deleted feedback/requests are included', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'c1', phone: null });
    prisma.order.findMany.mockResolvedValue([]);
    prisma.feedback.findMany.mockResolvedValue([]);
    prisma.extraneousRequest.findMany.mockResolvedValue([]);

    await request(buildApp()).get('/api/admin/customers/c1');

    expect(prisma.feedback.findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: null });
    expect(prisma.extraneousRequest.findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: null });
  });
});
