jest.mock('../../src/db', () => ({ costEntry: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: (req, res, next) => {
    req.admin = { id: 'admin1' };
    next();
  },
}));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const router = require('../../src/routes/costs');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/costs', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/admin/costs', () => {
  test('no date filter when from/to are absent', async () => {
    prisma.costEntry.findMany.mockResolvedValue([]);
    await request(buildApp()).get('/api/admin/costs');
    expect(prisma.costEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  test('applies a from/to incurredOn filter', async () => {
    prisma.costEntry.findMany.mockResolvedValue([]);
    await request(buildApp()).get('/api/admin/costs?from=2026-01-01&to=2026-01-31');
    const { where } = prisma.costEntry.findMany.mock.calls[0][0];
    expect(where.incurredOn.gte).toEqual(new Date('2026-01-01'));
    expect(where.incurredOn.lte).toEqual(new Date('2026-01-31'));
  });

  // This route has no try/catch of its own — relies on express-async-errors
  // (see app.js) to forward a rejected promise to the error handler.
  test('an unexpected DB error reaches the error handler via express-async-errors', async () => {
    prisma.costEntry.findMany.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).get('/api/admin/costs');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/costs', () => {
  test('400 when a required field is missing', async () => {
    const res = await request(buildApp())
      .post('/api/admin/costs')
      .send({ description: 'Rice', category: 'Ingredients' });
    expect(res.status).toBe(400);
  });

  test('201 creates the entry, stamping createdById from the admin token', async () => {
    prisma.costEntry.create.mockResolvedValue({ id: 'c1' });
    const res = await request(buildApp())
      .post('/api/admin/costs')
      .send({ description: 'Rice', category: 'Ingredients', amount: 15000, incurredOn: '2026-01-05' });

    expect(res.status).toBe(201);
    expect(prisma.costEntry.create).toHaveBeenCalledWith({
      data: {
        description: 'Rice',
        category: 'Ingredients',
        amount: 15000,
        incurredOn: new Date('2026-01-05'),
        createdById: 'admin1',
      },
    });
  });

  test('an amount of 0 is accepted (not treated as missing)', async () => {
    prisma.costEntry.create.mockResolvedValue({ id: 'c1' });
    const res = await request(buildApp())
      .post('/api/admin/costs')
      .send({ description: 'Free sample', category: 'Ingredients', amount: 0, incurredOn: '2026-01-05' });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/admin/costs/:id', () => {
  test('updates the entry, converting incurredOn to a Date', async () => {
    prisma.costEntry.update.mockResolvedValue({ id: 'c1' });
    const res = await request(buildApp())
      .patch('/api/admin/costs/c1')
      .send({ description: 'Rice (updated)', category: 'Ingredients', amount: 16000, incurredOn: '2026-01-06' });
    expect(res.status).toBe(200);
    expect(prisma.costEntry.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: {
        description: 'Rice (updated)',
        category: 'Ingredients',
        amount: 16000,
        incurredOn: new Date('2026-01-06'),
      },
    });
  });

  test('leaves incurredOn undefined (unchanged) when not provided', async () => {
    prisma.costEntry.update.mockResolvedValue({ id: 'c1' });
    await request(buildApp()).patch('/api/admin/costs/c1').send({ amount: 17000 });
    expect(prisma.costEntry.update.mock.calls[0][0].data.incurredOn).toBeUndefined();
  });
});

describe('DELETE /api/admin/costs/:id', () => {
  test('204 on success', async () => {
    prisma.costEntry.delete.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/admin/costs/c1');
    expect(res.status).toBe(204);
    expect(prisma.costEntry.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
  });
});
