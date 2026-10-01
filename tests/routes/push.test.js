jest.mock('../../src/db', () => ({ pushSubscription: { upsert: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));
jest.mock('../../src/lib/push', () => ({ broadcastPush: jest.fn() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const { broadcastPush } = require('../../src/lib/push');
const router = require('../../src/routes/push');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/push', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/push/vapid-public-key', () => {
  test('returns the configured public key', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub-key';
    const res = await request(buildApp()).get('/api/push/vapid-public-key');
    expect(res.body).toEqual({ publicKey: 'pub-key' });
    delete process.env.VAPID_PUBLIC_KEY;
  });

  test('returns null when not configured', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const res = await request(buildApp()).get('/api/push/vapid-public-key');
    expect(res.body).toEqual({ publicKey: null });
  });
});

describe('POST /api/push/subscribe', () => {
  test('400 when endpoint or keys are missing', async () => {
    const res = await request(buildApp()).post('/api/push/subscribe').send({ endpoint: 'e1' });
    expect(res.status).toBe(400);
  });

  test('201 upserts by endpoint', async () => {
    prisma.pushSubscription.upsert.mockResolvedValue({ id: 'sub1' });
    const res = await request(buildApp())
      .post('/api/push/subscribe')
      .send({ endpoint: 'e1', keys: { p256dh: 'p1', auth: 'a1' }, customerPhone: '08012345678' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'sub1' });
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith({
      where: { endpoint: 'e1' },
      update: { p256dh: 'p1', auth: 'a1', customerPhone: '08012345678' },
      create: { endpoint: 'e1', p256dh: 'p1', auth: 'a1', customerPhone: '08012345678' },
    });
  });
});

describe('POST /api/push/unsubscribe', () => {
  test('400 when endpoint is missing', async () => {
    const res = await request(buildApp()).post('/api/push/unsubscribe').send({});
    expect(res.status).toBe(400);
  });

  test('204 on success', async () => {
    prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(buildApp()).post('/api/push/unsubscribe').send({ endpoint: 'e1' });
    expect(res.status).toBe(204);
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { endpoint: 'e1' } });
  });
});

describe('GET /api/push/admin/subscriptions', () => {
  test('returns every subscription', async () => {
    prisma.pushSubscription.findMany.mockResolvedValue([{ id: 's1' }]);
    const res = await request(buildApp()).get('/api/push/admin/subscriptions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 's1' }]);
  });
});

describe('POST /api/push/admin/broadcast', () => {
  test('400 when title or body missing', async () => {
    const res = await request(buildApp()).post('/api/push/admin/broadcast').send({ title: 'Hi' });
    expect(res.status).toBe(400);
  });

  test('sends and returns the broadcast result', async () => {
    broadcastPush.mockResolvedValue({ sent: 3 });
    const res = await request(buildApp()).post('/api/push/admin/broadcast').send({ title: 'Hi', body: 'There' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 3 });
    expect(broadcastPush).toHaveBeenCalledWith({ title: 'Hi', body: 'There', url: '/' });
  });

  // This route has no try/catch of its own — relies on express-async-errors
  // (see app.js) to forward a rejected promise to the error handler.
  test('an unexpected error reaches the error handler via express-async-errors', async () => {
    broadcastPush.mockRejectedValue(new Error('push service down'));
    const res = await request(buildApp()).post('/api/push/admin/broadcast').send({ title: 'Hi', body: 'There' });
    expect(res.status).toBe(500);
  });
});
