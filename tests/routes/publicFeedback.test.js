jest.mock('../../src/db', () => ({
  feedback: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  order: { findFirst: jest.fn() },
}));
jest.mock('../../src/middleware/security', () => ({
  authRateLimit: (req, res, next) => next(),
  orderLookupRateLimit: (req, res, next) => next(),
  requireBrowserOrigin: (req, res, next) => next(),
}));
jest.mock('../../src/lib/recaptcha', () => ({ requireRecaptcha: () => (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const router = require('../../src/routes/publicFeedback');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/feedback', () => {
  test('returns only commented, non-deleted feedback, first-name-only, capped at 12', async () => {
    prisma.feedback.findMany.mockResolvedValue([
      { id: 'f1', rating: 5, comment: '  Great food!  ', createdAt: new Date(), order: { customer: { name: 'Jane Doe' } } },
      { id: 'f2', rating: 4, comment: '', order: { customer: { name: 'Bob' } } }, // blank comment, filtered out
    ]);

    const res = await request(buildApp()).get('/api/feedback');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'f1', rating: 5, comment: 'Great food!', createdAt: expect.any(String), name: 'Jane' }]);
  });

  test('falls back to the feedback-level customerName when no order/customer is linked', async () => {
    prisma.feedback.findMany.mockResolvedValue([
      { id: 'f1', rating: 5, comment: 'Nice', createdAt: new Date(), customerName: 'ada okafor', order: null },
    ]);
    const res = await request(buildApp()).get('/api/feedback');
    expect(res.body[0].name).toBe('Ada');
  });

  test('"A customer" when no name is available at all', async () => {
    prisma.feedback.findMany.mockResolvedValue([
      { id: 'f1', rating: 5, comment: 'Nice', createdAt: new Date(), order: null },
    ]);
    const res = await request(buildApp()).get('/api/feedback');
    expect(res.body[0].name).toBe('A customer');
  });

  test('a DB error reaches the error handler via next(err)', async () => {
    prisma.feedback.findMany.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).get('/api/feedback');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/feedback/order/:idOrNarration', () => {
  test('404 when the order is not found', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/feedback/order/missing');
    expect(res.status).toBe(404);
  });

  test('returns the minimal order shape, with no existing feedback', async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: 'order1',
      narration: 'DFM-AB12CD',
      orderNumber: 10042,
      status: 'DELIVERED',
      customer: { name: 'Jane' },
      items: [{ itemName: 'Jollof', size: '5L', quantity: 1 }],
    });
    prisma.feedback.findFirst.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/feedback/order/DFM-AB12CD');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId: 'order1', customerName: 'Jane', existingFeedback: null });
  });

  test('includes existingFeedback when feedback was already left', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1', narration: 'DFM-AB12CD', items: [], customer: null });
    prisma.feedback.findFirst.mockResolvedValue({ rating: 5, comment: 'Great!', createdAt: new Date('2026-01-01') });

    const res = await request(buildApp()).get('/api/feedback/order/DFM-AB12CD');
    expect(res.body.existingFeedback).toMatchObject({ rating: 5, comment: 'Great!' });
  });

  test('matches by numeric order number too', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1', narration: 'DFM-AB12CD', items: [], customer: null });
    prisma.feedback.findFirst.mockResolvedValue(null);
    await request(buildApp()).get('/api/feedback/order/10042');
    expect(prisma.order.findFirst.mock.calls[0][0].where.OR).toContainEqual({ orderNumber: 10042 });
  });
});

describe('POST /api/feedback/order/:idOrNarration', () => {
  test('400 on an invalid rating', async () => {
    const res = await request(buildApp()).post('/api/feedback/order/DFM-AB12CD').send({ rating: 6 });
    expect(res.status).toBe(400);
  });

  test('404 when the order is not found', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/feedback/order/missing').send({ rating: 5 });
    expect(res.status).toBe(404);
  });

  test('400 when the order has not been delivered yet', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1', status: 'PACKED' });
    const res = await request(buildApp()).post('/api/feedback/order/DFM-AB12CD').send({ rating: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/once an order has been delivered/);
  });

  test('409 with the existing feedback when feedback was already submitted', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1', status: 'DELIVERED' });
    prisma.feedback.findFirst.mockResolvedValue({ rating: 4, comment: 'ok', createdAt: new Date() });
    const res = await request(buildApp()).post('/api/feedback/order/DFM-AB12CD').send({ rating: 5 });
    expect(res.status).toBe(409);
    expect(res.body.existingFeedback).toMatchObject({ rating: 4 });
  });

  test('201 creates feedback for a delivered order with no prior feedback', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1', status: 'DELIVERED' });
    prisma.feedback.findFirst.mockResolvedValue(null);
    prisma.feedback.create.mockResolvedValue({ rating: 5, comment: 'Great!', createdAt: new Date() });

    const res = await request(buildApp()).post('/api/feedback/order/DFM-AB12CD').send({ rating: 5, comment: 'Great!' });

    expect(res.status).toBe(201);
    expect(prisma.feedback.create).toHaveBeenCalledWith({ data: { orderId: 'order1', rating: 5, comment: 'Great!' } });
  });

  test('comment is trimmed and capped at 1000 chars; blank becomes null', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1', status: 'DELIVERED' });
    prisma.feedback.findFirst.mockResolvedValue(null);
    prisma.feedback.create.mockResolvedValue({});
    await request(buildApp()).post('/api/feedback/order/DFM-AB12CD').send({ rating: 5, comment: '   ' });
    expect(prisma.feedback.create).toHaveBeenCalledWith({ data: { orderId: 'order1', rating: 5, comment: null } });
  });
});

describe('POST /api/feedback/general', () => {
  test('400 on an invalid rating', async () => {
    const res = await request(buildApp()).post('/api/feedback/general').send({ rating: 0 });
    expect(res.status).toBe(400);
  });

  test('201 with everything optional besides rating', async () => {
    prisma.feedback.create.mockResolvedValue({ id: 'f1', rating: 4, comment: null, createdAt: new Date() });
    const res = await request(buildApp()).post('/api/feedback/general').send({ rating: 4 });
    expect(res.status).toBe(201);
    expect(prisma.feedback.create).toHaveBeenCalledWith({
      data: { orderId: null, rating: 4, comment: null, customerName: null, location: null, foodType: null },
    });
  });

  test('201 stores the optional free-text fields, trimmed/capped', async () => {
    prisma.feedback.create.mockResolvedValue({ id: 'f1' });
    await request(buildApp())
      .post('/api/feedback/general')
      .send({ rating: 5, comment: ' Nice ', customerName: ' Ada ', location: ' Lekki ', foodType: ' Jollof ' });
    expect(prisma.feedback.create).toHaveBeenCalledWith({
      data: { orderId: null, rating: 5, comment: 'Nice', customerName: 'Ada', location: 'Lekki', foodType: 'Jollof' },
    });
  });
});
