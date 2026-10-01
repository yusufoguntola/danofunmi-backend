jest.mock('../../src/db', () => ({
  launchSettings: { upsert: jest.fn() },
  interestRegistration: {
    count: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
}));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));
jest.mock('../../src/middleware/security', () => ({
  authRateLimit: (req, res, next) => next(),
  requireBrowserOrigin: (req, res, next) => next(),
}));
jest.mock('../../src/lib/recaptcha', () => ({ requireRecaptcha: () => (req, res, next) => next() }));
jest.mock('../../src/lib/email', () => ({
  sendFirstTasteConfirmationEmail: jest.fn().mockResolvedValue(),
  sendShortlistConfirmationEmail: jest.fn().mockResolvedValue(),
}));
jest.mock('../../src/lib/firstTaste', () => ({
  createFirstTasteOrder: jest.fn(),
  ensureCustomerForFirstTaste: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/lib/orderCreation', () => ({ OrderValidationError: class OrderValidationError extends Error {} }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const { sendFirstTasteConfirmationEmail, sendShortlistConfirmationEmail } = require('../../src/lib/email');
const { createFirstTasteOrder, ensureCustomerForFirstTaste } = require('../../src/lib/firstTaste');
const { OrderValidationError } = require('../../src/lib/orderCreation');
const { publicRouter, adminRouter } = require('../../src/routes/interest');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/interest', publicRouter);
  app.use('/api/admin/interest', adminRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

// $transaction here is the callback form: prisma.$transaction(async (tx) => {...})
function mockTransactionWith(tx) {
  prisma.$transaction.mockImplementation((cb) => cb(tx));
}

function freshTx(overrides = {}) {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    launchSettings: { upsert: jest.fn().mockResolvedValue({ firstTasteSlots: 10 }) },
    interestRegistration: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/interest/status', () => {
  test('reports slot counts', async () => {
    prisma.launchSettings.upsert.mockResolvedValue({ firstTasteSlots: 10 });
    prisma.interestRegistration.count.mockResolvedValue(4);

    const res = await request(buildApp()).get('/api/interest/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slotsTotal: 10, slotsClaimed: 4, slotsRemaining: 6 });
  });

  test('slotsRemaining never goes negative when over-claimed', async () => {
    prisma.launchSettings.upsert.mockResolvedValue({ firstTasteSlots: 5 });
    prisma.interestRegistration.count.mockResolvedValue(8);
    const res = await request(buildApp()).get('/api/interest/status');
    expect(res.body.slotsRemaining).toBe(0);
  });
});

const VALID_BODY = {
  name: 'Jane',
  email: 'jane@b.com',
  phone: '08012345678',
  address: '1 Market Rd',
};

describe('POST /api/interest', () => {
  test('400 when a required field is missing', async () => {
    const res = await request(buildApp()).post('/api/interest').send({ name: 'Jane' });
    expect(res.status).toBe(400);
  });

  test('400 on a malformed email', async () => {
    const res = await request(buildApp()).post('/api/interest').send({ ...VALID_BODY, email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  test('400 when claiming a slot without a landmark', async () => {
    const res = await request(buildApp()).post('/api/interest').send({ ...VALID_BODY, claimSlot: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/landmark/);
  });

  test('201 registers interest without claiming a slot', async () => {
    const tx = freshTx();
    mockTransactionWith(tx);

    const res = await request(buildApp()).post('/api/interest').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, claimedSlot: false, alreadyShortlisted: false });
    expect(tx.interestRegistration.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ claimedSlot: false }) })
    );
    expect(sendFirstTasteConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'jane@b.com', claimedSlot: false })
    );
    expect(ensureCustomerForFirstTaste).not.toHaveBeenCalled();
  });

  test('claims a slot when one is available, and creates a Customer record', async () => {
    const tx = freshTx({
      launchSettings: { upsert: jest.fn().mockResolvedValue({ firstTasteSlots: 10 }) },
      interestRegistration: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(3), // 3 < 10, slot available
        update: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    mockTransactionWith(tx);

    const res = await request(buildApp())
      .post('/api/interest')
      .send({ ...VALID_BODY, claimSlot: true, landmark: 'Shoprite' });

    expect(res.status).toBe(201);
    expect(res.body.claimedSlot).toBe(true);
    expect(ensureCustomerForFirstTaste).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '08012345678', landmark: 'Shoprite' })
    );
  });

  test('does not claim a slot once they are all taken', async () => {
    const tx = freshTx({
      interestRegistration: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(10), // == firstTasteSlots, none left
        update: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    mockTransactionWith(tx);

    const res = await request(buildApp())
      .post('/api/interest')
      .send({ ...VALID_BODY, claimSlot: true, landmark: 'Shoprite' });

    expect(res.body.claimedSlot).toBe(false);
  });

  test('a re-submission by the same email updates the existing row instead of creating a new one', async () => {
    const tx = freshTx({
      interestRegistration: {
        findFirst: jest.fn().mockResolvedValue({ id: 'reg1', claimedSlot: true, shortlisted: false, landmark: 'Old' }),
        count: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
      },
    });
    mockTransactionWith(tx);

    const res = await request(buildApp()).post('/api/interest').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(tx.interestRegistration.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'reg1' }, data: expect.objectContaining({ claimedSlot: true }) })
    );
    expect(tx.interestRegistration.create).not.toHaveBeenCalled();
  });

  test('skips the confirmation email for someone already shortlisted', async () => {
    const tx = freshTx({
      interestRegistration: {
        findFirst: jest.fn().mockResolvedValue({ id: 'reg1', claimedSlot: true, shortlisted: true, landmark: null }),
        count: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
      },
    });
    mockTransactionWith(tx);

    const res = await request(buildApp()).post('/api/interest').send(VALID_BODY);

    expect(res.body.alreadyShortlisted).toBe(true);
    expect(sendFirstTasteConfirmationEmail).not.toHaveBeenCalled();
  });

  test('a failed confirmation email does not fail the request', async () => {
    const tx = freshTx();
    mockTransactionWith(tx);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    sendFirstTasteConfirmationEmail.mockRejectedValue(new Error('zoho down'));

    const res = await request(buildApp()).post('/api/interest').send(VALID_BODY);
    expect(res.status).toBe(201);
    consoleErrorSpy.mockRestore();
  });
});

describe('GET /api/admin/interest/settings', () => {
  test('reports slot status', async () => {
    prisma.launchSettings.upsert.mockResolvedValue({ firstTasteSlots: 10 });
    prisma.interestRegistration.count.mockResolvedValue(2);
    const res = await request(buildApp()).get('/api/admin/interest/settings');
    expect(res.body).toEqual({ slotsTotal: 10, slotsClaimed: 2, slotsRemaining: 8 });
  });
});

describe('PATCH /api/admin/interest/settings', () => {
  test('400 on a negative/non-integer value', async () => {
    const res = await request(buildApp()).patch('/api/admin/interest/settings').send({ firstTasteSlots: -1 });
    expect(res.status).toBe(400);
  });

  test('updates the slot total', async () => {
    prisma.launchSettings.upsert.mockResolvedValue({ firstTasteSlots: 20 });
    prisma.interestRegistration.count.mockResolvedValue(0);
    const res = await request(buildApp()).patch('/api/admin/interest/settings').send({ firstTasteSlots: 20 });
    expect(res.status).toBe(200);
    expect(res.body.slotsTotal).toBe(20);
  });
});

describe('GET /api/admin/interest', () => {
  test('lists non-deleted registrations', async () => {
    prisma.interestRegistration.findMany.mockResolvedValue([{ id: 'r1' }]);
    const res = await request(buildApp()).get('/api/admin/interest');
    expect(res.status).toBe(200);
    expect(prisma.interestRegistration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
  });
});

describe('GET /api/admin/interest/unread-count', () => {
  test('counts unread', async () => {
    prisma.interestRegistration.count.mockResolvedValue(5);
    const res = await request(buildApp()).get('/api/admin/interest/unread-count');
    expect(res.body).toEqual({ count: 5 });
  });
});

describe('POST /api/admin/interest/send-shortlist-emails', () => {
  test('sends to every shortlisted, not-yet-emailed registration, reports sent/failed', async () => {
    prisma.interestRegistration.findMany.mockResolvedValue([
      { id: 'r1', email: 'a@b.com', name: 'Ada' },
      { id: 'r2', email: 'bad@b.com', name: 'Bad' },
    ]);
    sendShortlistConfirmationEmail.mockResolvedValueOnce().mockRejectedValueOnce(new Error('bounced'));
    prisma.interestRegistration.update.mockResolvedValue({});

    const res = await request(buildApp()).post('/api/admin/interest/send-shortlist-emails');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sent: 1, failed: ['bad@b.com'] });
    expect(prisma.interestRegistration.update).toHaveBeenCalledTimes(1); // only for the successful send
  });
});

describe('POST /api/admin/interest/:id/create-order', () => {
  test('400 when locationId is missing', async () => {
    const res = await request(buildApp()).post('/api/admin/interest/reg1/create-order').send({});
    expect(res.status).toBe(400);
  });

  test('404 when the registration does not exist or is deleted', async () => {
    prisma.interestRegistration.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/admin/interest/reg1/create-order').send({ locationId: 'loc1' });
    expect(res.status).toBe(404);
  });

  test('400 when the registration is not shortlisted', async () => {
    prisma.interestRegistration.findUnique.mockResolvedValue({ id: 'reg1', shortlisted: false, deletedAt: null });
    const res = await request(buildApp()).post('/api/admin/interest/reg1/create-order').send({ locationId: 'loc1' });
    expect(res.status).toBe(400);
  });

  test('201 pushes a shortlisted registration into the ordering flow', async () => {
    prisma.interestRegistration.findUnique.mockResolvedValue({ id: 'reg1', shortlisted: true, deletedAt: null });
    createFirstTasteOrder.mockResolvedValue({ id: 'order1' });

    const res = await request(buildApp()).post('/api/admin/interest/reg1/create-order').send({ locationId: 'loc1' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, order: { id: 'order1' } });
  });

  test('400 on an OrderValidationError from createFirstTasteOrder', async () => {
    prisma.interestRegistration.findUnique.mockResolvedValue({ id: 'reg1', shortlisted: true, deletedAt: null });
    createFirstTasteOrder.mockRejectedValue(new OrderValidationError('already has an order'));

    const res = await request(buildApp()).post('/api/admin/interest/reg1/create-order').send({ locationId: 'loc1' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/admin/interest/:id', () => {
  test('404s when not found', async () => {
    prisma.interestRegistration.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).patch('/api/admin/interest/missing').send({ read: true });
    expect(res.status).toBe(404);
  });

  test('updates read/shortlisted/claimedSlot from only the keys present', async () => {
    prisma.interestRegistration.update.mockResolvedValue({ id: 'reg1', orderId: null });
    const res = await request(buildApp()).patch('/api/admin/interest/reg1').send({ shortlisted: true });
    expect(res.status).toBe(200);
    expect(prisma.interestRegistration.update).toHaveBeenCalledWith({
      where: { id: 'reg1', deletedAt: null },
      data: { shortlisted: true },
    });
  });

  test('creates a Customer when claimedSlot is set true', async () => {
    prisma.interestRegistration.update.mockResolvedValue({ id: 'reg1', orderId: null, phone: '08012345678' });
    await request(buildApp()).patch('/api/admin/interest/reg1').send({ claimedSlot: true });
    expect(ensureCustomerForFirstTaste).toHaveBeenCalled();
  });

  test('shortlisting with a locationId also creates the first-taste order in the same request', async () => {
    prisma.interestRegistration.update.mockResolvedValue({ id: 'reg1', orderId: null });
    createFirstTasteOrder.mockResolvedValue({ id: 'order1' });

    const res = await request(buildApp()).patch('/api/admin/interest/reg1').send({ shortlisted: true, locationId: 'loc1' });

    expect(res.status).toBe(200);
    expect(res.body.order).toEqual({ id: 'order1' });
  });

  test('shortlisting without a locationId does not create an order', async () => {
    prisma.interestRegistration.update.mockResolvedValue({ id: 'reg1', orderId: null });
    const res = await request(buildApp()).patch('/api/admin/interest/reg1').send({ shortlisted: true });
    expect(res.body.order).toBeUndefined();
    expect(createFirstTasteOrder).not.toHaveBeenCalled();
  });

  test('400 on an OrderValidationError while creating the order inline', async () => {
    prisma.interestRegistration.update.mockResolvedValue({ id: 'reg1', orderId: null });
    createFirstTasteOrder.mockRejectedValue(new OrderValidationError('no slots'));
    const res = await request(buildApp()).patch('/api/admin/interest/reg1').send({ shortlisted: true, locationId: 'loc1' });
    expect(res.status).toBe(400);
  });

  test('does not re-create an order when one already exists on the registration', async () => {
    prisma.interestRegistration.update.mockResolvedValue({ id: 'reg1', orderId: 'existing-order' });
    await request(buildApp()).patch('/api/admin/interest/reg1').send({ shortlisted: true, locationId: 'loc1' });
    expect(createFirstTasteOrder).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/interest/:id', () => {
  test('soft-deletes', async () => {
    prisma.interestRegistration.update.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/admin/interest/reg1');
    expect(res.status).toBe(200);
    expect(prisma.interestRegistration.update).toHaveBeenCalledWith({
      where: { id: 'reg1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  test('404s when not found', async () => {
    prisma.interestRegistration.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).delete('/api/admin/interest/missing');
    expect(res.status).toBe(404);
  });

  test('a non-P2025 error reaches the error handler via express-async-errors', async () => {
    prisma.interestRegistration.update.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).delete('/api/admin/interest/reg1');
    expect(res.status).toBe(500);
  });
});
