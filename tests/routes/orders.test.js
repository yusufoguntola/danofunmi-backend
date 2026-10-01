jest.mock('../../src/db', () => ({
  order: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  location: { findUnique: jest.fn() },
  paymentReceipt: { create: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: (req, res, next) => {
    req.admin = { id: 'admin1', email: 'admin@test.com' };
    next();
  },
  optionalCustomerAuth: (req, res, next) => next(),
}));
jest.mock('../../src/middleware/security', () => ({
  orderLookupRateLimit: (req, res, next) => next(),
  requireBrowserOrigin: (req, res, next) => next(),
}));
jest.mock('../../src/lib/recaptcha', () => ({ requireRecaptcha: () => (req, res, next) => next() }));
jest.mock('../../src/lib/uploads', () => ({ uploadReceipt: { single: () => (req, res, next) => next() } }));
jest.mock('../../src/lib/orderCreation', () => ({
  createOrderRecord: jest.fn(),
  OrderValidationError: class OrderValidationError extends Error {},
}));
jest.mock('../../src/lib/orderNotifications', () => ({
  notifyOrderStatusChange: jest.fn(),
  notifyAdminOfPayment: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const { createOrderRecord, OrderValidationError } = require('../../src/lib/orderCreation');
const { notifyOrderStatusChange, notifyAdminOfPayment } = require('../../src/lib/orderNotifications');
const router = require('../../src/routes/orders');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/orders', () => {
  const VALID_BODY = {
    customerName: 'Jane',
    customerPhone: '+2348012345678',
    deliveryAddress: '1 Rd',
    locationId: 'loc1',
    items: [{ menuItemOptionId: 'opt1', quantity: 1 }],
  };

  test('400 on an invalid Nigerian phone number', async () => {
    const res = await request(buildApp()).post('/api/orders').send({ ...VALID_BODY, customerPhone: '123' });
    expect(res.status).toBe(400);
    expect(createOrderRecord).not.toHaveBeenCalled();
  });

  test('201 with order + payment details on success', async () => {
    process.env.BANK_NAME = 'Test Bank';
    createOrderRecord.mockResolvedValue({ id: 'order1', narration: 'DFM-AB12CD', total: 6000 });
    const res = await request(buildApp()).post('/api/orders').send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ bankName: 'Test Bank', amount: 6000, narration: 'DFM-AB12CD' });
    expect(createOrderRecord).toHaveBeenCalledWith(expect.objectContaining({ ...VALID_BODY, source: 'WEB' }));
  });

  test('400 on an OrderValidationError', async () => {
    createOrderRecord.mockRejectedValue(new OrderValidationError('Selected location is not available'));
    const res = await request(buildApp()).post('/api/orders').send(VALID_BODY);
    expect(res.status).toBe(400);
  });

  test('500 on an unexpected error (explicitly caught/handled here, not rethrown)', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    createOrderRecord.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).post('/api/orders').send(VALID_BODY);
    expect(res.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});

describe('GET /api/orders/:idOrNarration', () => {
  test('404 when not found', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/orders/missing');
    expect(res.status).toBe(404);
  });

  test('200 with the full order on a match by narration', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1', narration: 'DFM-AB12CD' });
    const res = await request(buildApp()).get('/api/orders/DFM-AB12CD');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'order1' });
  });

  test('matches numerically by order number too', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1' });
    await request(buildApp()).get('/api/orders/10042');
    expect(prisma.order.findFirst.mock.calls[0][0].where.OR).toContainEqual({ orderNumber: 10042 });
  });

  // This route has no try/catch of its own — relies on express-async-errors
  // (see app.js) to forward a rejected promise to the error handler.
  test('an unexpected DB error reaches the error handler via express-async-errors', async () => {
    prisma.order.findFirst.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).get('/api/orders/DFM-AB12CD');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/orders/:id/receipt', () => {
  test('404 when the order does not exist', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/orders/missing/receipt').send({});
    expect(res.status).toBe(404);
  });

  test('400 when neither a file nor sender name+bank is given', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', customer: {} });
    const res = await request(buildApp()).post('/api/orders/order1/receipt').send({});
    expect(res.status).toBe(400);
  });

  test('201 with sender name + bank, moves the order to PAYMENT_SUBMITTED, notifies admin', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', customer: { phone: '08012345678' } });
    prisma.$transaction.mockResolvedValue([{ id: 'receipt1', senderName: 'Jane', senderBank: 'GTB' }]);

    const res = await request(buildApp())
      .post('/api/orders/order1/receipt')
      .send({ senderName: 'Jane', senderBank: 'GTB' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'receipt1' });
    expect(notifyAdminOfPayment).toHaveBeenCalled();
  });
});

describe('PATCH /api/orders/:id/cancel', () => {
  test('404 when the order does not exist', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).patch('/api/orders/missing/cancel');
    expect(res.status).toBe(404);
  });

  test('400 when the order is past PENDING_PAYMENT', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', status: 'CONFIRMED' });
    const res = await request(buildApp()).patch('/api/orders/order1/cancel');
    expect(res.status).toBe(400);
  });

  test('cancels a PENDING_PAYMENT order', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', status: 'PENDING_PAYMENT' });
    prisma.order.update.mockResolvedValue({ id: 'order1', status: 'CANCELLED' });
    const res = await request(buildApp()).patch('/api/orders/order1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });
});

describe('GET /api/admin/orders (mounted at /admin/all)', () => {
  test('returns all orders with no filter', async () => {
    prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);
    const res = await request(buildApp()).get('/api/orders/admin/all');
    expect(res.status).toBe(200);
    expect(prisma.order.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  test('filters by status when given', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    await request(buildApp()).get('/api/orders/admin/all?status=DELIVERED');
    expect(prisma.order.findMany.mock.calls[0][0].where).toEqual({ status: 'DELIVERED' });
  });
});

describe('PATCH /api/admin/orders/:id/status', () => {
  test('400 on an invalid status', async () => {
    const res = await request(buildApp()).patch('/api/orders/admin/order1/status').send({ status: 'BOGUS' });
    expect(res.status).toBe(400);
  });

  test('updates status, stamps the right timestamp field, and notifies', async () => {
    prisma.order.update.mockResolvedValue({ id: 'order1', status: 'PACKED' });
    const res = await request(buildApp()).patch('/api/orders/admin/order1/status').send({ status: 'PACKED' });

    expect(res.status).toBe(200);
    const updateCall = prisma.order.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('PACKED');
    expect(updateCall.data.packedAt).toBeInstanceOf(Date);
    expect(notifyOrderStatusChange).toHaveBeenCalled();
  });

  test('accepts and trims an optional riderContact', async () => {
    prisma.order.update.mockResolvedValue({ id: 'order1', status: 'OUT_FOR_DELIVERY' });
    await request(buildApp())
      .patch('/api/orders/admin/order1/status')
      .send({ status: 'OUT_FOR_DELIVERY', riderContact: '  08099999999  ' });
    expect(prisma.order.update.mock.calls[0][0].data.riderContact).toBe('08099999999');
  });

  test('a blank riderContact clears it to null', async () => {
    prisma.order.update.mockResolvedValue({ id: 'order1', status: 'OUT_FOR_DELIVERY' });
    await request(buildApp()).patch('/api/orders/admin/order1/status').send({ status: 'OUT_FOR_DELIVERY', riderContact: '  ' });
    expect(prisma.order.update.mock.calls[0][0].data.riderContact).toBeNull();
  });

  test('omitting riderContact entirely leaves it untouched (not in the update data)', async () => {
    prisma.order.update.mockResolvedValue({ id: 'order1', status: 'CONFIRMED' });
    await request(buildApp()).patch('/api/orders/admin/order1/status').send({ status: 'CONFIRMED' });
    expect('riderContact' in prisma.order.update.mock.calls[0][0].data).toBe(false);
  });
});

describe('PATCH /api/admin/orders/:id/location', () => {
  test('400 when locationId is missing', async () => {
    const res = await request(buildApp()).patch('/api/orders/admin/order1/location').send({});
    expect(res.status).toBe(400);
  });

  test('404 when the order does not exist', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).patch('/api/orders/admin/order1/location').send({ locationId: 'loc1' });
    expect(res.status).toBe(404);
  });

  test('400 when the order is already DELIVERED/CANCELLED', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', status: 'DELIVERED', subtotal: 20000 });
    const res = await request(buildApp()).patch('/api/orders/admin/order1/location').send({ locationId: 'loc1' });
    expect(res.status).toBe(400);
  });

  test('400 when the new location is missing/inactive', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', status: 'CONFIRMED', subtotal: 20000 });
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: false });
    const res = await request(buildApp()).patch('/api/orders/admin/order1/location').send({ locationId: 'loc1' });
    expect(res.status).toBe(400);
  });

  test('recomputes logisticsFee/total from the new location', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', status: 'CONFIRMED', subtotal: 20000 });
    prisma.location.findUnique.mockResolvedValue({ id: 'loc2', active: true, logisticsFee: 2000 });
    prisma.order.update.mockResolvedValue({ id: 'order1', locationId: 'loc2', logisticsFee: 2000, total: 22000 });

    const res = await request(buildApp()).patch('/api/orders/admin/order1/location').send({ locationId: 'loc2' });

    expect(res.status).toBe(200);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { locationId: 'loc2', logisticsFee: 2000, total: 22000 } })
    );
  });

  test('a DB error reaches the error handler via next(err)', async () => {
    prisma.order.findUnique.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).patch('/api/orders/admin/order1/location').send({ locationId: 'loc1' });
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/admin/orders/:id/receipts/:receiptId', () => {
  test('400 on an invalid status', async () => {
    const res = await request(buildApp()).patch('/api/orders/admin/order1/receipts/r1').send({ status: 'BOGUS' });
    expect(res.status).toBe(400);
  });

  test('confirms a receipt, moves the order to CONFIRMED, and notifies with "Payment confirmed!"', async () => {
    prisma.paymentReceipt.update.mockResolvedValue({ id: 'r1', status: 'CONFIRMED' });
    prisma.order.update.mockResolvedValue({});
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', status: 'CONFIRMED' });

    const res = await request(buildApp()).patch('/api/orders/admin/order1/receipts/r1').send({ status: 'CONFIRMED' });

    expect(res.status).toBe(200);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CONFIRMED', statusUpdatedAt: expect.any(Date) } })
    );
    expect(notifyOrderStatusChange).toHaveBeenCalledWith(expect.anything(), { body: 'Payment confirmed!' });
  });

  test('rejecting a receipt does not touch the order status, but still notifies', async () => {
    prisma.paymentReceipt.update.mockResolvedValue({ id: 'r1', status: 'REJECTED' });
    prisma.order.findUnique.mockResolvedValue({ id: 'order1', status: 'PAYMENT_SUBMITTED' });

    const res = await request(buildApp()).patch('/api/orders/admin/order1/receipts/r1').send({ status: 'REJECTED' });

    expect(res.status).toBe(200);
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(notifyOrderStatusChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.stringContaining("couldn't be verified") })
    );
  });

  test('skips notification entirely if the order is somehow gone by the time it is re-fetched', async () => {
    prisma.paymentReceipt.update.mockResolvedValue({ id: 'r1', status: 'CONFIRMED' });
    prisma.order.update.mockResolvedValue({});
    prisma.order.findUnique.mockResolvedValue(null);

    const res = await request(buildApp()).patch('/api/orders/admin/order1/receipts/r1').send({ status: 'CONFIRMED' });
    expect(res.status).toBe(200);
    expect(notifyOrderStatusChange).not.toHaveBeenCalled();
  });
});
