const { requireRecaptcha, isConfigured } = require('../../src/lib/recaptcha');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('isConfigured', () => {
  const ORIGINAL = process.env.RECAPTCHA_SECRET_KEY;
  afterEach(() => {
    process.env.RECAPTCHA_SECRET_KEY = ORIGINAL;
  });

  test('true only when RECAPTCHA_SECRET_KEY is set', () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret';
    expect(isConfigured()).toBe(true);
    delete process.env.RECAPTCHA_SECRET_KEY;
    expect(isConfigured()).toBe(false);
  });
});

describe('requireRecaptcha middleware', () => {
  const ORIGINAL = process.env.RECAPTCHA_SECRET_KEY;
  let consoleWarnSpy, consoleErrorSpy;

  beforeEach(() => {
    global.fetch = jest.fn();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.RECAPTCHA_SECRET_KEY = ORIGINAL;
    delete global.fetch;
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('a no-op (calls next) when not configured, even with no token', async () => {
    delete process.env.RECAPTCHA_SECRET_KEY;
    const next = jest.fn();
    const res = mockRes();
    await requireRecaptcha()({ body: {} }, res, next);
    expect(next).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('400s when configured but no token is given', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret';
    const next = jest.fn();
    const res = mockRes();
    await requireRecaptcha()({ body: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next on a successful, high-score verification', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret';
    global.fetch.mockResolvedValue({ json: async () => ({ success: true, score: 0.9 }) });
    const next = jest.fn();
    const res = mockRes();
    await requireRecaptcha()({ body: { recaptchaToken: 'tok' } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('calls next when success is true and score is undefined (v2-style response)', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret';
    global.fetch.mockResolvedValue({ json: async () => ({ success: true }) });
    const next = jest.fn();
    await requireRecaptcha()({ body: { recaptchaToken: 'tok' } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('403s when success is false', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret';
    global.fetch.mockResolvedValue({ json: async () => ({ success: false }) });
    const next = jest.fn();
    const res = mockRes();
    await requireRecaptcha()({ body: { recaptchaToken: 'tok' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('403s when the score is below the 0.5 threshold', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret';
    global.fetch.mockResolvedValue({ json: async () => ({ success: true, score: 0.2 }) });
    const next = jest.fn();
    const res = mockRes();
    await requireRecaptcha()({ body: { recaptchaToken: 'tok' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('502s when the verification request itself fails', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret';
    global.fetch.mockRejectedValue(new Error('network down'));
    const next = jest.fn();
    const res = mockRes();
    await requireRecaptcha()({ body: { recaptchaToken: 'tok' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(next).not.toHaveBeenCalled();
  });

  test('posts the secret and token as form-encoded body to Google', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'my-secret';
    global.fetch.mockResolvedValue({ json: async () => ({ success: true }) });
    await requireRecaptcha()({ body: { recaptchaToken: 'the-token' } }, mockRes(), jest.fn());

    expect(global.fetch).toHaveBeenCalledWith(
      'https://www.google.com/recaptcha/api/siteverify',
      expect.objectContaining({ method: 'POST' })
    );
    const sentBody = global.fetch.mock.calls[0][1].body;
    expect(sentBody.toString()).toBe('secret=my-secret&response=the-token');
  });
});
