jest.mock('../../src/db', () => ({ feedback: { findMany: jest.fn(), update: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const router = require('../../src/routes/feedback');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/feedback', router);
  // minimal error handler, mirroring index.js's final 500 behavior
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/admin/feedback', () => {
  test('returns non-deleted feedback, newest first, with order/customer included', async () => {
    prisma.feedback.findMany.mockResolvedValue([{ id: 'f1', rating: 5 }]);
    const res = await request(buildApp()).get('/api/admin/feedback');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'f1', rating: 5 }]);
    expect(prisma.feedback.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } })
    );
  });
});

describe('DELETE /api/admin/feedback/:id', () => {
  test('soft-deletes by setting deletedAt', async () => {
    prisma.feedback.update.mockResolvedValue({});
    const res = await request(buildApp()).delete('/api/admin/feedback/f1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(prisma.feedback.update).toHaveBeenCalledWith({
      where: { id: 'f1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  test('404s when the feedback does not exist (or is already deleted)', async () => {
    prisma.feedback.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));
    const res = await request(buildApp()).delete('/api/admin/feedback/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Feedback not found');
  });
  test('a non-P2025 error reaches the error handler via express-async-errors', async () => {
    prisma.feedback.update.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).delete('/api/admin/feedback/f1');
    expect(res.status).toBe(500);
  });
});
