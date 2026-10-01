jest.mock('../../src/db', () => ({ customer: { findMany: jest.fn() } }));
jest.mock('../../src/middleware/auth', () => ({ requireAdmin: (req, res, next) => next() }));
jest.mock('../../src/lib/push', () => ({ broadcastPush: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendBroadcastEmail: jest.fn() }));

const express = require('express');
const request = require('supertest');
const prisma = require('../../src/db');
const { broadcastPush } = require('../../src/lib/push');
const { sendBroadcastEmail } = require('../../src/lib/email');
const router = require('../../src/routes/broadcast');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/broadcast', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/admin/broadcast', () => {
  test('400 when title or body is missing', async () => {
    const res = await request(buildApp()).post('/api/admin/broadcast').send({ title: 'Hi', channels: ['in_app'] });
    expect(res.status).toBe(400);
  });

  test('400 when no (valid) channel is selected', async () => {
    const res = await request(buildApp()).post('/api/admin/broadcast').send({ title: 'Hi', body: 'There', channels: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Select at least one channel/);
  });

  test('400 when channels is missing entirely', async () => {
    const res = await request(buildApp()).post('/api/admin/broadcast').send({ title: 'Hi', body: 'There' });
    expect(res.status).toBe(400);
  });

  test('silently drops channels outside the active allowlist (sms/whatsapp)', async () => {
    const res = await request(buildApp())
      .post('/api/admin/broadcast')
      .send({ title: 'Hi', body: 'There', channels: ['sms', 'whatsapp'] });
    expect(res.status).toBe(400); // nothing valid left after filtering
    expect(broadcastPush).not.toHaveBeenCalled();
  });

  test('sends via in_app only when only in_app is selected', async () => {
    broadcastPush.mockResolvedValue({ sent: 4 });
    const res = await request(buildApp())
      .post('/api/admin/broadcast')
      .send({ title: 'New menu!', body: 'Check it out', channels: ['in_app'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, results: { in_app: { sent: 4 } } });
    expect(sendBroadcastEmail).not.toHaveBeenCalled();
  });

  test('sends via email to every customer with an email on file, reporting sent/failed', async () => {
    prisma.customer.findMany.mockResolvedValue([
      { email: 'a@b.com', name: 'Ada' },
      { email: 'bad@b.com', name: 'Bad' },
    ]);
    sendBroadcastEmail.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('bounced'));

    const res = await request(buildApp())
      .post('/api/admin/broadcast')
      .send({ title: 'New menu!', body: 'Check it out', channels: ['email'] });

    expect(res.status).toBe(200);
    expect(res.body.results.email).toEqual({ sent: 1, failed: ['bad@b.com'] });
    expect(prisma.customer.findMany).toHaveBeenCalledWith({ where: { email: { not: null } } });
  });

  test('sends via both channels at once when both are selected', async () => {
    broadcastPush.mockResolvedValue({ sent: 2 });
    prisma.customer.findMany.mockResolvedValue([]);

    const res = await request(buildApp())
      .post('/api/admin/broadcast')
      .send({ title: 'Hi', body: 'There', channels: ['in_app', 'email'] });

    expect(res.body.results).toEqual({ in_app: { sent: 2 }, email: { sent: 0, failed: [] } });
  });

  test('a thrown error reaches the error-handling middleware via next(err)', async () => {
    prisma.customer.findMany.mockRejectedValue(new Error('DB down'));
    const res = await request(buildApp())
      .post('/api/admin/broadcast')
      .send({ title: 'Hi', body: 'There', channels: ['email'] });
    expect(res.status).toBe(500);
  });
});
