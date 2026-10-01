jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));
jest.mock('../../src/db', () => ({
  pushSubscription: { findMany: jest.fn(), delete: jest.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

function setVapidEnv() {
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.VAPID_SUBJECT = 'mailto:a@b.com';
}

function clearVapidEnv() {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
}

// `configured` is cached at module scope once ensureConfigured succeeds, and
// the mocked '../db'/'web-push' instances live in the same module registry
// as push.js itself — so each test gets a genuinely fresh module graph
// (jest.resetModules()) and re-requires every one of them together, rather
// than reusing a `prisma`/`webpush` handle captured before the reset.
function load() {
  jest.resetModules();
  const webpush = require('web-push');
  const prisma = require('../../src/db');
  const pushLib = require('../../src/lib/push');
  return { ...pushLib, webpush, prisma };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sendPushToPhone', () => {
  test('does nothing with no phone', async () => {
    setVapidEnv();
    const { sendPushToPhone, prisma } = load();
    await sendPushToPhone(null, { title: 't' });
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
  });

  test('does nothing when VAPID env is not configured', async () => {
    clearVapidEnv();
    const { sendPushToPhone, prisma } = load();
    await sendPushToPhone('08012345678', { title: 't' });
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
  });

  test('sends to every subscription for that phone', async () => {
    setVapidEnv();
    const { sendPushToPhone, prisma, webpush } = load();
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 's1', endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
      { id: 's2', endpoint: 'e2', p256dh: 'p2', auth: 'a2' },
    ]);
    webpush.sendNotification.mockResolvedValue();

    await sendPushToPhone('08012345678', { title: 'Order update' });

    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({ where: { customerPhone: '08012345678' } });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: 'e1', keys: { p256dh: 'p1', auth: 'a1' } },
      JSON.stringify({ title: 'Order update' })
    );
  });

  test('deletes the subscription on a 404/410 (gone) response', async () => {
    setVapidEnv();
    const { sendPushToPhone, prisma, webpush } = load();
    prisma.pushSubscription.findMany.mockResolvedValue([{ id: 's1', endpoint: 'e1', p256dh: 'p1', auth: 'a1' }]);
    const err = Object.assign(new Error('gone'), { statusCode: 410 });
    webpush.sendNotification.mockRejectedValue(err);
    prisma.pushSubscription.delete.mockResolvedValue({});

    await sendPushToPhone('08012345678', { title: 't' });

    expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
  });

  test('logs (not throws) on any other send failure, and never deletes', async () => {
    setVapidEnv();
    const { sendPushToPhone, prisma, webpush } = load();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    prisma.pushSubscription.findMany.mockResolvedValue([{ id: 's1', endpoint: 'e1', p256dh: 'p1', auth: 'a1' }]);
    webpush.sendNotification.mockRejectedValue(Object.assign(new Error('oops'), { statusCode: 500 }));

    await expect(sendPushToPhone('08012345678', { title: 't' })).resolves.toBeUndefined();
    expect(prisma.pushSubscription.delete).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('broadcastPush', () => {
  test('returns { sent: 0 } without querying when not configured', async () => {
    clearVapidEnv();
    const { broadcastPush, prisma } = load();
    const result = await broadcastPush({ title: 't' });
    expect(result).toEqual({ sent: 0 });
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
  });

  test('sends to every subscription and reports the count', async () => {
    setVapidEnv();
    const { broadcastPush, prisma, webpush } = load();
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 's1', endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
      { id: 's2', endpoint: 'e2', p256dh: 'p2', auth: 'a2' },
      { id: 's3', endpoint: 'e3', p256dh: 'p3', auth: 'a3' },
    ]);
    webpush.sendNotification.mockResolvedValue();

    const result = await broadcastPush({ title: 'New menu!' });

    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith();
    expect(webpush.sendNotification).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ sent: 3 });
  });
});

describe('isConfigured (ensureConfigured)', () => {
  test('sets VAPID details and returns true exactly once, caching after', () => {
    setVapidEnv();
    const { isConfigured, webpush } = load();
    expect(isConfigured()).toBe(true);
    expect(isConfigured()).toBe(true);
    expect(webpush.setVapidDetails).toHaveBeenCalledTimes(1);
    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:a@b.com', 'pub', 'priv');
  });

  test('returns false when any VAPID var is missing', () => {
    setVapidEnv();
    delete process.env.VAPID_SUBJECT;
    const { isConfigured, webpush } = load();
    expect(isConfigured()).toBe(false);
    expect(webpush.setVapidDetails).not.toHaveBeenCalled();
  });
});
