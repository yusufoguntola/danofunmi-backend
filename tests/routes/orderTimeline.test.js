jest.mock('../../src/db', () => ({ orderTimeline: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: (req, res, next) => {
    req.admin = { id: 'admin1', name: 'Ada Admin', email: 'ada@example.com' };
    next();
  },
}));

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
  id: 'tl_1',
  opensOn: new Date('2026-10-25T00:00:00Z'),
  closesOn: new Date('2026-11-13T00:00:00Z'),
  deliveryStartsOn: new Date('2026-11-16T00:00:00Z'),
  deliveryEndsOn: new Date('2026-11-18T00:00:00Z'),
  createdByName: null,
  createdAt: new Date('2026-10-26T09:00:00Z'),
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
    prisma.orderTimeline.findFirst.mockResolvedValue(ROW);
    const res = await request(buildApp()).get('/api/order-timeline');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ opensOn: '2026-10-25', deliveryEndsOn: '2026-11-18' });
  });

  test('returns null when none is set', async () => {
    prisma.orderTimeline.findFirst.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/order-timeline');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe('GET /api/admin/order-timeline/history', () => {
  test('returns saved timelines newest first', async () => {
    prisma.orderTimeline.findMany.mockResolvedValue([ROW, { ...ROW, id: 'tl_0' }]);
    const res = await request(buildApp()).get('/api/admin/order-timeline/history');
    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.id)).toEqual(['tl_1', 'tl_0']);
  });
});

describe('POST /api/admin/order-timeline', () => {
  test('saves a valid timeline as a new history row, recording who saved it', async () => {
    prisma.orderTimeline.create.mockImplementation(async ({ data }) => ({ ...ROW, ...data, id: 'tl_2' }));
    const res = await request(buildApp()).post('/api/admin/order-timeline').send(BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ...BODY, id: 'tl_2', createdByName: 'Ada Admin' });
    expect(prisma.orderTimeline.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdByName: 'Ada Admin' }),
    });
  });

  test('400s on an invalid timeline without saving', async () => {
    const res = await request(buildApp())
      .post('/api/admin/order-timeline')
      .send({ ...BODY, deliveryStartsOn: '2026-12-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start after ordering closes/);
    expect(prisma.orderTimeline.create).not.toHaveBeenCalled();
  });
});
