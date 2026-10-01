jest.mock('../../src/db', () => ({ adminUser: { findUnique: jest.fn() } }));
jest.mock('bcryptjs', () => ({ compare: jest.fn() }));
// authRateLimit is exercised on its own in middleware/security.test.js — here
// it's a pass-through so these tests aren't rate-limited after a few runs.
jest.mock('../../src/middleware/security', () => ({ authRateLimit: (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../../src/db');
const router = require('../../src/routes/auth');

process.env.JWT_SECRET = 'test-jwt-secret';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/admin/login', () => {
  test('400 when email or password is missing', async () => {
    const res = await request(buildApp()).post('/api/admin/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  test('401 when no admin exists with that email', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/admin/login').send({ email: 'a@b.com', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  test('401 on a wrong password', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'a1', email: 'a@b.com', passwordHash: 'hash' });
    bcrypt.compare.mockResolvedValue(false);
    const res = await request(buildApp()).post('/api/admin/login').send({ email: 'a@b.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('200 with a signed token and public admin fields on success', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'a1', email: 'a@b.com', name: 'Admin', passwordHash: 'hash' });
    bcrypt.compare.mockResolvedValue(true);

    const res = await request(buildApp()).post('/api/admin/login').send({ email: 'a@b.com', password: 'right' });

    expect(res.status).toBe(200);
    expect(res.body.admin).toEqual({ id: 'a1', email: 'a@b.com', name: 'Admin' });
    const decoded = jwt.verify(res.body.token, 'test-jwt-secret');
    expect(decoded).toMatchObject({ type: 'admin', id: 'a1', email: 'a@b.com', name: 'Admin' });
  });
});
