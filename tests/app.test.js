// Exercises the app-wiring concerns that live in app.js itself (CORS, the
// health check, payment-info, 404, and the global error handler) rather than
// any individual route's business logic — those are covered in
// src/routes/*.test.js, each with the real sub-router mounted here too but
// their DB/middleware dependencies left unmocked is impractical at this
// level, so this file mocks every router wholesale and only asserts on
// app.js's own behavior.
// menu's mock gets one extra test-only route so the error-handler tests
// below can trigger a real error through the full app.js pipeline (past
// CORS/rate-limit/etc, same as a genuine route would) rather than trying to
// splice a route into the already-built app after the fact.
jest.mock('../src/routes/menu', () => {
  const r = require('express').Router();
  r.get('/__boom', (req, res, next) => {
    const err = new Error(req.query.message || 'boom');
    if (req.query.status) err.status = Number(req.query.status);
    next(err);
  });
  return r;
});
jest.mock('../src/routes/locations', () => require('express').Router());
jest.mock('../src/routes/orders', () => require('express').Router());
jest.mock('../src/routes/auth', () => require('express').Router());
jest.mock('../src/routes/costs', () => require('express').Router());
jest.mock('../src/routes/reports', () => require('express').Router());
jest.mock('../src/routes/internal', () => require('express').Router());
jest.mock('../src/routes/chat', () => require('express').Router());
jest.mock('../src/routes/feedback', () => require('express').Router());
jest.mock('../src/routes/publicFeedback', () => require('express').Router());
jest.mock('../src/routes/requests', () => require('express').Router());
jest.mock('../src/routes/interest', () => ({ publicRouter: require('express').Router(), adminRouter: require('express').Router() }));
jest.mock('../src/routes/push', () => require('express').Router());
jest.mock('../src/routes/customer', () => require('express').Router());
jest.mock('../src/routes/adminCustomers', () => require('express').Router());
jest.mock('../src/routes/broadcast', () => require('express').Router());
jest.mock('../src/routes/adminErrorLogs', () => require('express').Router());
jest.mock('../src/lib/errorLog', () => ({ logError: jest.fn().mockResolvedValue() }));
jest.mock('../src/lib/email', () => ({ sendAdminAlertEmail: jest.fn().mockResolvedValue() }));

const request = require('supertest');

const ORIGINAL_ENV = { ...process.env };

function load() {
  jest.resetModules();
  return require('../src/app');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('GET /health', () => {
  test('200 { ok: true } — no auth, no rate limit applied (mounted before /api)', async () => {
    const res = await request(load()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /api/payment-info', () => {
  test('echoes bank details and the receipt size cap from env', async () => {
    process.env.BANK_NAME = 'Test Bank';
    process.env.BANK_ACCOUNT_NAME = 'dánọ́fúnmi';
    process.env.BANK_ACCOUNT_NUMBER = '0123456789';
    const res = await request(load()).get('/api/payment-info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      bankName: 'Test Bank',
      accountName: 'dánọ́fúnmi',
      accountNumber: '0123456789',
    });
    expect(typeof res.body.maxReceiptFileSizeKB).toBe('number');
  });
});

describe('404 fallback', () => {
  test('an unmatched route gets a JSON 404, not an HTML default page', async () => {
    const res = await request(load()).get('/api/totally-not-a-real-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('CORS', () => {
  test('with no FRONTEND_ORIGIN configured, any origin is allowed', async () => {
    // Empty, not deleted — app.js's own `dotenv.config()` runs on every
    // fresh require and refills a *missing* key from the repo's real .env
    // (which does set FRONTEND_ORIGIN), but never overrides a key that's
    // already present, even an empty one.
    process.env.FRONTEND_ORIGIN = '';
    const res = await request(load()).get('/health').set('Origin', 'https://anything.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://anything.example.com');
  });

  test('an allowed origin is echoed back with credentials enabled', async () => {
    process.env.FRONTEND_ORIGIN = 'https://danofunmi.com';
    const res = await request(load()).get('/health').set('Origin', 'https://danofunmi.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://danofunmi.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('a disallowed origin gets no CORS header back (browser blocks the response)', async () => {
    process.env.FRONTEND_ORIGIN = 'https://danofunmi.com';
    const res = await request(load()).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('a request with no Origin header at all (server-to-server) is never blocked', async () => {
    process.env.FRONTEND_ORIGIN = 'https://danofunmi.com';
    const res = await request(load()).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('global error handler', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    // The handler itself console.errors every error by design (ops
    // visibility) — expected noise here, so it's silenced rather than
    // asserted on.
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  // Routed through the mocked menu router's /__boom test route (see the
  // jest.mock above) so the error genuinely travels through app.js's real
  // middleware stack and reaches its real error handler, rather than a route
  // spliced in after the app was already built.
  test('a downstream route error becomes a JSON error response with its status', async () => {
    const res = await request(load()).get('/api/menu/__boom?status=418&message=nope');
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ error: 'nope' });
  });

  test('defaults to 500 when the error carries no status', async () => {
    const res = await request(load()).get('/api/menu/__boom?message=unexpected');
    expect(res.status).toBe(500);
  });

  test('logs every error via logError, regardless of status', async () => {
    const app = load();
    const { logError } = require('../src/lib/errorLog');
    await request(app).get('/api/menu/__boom?message=nope');
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ source: 'http', message: 'nope' }));
  });

  test('only 5xx errors trigger the admin alert email, not 4xx', async () => {
    const app = load();
    const { sendAdminAlertEmail } = require('../src/lib/email');
    await request(app).get('/api/menu/__boom?status=400&message=bad+input');
    expect(sendAdminAlertEmail).not.toHaveBeenCalled();
  });

  test('a 5xx error does trigger the admin alert email', async () => {
    const app = load();
    const { sendAdminAlertEmail } = require('../src/lib/email');
    await request(app).get('/api/menu/__boom?message=boom');
    expect(sendAdminAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('/api/menu/__boom') })
    );
  });

  test('a response is still sent even if logError itself fails', async () => {
    const app = load();
    const { logError } = require('../src/lib/errorLog');
    logError.mockRejectedValueOnce(new Error('log store down'));
    const res = await request(app).get('/api/menu/__boom?message=nope');
    expect(res.status).toBe(500);
  });
});
