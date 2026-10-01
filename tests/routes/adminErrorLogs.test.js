jest.mock('../../src/db', () => ({ errorLog: { findMany: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const router = require('../../src/routes/adminErrorLogs');

function buildApp() {
  const app = express();
  app.use('/api/admin/error-logs', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/admin/error-logs', () => {
  test('returns the most recent 200 logs', async () => {
    prisma.errorLog.findMany.mockResolvedValue([{ id: 'e1' }]);
    const res = await request(buildApp()).get('/api/admin/error-logs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'e1' }]);
    expect(prisma.errorLog.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' }, take: 200 });
  });
});

describe('DELETE /api/admin/error-logs/:id', () => {
  test('deletes the log', async () => {
    prisma.errorLog.delete.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/admin/error-logs/e1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('404s when the log does not exist', async () => {
    prisma.errorLog.delete.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const res = await request(buildApp()).delete('/api/admin/error-logs/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Error log not found');
  });

  test('a non-P2025 error reaches the error handler via express-async-errors', async () => {
    prisma.errorLog.delete.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).delete('/api/admin/error-logs/e1');
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/admin/error-logs', () => {
  test('clears every log', async () => {
    prisma.errorLog.deleteMany.mockResolvedValue({ count: 5 });
    const res = await request(buildApp()).delete('/api/admin/error-logs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(prisma.errorLog.deleteMany).toHaveBeenCalledWith({});
  });
});
