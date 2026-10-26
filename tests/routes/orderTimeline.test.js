jest.mock('../../src/db', () => ({ orderTimeline: { findUnique: jest.fn(), upsert: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const { publicRouter, adminRouter } = require('../../src/routes/orderTimeline');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/order-timeline', publicRouter);
  app.use('/api/admin/order-timeline', adminRouter);
  return app;
}

const ROW = {
  id: 'singleton',
  opensOn: new Date('2026-10-25T00:00:00Z'),
  closesOn: new Date('2026-11-13T00:00:00Z'),
  deliveryStartsOn: new Date('2026-11-16T00:00:00Z'),
  deliveryEndsOn: new Date('2026-11-18T00:00:00Z'),
  updatedAt: new Date('2026-10-26T09:00:00Z'),
};

const BODY = {
  opensOn: '2026-11-24',
  closesOn: '2026-12-12',
  deliveryStartsOn: '2026-12-15',
  deliveryEndsOn: '2026-12-17',
};

beforeEach(() => jest.clearAllMocks());

describe('GET /api/order-timeline', () => {
  test('returns the current timeline', async () => {
    prisma.orderTimeline.findUnique.mockResolvedValue(ROW);
    const res = await request(buildApp()).get('/api/order-timeline');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ opensOn: '2026-10-25', deliveryEndsOn: '2026-11-18' });
  });

  test('returns null when none is set', async () => {
    prisma.orderTimeline.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/order-timeline');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe('PUT /api/admin/order-timeline', () => {
  test('saves a valid timeline', async () => {
    prisma.orderTimeline.upsert.mockImplementation(async ({ update }) => ({ ...ROW, ...update }));
    const res = await request(buildApp()).put('/api/admin/order-timeline').send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(BODY);
  });

  test('400s on an invalid timeline without saving', async () => {
    const res = await request(buildApp())
      .put('/api/admin/order-timeline')
      .send({ ...BODY, deliveryStartsOn: '2026-12-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start after ordering closes/);
    expect(prisma.orderTimeline.upsert).not.toHaveBeenCalled();
  });
});
