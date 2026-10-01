jest.mock('../../src/db', () => ({ customer: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), findFirst: jest.fn() } }));
jest.mock('bcryptjs', () => ({ hash: jest.fn(), compare: jest.fn() }));
jest.mock('../../src/middleware/auth', () => ({
  requireCustomer: (req, res, next) => {
    req.customer = { id: 'cust1' };
    next();
  },
}));
jest.mock('../../src/middleware/security', () => ({
  authRateLimit: (req, res, next) => next(),
  requireBrowserOrigin: (req, res, next) => next(),
}));
jest.mock('../../src/lib/recaptcha', () => ({ requireRecaptcha: () => (req, res, next) => next() }));
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: jest.fn() })),
}));

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const prisma = require('../../src/db');
const router = require('../../src/routes/customer');

process.env.JWT_SECRET = 'test-jwt-secret';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/customer', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/customer/signup', () => {
  const VALID_BODY = { name: 'Jane', email: 'jane@b.com', phone: '08012345678', password: 'password123' };

  test('400 when a required field is missing', async () => {
    const res = await request(buildApp()).post('/api/customer/signup').send({ name: 'Jane' });
    expect(res.status).toBe(400);
  });

  test('400 on an invalid Nigerian phone number', async () => {
    const res = await request(buildApp()).post('/api/customer/signup').send({ ...VALID_BODY, phone: '12345' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid Nigerian phone/);
  });

  test('400 when the password is under 8 characters', async () => {
    const res = await request(buildApp()).post('/api/customer/signup').send({ ...VALID_BODY, password: 'short' });
    expect(res.status).toBe(400);
  });

  test('409 when the email is already taken', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce({ id: 'existing' }); // byEmail
    const res = await request(buildApp()).post('/api/customer/signup').send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email already exists/);
  });

  test('409 when the phone belongs to an existing password/Google account', async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(null) // byEmail
      .mockResolvedValueOnce({ id: 'existing', passwordHash: 'hash' }); // byPhone
    bcrypt.hash.mockResolvedValue('newhash');
    const res = await request(buildApp()).post('/api/customer/signup').send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/phone number already exists/);
  });

  test('upgrades a guest (phone-only, no password) record into a real account', async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(null) // byEmail
      .mockResolvedValueOnce({ id: 'guest1', passwordHash: null, googleId: null }); // byPhone
    bcrypt.hash.mockResolvedValue('newhash');
    prisma.customer.update.mockResolvedValue({ id: 'guest1', name: 'Jane', email: 'jane@b.com', phone: '08012345678' });

    const res = await request(buildApp()).post('/api/customer/signup').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(prisma.customer.update).toHaveBeenCalledWith({
      where: { id: 'guest1' },
      data: { name: 'Jane', email: 'jane@b.com', passwordHash: 'newhash' },
    });
    expect(jwt.verify(res.body.token, 'test-jwt-secret')).toMatchObject({ type: 'customer', id: 'guest1' });
  });

  test('201 creates a brand-new account when neither email nor phone exists', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    bcrypt.hash.mockResolvedValue('newhash');
    prisma.customer.create.mockResolvedValue({ id: 'cust1', name: 'Jane', email: 'jane@b.com', phone: '08012345678' });

    const res = await request(buildApp()).post('/api/customer/signup').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(prisma.customer.create).toHaveBeenCalledWith({
      data: { name: 'Jane', email: 'jane@b.com', phone: '08012345678', passwordHash: 'newhash' },
    });
  });
});

describe('POST /api/customer/login', () => {
  test('400 when identifier or password is missing', async () => {
    const res = await request(buildApp()).post('/api/customer/login').send({ identifier: 'jane@b.com' });
    expect(res.status).toBe(400);
  });

  test('401 when no account matches', async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/customer/login').send({ identifier: 'jane@b.com', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('401 with a distinct message for a Google-only account', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'cust1', passwordHash: null, googleId: 'g1' });
    const res = await request(buildApp()).post('/api/customer/login').send({ identifier: 'jane@b.com', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signs in with Google/);
  });

  test('401 on a wrong password', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'cust1', passwordHash: 'hash' });
    bcrypt.compare.mockResolvedValue(false);
    const res = await request(buildApp()).post('/api/customer/login').send({ identifier: 'jane@b.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('200 with a signed token on success, matched by email or phone', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'cust1', name: 'Jane', email: 'jane@b.com', phone: '08012345678', passwordHash: 'hash' });
    bcrypt.compare.mockResolvedValue(true);

    const res = await request(buildApp()).post('/api/customer/login').send({ identifier: '08012345678', password: 'right' });

    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ id: 'cust1', name: 'Jane' });
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ email: '08012345678' }, { phone: '08012345678' }] },
    });
  });
});

describe('POST /api/customer/google', () => {
  const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  afterEach(() => {
    process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  });

  test("500 when Google sign-in isn't configured", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await request(buildApp()).post('/api/customer/google').send({ credential: 'tok' });
    expect(res.status).toBe(500);
  });

  test('400 when credential is missing', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    const res = await request(buildApp()).post('/api/customer/google').send({});
    expect(res.status).toBe(400);
  });

  test('401 when the token fails verification', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    OAuth2Client.mockImplementation(() => ({
      verifyIdToken: jest.fn().mockRejectedValue(new Error('bad token')),
    }));
    const res = await request(buildApp()).post('/api/customer/google').send({ credential: 'bad' });
    expect(res.status).toBe(401);
  });

  test('links an existing email account to googleId on first Google sign-in', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    OAuth2Client.mockImplementation(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({
        getPayload: () => ({ sub: 'google-sub-1', email: 'jane@b.com', name: 'Jane' }),
      }),
    }));
    prisma.customer.findUnique
      .mockResolvedValueOnce(null) // by googleId — not linked yet
      .mockResolvedValueOnce({ id: 'cust1', email: 'jane@b.com' }); // by email
    prisma.customer.update.mockResolvedValue({ id: 'cust1', name: 'Jane', email: 'jane@b.com' });

    const res = await request(buildApp()).post('/api/customer/google').send({ credential: 'good' });

    expect(res.status).toBe(200);
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'cust1' }, data: { googleId: 'google-sub-1' } });
  });

  test('creates a brand-new account when neither googleId nor email matches', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    OAuth2Client.mockImplementation(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({
        getPayload: () => ({ sub: 'google-sub-2', email: 'new@b.com', name: 'New Person' }),
      }),
    }));
    prisma.customer.findUnique.mockResolvedValue(null);
    prisma.customer.create.mockResolvedValue({ id: 'cust2', name: 'New Person', email: 'new@b.com' });

    const res = await request(buildApp()).post('/api/customer/google').send({ credential: 'good' });

    expect(res.status).toBe(200);
    expect(prisma.customer.create).toHaveBeenCalledWith({
      data: { name: 'New Person', email: 'new@b.com', googleId: 'google-sub-2' },
    });
  });

  test('returns straight away when a googleId match already exists', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    OAuth2Client.mockImplementation(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => ({ sub: 'google-sub-1', email: 'jane@b.com' }) }),
    }));
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1', name: 'Jane', email: 'jane@b.com' });

    const res = await request(buildApp()).post('/api/customer/google').send({ credential: 'good' });
    expect(res.status).toBe(200);
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/customer/me', () => {
  test("404s when the account no longer exists", async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/customer/me');
    expect(res.status).toBe(404);
  });

  test('returns the public profile', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1', name: 'Jane', email: 'jane@b.com', phone: '08012345678', address: 'Addr', passwordHash: 'secret' });
    const res = await request(buildApp()).get('/api/customer/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'cust1', name: 'Jane', email: 'jane@b.com', phone: '08012345678', address: 'Addr' });
    expect(res.body.passwordHash).toBeUndefined();
  });

  // This route has no try/catch of its own — relies on express-async-errors
  // (see app.js) to forward a rejected promise to the error handler.
  test('an unexpected DB error reaches the error handler via express-async-errors', async () => {
    prisma.customer.findUnique.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp()).get('/api/customer/me');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/customer/orders', () => {
  test("returns this account's orders", async () => {
    prisma.order = { findMany: jest.fn().mockResolvedValue([{ id: 'o1' }]) };
    const res = await request(buildApp()).get('/api/customer/orders');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'o1' }]);
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { customerId: 'cust1' } }));
  });
});
