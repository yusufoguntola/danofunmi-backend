jest.mock('../../src/db', () => ({ location: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const router = require('../../src/routes/locations');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/locations', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/locations', () => {
  test('returns only active locations', async () => {
    prisma.location.findMany.mockResolvedValue([{ id: 'loc1', name: 'Lekki', active: true }]);
    const res = await request(buildApp()).get('/api/locations');
    expect(res.status).toBe(200);
    expect(prisma.location.findMany).toHaveBeenCalledWith({ where: { active: true }, orderBy: { name: 'asc' } });
  });

  // This route has no try/catch of its own — relies entirely on
  // express-async-errors (see app.js) to forward a rejected Prisma promise
  // to the error handler instead of hanging the request.
  test('an unexpected DB error reaches the error handler via express-async-errors', async () => {
    prisma.location.findMany.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).get('/api/locations');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/locations/admin/all', () => {
  test('returns every location regardless of active state', async () => {
    prisma.location.findMany.mockResolvedValue([{ id: 'loc1' }, { id: 'loc2' }]);
    const res = await request(buildApp()).get('/api/locations/admin/all');
    expect(res.status).toBe(200);
    expect(prisma.location.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
  });
});

describe('POST /api/locations/admin', () => {
  test('400 when name or logisticsFee is missing', async () => {
    const res = await request(buildApp()).post('/api/locations/admin').send({ name: 'Lekki' });
    expect(res.status).toBe(400);
  });

  test('400 when logisticsFee is explicitly null/undefined but name is present', async () => {
    const res = await request(buildApp()).post('/api/locations/admin').send({ logisticsFee: 1000 });
    expect(res.status).toBe(400);
  });

  test('201 creates the location', async () => {
    prisma.location.create.mockResolvedValue({ id: 'loc1', name: 'Lekki', logisticsFee: 1500 });
    const res = await request(buildApp()).post('/api/locations/admin').send({ name: 'Lekki', logisticsFee: 1500 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'loc1', name: 'Lekki', logisticsFee: 1500 });
    expect(prisma.location.create).toHaveBeenCalledWith({ data: { name: 'Lekki', logisticsFee: 1500 } });
  });

  test('a logisticsFee of 0 is accepted (not treated as missing)', async () => {
    prisma.location.create.mockResolvedValue({ id: 'loc1', name: 'Free Zone', logisticsFee: 0 });
    const res = await request(buildApp()).post('/api/locations/admin').send({ name: 'Free Zone', logisticsFee: 0 });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/locations/admin/:id', () => {
  test('updates name/fee/active', async () => {
    prisma.location.update.mockResolvedValue({ id: 'loc1', name: 'Renamed', logisticsFee: 2000, active: false });
    const res = await request(buildApp())
      .patch('/api/locations/admin/loc1')
      .send({ name: 'Renamed', logisticsFee: 2000, active: false });
    expect(res.status).toBe(200);
    expect(prisma.location.update).toHaveBeenCalledWith({
      where: { id: 'loc1' },
      data: { name: 'Renamed', logisticsFee: 2000, active: false },
    });
  });
});
