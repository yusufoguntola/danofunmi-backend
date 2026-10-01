const express = require('express');
const request = require('supertest');
const { apiRateLimit, orderLookupRateLimit, authRateLimit, requireBrowserOrigin } = require('../../src/middleware/security');

describe('requireBrowserOrigin', () => {
  // Currently fully disabled (see the commented-out body in security.js) —
  // this locks in that it is an unconditional pass-through no matter what
  // headers are present, so a future accidental revert is caught by a
  // failing/changed test rather than silently shipping a stricter gate.
  test('always calls next(), regardless of Origin/Referer headers', () => {
    const next = jest.fn();
    requireBrowserOrigin({ headers: {} }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('still calls next() with an Origin header present', () => {
    const next = jest.fn();
    requireBrowserOrigin({ headers: { origin: 'https://evil.com' } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

function appWith(middleware) {
  const app = express();
  app.use(middleware);
  app.all(/.*/, (req, res) => res.json({ ok: true }));
  return app;
}

describe('apiRateLimit', () => {
  test('skips (no rate-limit headers, always reachable) under /api/internal', async () => {
    const app = appWith(apiRateLimit);
    const res = await request(app).get('/api/internal/orders');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  test('applies (sets standard rate-limit headers) outside /api/internal', async () => {
    const app = appWith(apiRateLimit);
    const res = await request(app).get('/api/menu');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('300');
  });
});

describe('orderLookupRateLimit / authRateLimit', () => {
  test('orderLookupRateLimit applies its own (tighter) limit', async () => {
    const res = await request(appWith(orderLookupRateLimit)).get('/api/orders/DFM-AB12CD');
    expect(res.headers['ratelimit-limit']).toBe('30');
  });

  test('authRateLimit applies its own (tighter) limit', async () => {
    const res = await request(appWith(authRateLimit)).post('/api/admin/login');
    expect(res.headers['ratelimit-limit']).toBe('10');
  });
});
