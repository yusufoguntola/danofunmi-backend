jest.mock('../../src/db', () => ({
  order: { findUnique: jest.fn() },
  customer: { findUnique: jest.fn() },
  whatsappMessageLog: { create: jest.fn() },
  $transaction: jest.fn(),
  paymentReceipt: { create: jest.fn() },
}));
jest.mock('../../src/middleware/auth', () => ({ requireInternalKey: (req, res, next) => next() }));
jest.mock('../../src/lib/orderCreation', () => ({
  createOrderRecord: jest.fn(),
  OrderValidationError: class OrderValidationError extends Error {},
}));
// uploadReceipt.single() is multer middleware — swap for a no-op that never
// parses a real multipart body, since these tests only exercise the JSON
// paths (createOrderRecord, by-phone lookup, message logging).
jest.mock('../../src/lib/uploads', () => ({
  uploadReceipt: { single: () => (req, res, next) => next() },
}));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const { createOrderRecord, OrderValidationError } = require('../../src/lib/orderCreation');
const router = require('../../src/routes/internal');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', router);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/internal/orders', () => {
  test('201 with order + payment details on success', async () => {
    process.env.BANK_NAME = 'Test Bank';
    createOrderRecord.mockResolvedValue({ id: 'order1', narration: 'DFM-AB12CD', total: 6000 });

    const res = await request(buildApp()).post('/api/internal/orders').send({ customerName: 'Jane' });

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ id: 'order1' });
    expect(res.body.payment).toMatchObject({ bankName: 'Test Bank', amount: 6000, narration: 'DFM-AB12CD' });
    expect(createOrderRecord).toHaveBeenCalledWith(expect.objectContaining({ customerName: 'Jane', source: 'WHATSAPP' }));
  });

  test('400 on an OrderValidationError', async () => {
    createOrderRecord.mockRejectedValue(new OrderValidationError('Selected location is not available'));
    const res = await request(buildApp()).post('/api/internal/orders').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Selected location is not available');
  });

  test('500 on an unexpected error (this handler does explicitly catch and respond)', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    createOrderRecord.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).post('/api/internal/orders').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not create order');
    consoleErrorSpy.mockRestore();
  });
});

describe('POST /api/internal/orders/:id/receipt', () => {
  test('404 when the order does not exist', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/internal/orders/missing/receipt').send({});
    expect(res.status).toBe(404);
  });

  test('400 when no file was attached (the mocked multer never sets req.file)', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order1' });
    const res = await request(buildApp()).post('/api/internal/orders/order1/receipt').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/receipt image is required/);
  });
});

describe('GET /api/internal/orders/by-phone/:phone', () => {
  test('returns [] when no customer exists for that phone', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/internal/orders/by-phone/08012345678');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns the last 10 orders for the matched customer', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1' });
    prisma.order.findMany = jest.fn().mockResolvedValue([{ id: 'o1' }]);
    const res = await request(buildApp()).get('/api/internal/orders/by-phone/08012345678');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'o1' }]);
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { customerId: 'cust1' }, take: 10 }));
  });
});

describe('POST /api/internal/messages', () => {
  test('400 when fromPhone or direction is missing', async () => {
    const res = await request(buildApp()).post('/api/internal/messages').send({ fromPhone: '08012345678' });
    expect(res.status).toBe(400);
  });

  test('201 logs the message', async () => {
    prisma.whatsappMessageLog.create.mockResolvedValue({ id: 'm1' });
    const res = await request(buildApp())
      .post('/api/internal/messages')
      .send({ fromPhone: '08012345678', direction: 'inbound', body: 'Hi' });
    expect(res.status).toBe(201);
    expect(prisma.whatsappMessageLog.create).toHaveBeenCalledWith({
      data: { fromPhone: '08012345678', direction: 'inbound', body: 'Hi', mediaPath: undefined },
    });
  });
});
