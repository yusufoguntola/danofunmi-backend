jest.mock('../../src/db', () => ({ extraneousRequest: { findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));
jest.mock('../../src/lib/requestItemSuggester', () => ({
  suggestItemsFromMessage: jest.fn(),
  ChatNotConfiguredError: class ChatNotConfiguredError extends Error {},
}));
jest.mock('../../src/lib/orderCreation', () => ({
  createAdminCustomOrder: jest.fn(),
  OrderValidationError: class OrderValidationError extends Error {},
}));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const { suggestItemsFromMessage, ChatNotConfiguredError } = require('../../src/lib/requestItemSuggester');
const { createAdminCustomOrder, OrderValidationError } = require('../../src/lib/orderCreation');
const router = require('../../src/routes/requests');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/requests', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/admin/requests', () => {
  test('returns non-deleted requests newest first', async () => {
    prisma.extraneousRequest.findMany.mockResolvedValue([{ id: 'r1' }]);
    const res = await request(buildApp()).get('/api/admin/requests');
    expect(res.status).toBe(200);
    expect(prisma.extraneousRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
  });
});

describe('GET /api/admin/requests/unread-count', () => {
  test('counts unread, non-deleted requests', async () => {
    prisma.extraneousRequest.count.mockResolvedValue(3);
    const res = await request(buildApp()).get('/api/admin/requests/unread-count');
    expect(res.body).toEqual({ count: 3 });
    expect(prisma.extraneousRequest.count).toHaveBeenCalledWith({ where: { readAt: null, deletedAt: null } });
  });
});

describe('PATCH /api/admin/requests/read-all', () => {
  test('marks every unread request read', async () => {
    prisma.extraneousRequest.updateMany.mockResolvedValue({ count: 2 });
    const res = await request(buildApp()).patch('/api/admin/requests/read-all');
    expect(res.body).toEqual({ ok: true });
  });
});

describe('PATCH /api/admin/requests/:id', () => {
  test('marks a single request read by default', async () => {
    prisma.extraneousRequest.update.mockResolvedValue({ id: 'r1', readAt: new Date() });
    const res = await request(buildApp()).patch('/api/admin/requests/r1').send({});
    expect(res.status).toBe(200);
    expect(prisma.extraneousRequest.update.mock.calls[0][0].data.readAt).toBeInstanceOf(Date);
  });

  test('marks unread when read:false is explicit', async () => {
    prisma.extraneousRequest.update.mockResolvedValue({ id: 'r1', readAt: null });
    await request(buildApp()).patch('/api/admin/requests/r1').send({ read: false });
    expect(prisma.extraneousRequest.update.mock.calls[0][0].data.readAt).toBeNull();
  });

  test('404s when the request does not exist', async () => {
    prisma.extraneousRequest.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).patch('/api/admin/requests/missing').send({});
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/requests/:id/suggest-items', () => {
  test('404s when the request does not exist', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/admin/requests/missing/suggest-items');
    expect(res.status).toBe(404);
  });

  test('returns suggested items on success', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue({ id: 'r1', message: '2 pots of jollof' });
    suggestItemsFromMessage.mockResolvedValue([{ itemName: 'Jollof', size: '5L', quantity: 2, unitPrice: 20000, matched: true }]);

    const res = await request(buildApp()).post('/api/admin/requests/r1/suggest-items');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(suggestItemsFromMessage).toHaveBeenCalledWith('2 pots of jollof');
  });

  test('503 when the AI suggester is not configured', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue({ id: 'r1', message: 'x' });
    suggestItemsFromMessage.mockRejectedValue(new ChatNotConfiguredError('no key'));

    const res = await request(buildApp()).post('/api/admin/requests/r1/suggest-items');
    expect(res.status).toBe(503);
  });

  test('any other error reaches the error handler via express-async-errors', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue({ id: 'r1', message: 'x' });
    suggestItemsFromMessage.mockRejectedValue(new Error('model crashed'));
    const res = await request(buildApp()).post('/api/admin/requests/r1/suggest-items');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/requests/:id/create-order', () => {
  test('404s when the request does not exist', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/admin/requests/missing/create-order').send({});
    expect(res.status).toBe(404);
  });

  test('400s when the request already has an order', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue({ id: 'r1', orderId: 'order1' });
    const res = await request(buildApp()).post('/api/admin/requests/r1/create-order').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been created/);
  });

  test('201 creates the order and links it back to the request', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue({ id: 'r1', orderId: null, source: 'WEB_CHAT' });
    createAdminCustomOrder.mockResolvedValue({ id: 'order1', narration: 'DFM-AB12CD' });
    prisma.extraneousRequest.update.mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/admin/requests/r1/create-order')
      .send({ customerName: 'Jane', customerPhone: '08012345678', deliveryAddress: 'Addr', locationId: 'loc1', items: [] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'order1' });
    expect(prisma.extraneousRequest.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { orderId: 'order1' } });
    expect(createAdminCustomOrder).toHaveBeenCalledWith(expect.objectContaining({ source: 'WEB_CHAT' }));
  });

  test('400 on an OrderValidationError from createAdminCustomOrder', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue({ id: 'r1', orderId: null });
    createAdminCustomOrder.mockRejectedValue(new OrderValidationError('At least one order item is required'));

    const res = await request(buildApp()).post('/api/admin/requests/r1/create-order').send({});
    expect(res.status).toBe(400);
  });

  test('any other error reaches the error handler via express-async-errors', async () => {
    prisma.extraneousRequest.findUnique.mockResolvedValue({ id: 'r1', orderId: null });
    createAdminCustomOrder.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).post('/api/admin/requests/r1/create-order').send({});
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/admin/requests/:id', () => {
  test('soft-deletes', async () => {
    prisma.extraneousRequest.update.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/admin/requests/r1');
    expect(res.status).toBe(200);
    expect(prisma.extraneousRequest.update).toHaveBeenCalledWith({
      where: { id: 'r1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  test('404s when not found', async () => {
    prisma.extraneousRequest.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).delete('/api/admin/requests/missing');
    expect(res.status).toBe(404);
  });

  test('a non-P2025 error reaches the error handler via express-async-errors', async () => {
    prisma.extraneousRequest.update.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).delete('/api/admin/requests/r1');
    expect(res.status).toBe(500);
  });
});
