jest.mock('../../src/middleware/auth', () => ({ optionalCustomerAuth: (req, res, next) => next() }));
jest.mock('../../src/middleware/security', () => ({ requireBrowserOrigin: (req, res, next) => next() }));
jest.mock('../../src/lib/aiAgent', () => ({
  runChat: jest.fn(),
  ChatNotConfiguredError: class ChatNotConfiguredError extends Error {},
}));
jest.mock('../../src/lib/errorLog', () => ({ logError: jest.fn().mockResolvedValue() }));
jest.mock('../../src/lib/email', () => ({ sendAdminAlertEmail: jest.fn().mockResolvedValue() }));

const express = require('express');
const request = require('supertest');
const Anthropic = require('@anthropic-ai/sdk');
const { runChat, ChatNotConfiguredError } = require('../../src/lib/aiAgent');
const { logError } = require('../../src/lib/errorLog');
const { sendAdminAlertEmail } = require('../../src/lib/email');
const router = require('../../src/routes/chat');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', router);
  return app;
}

function apiError(ErrorClass, message, status = 400) {
  return new ErrorClass(status, { error: { message } }, message, undefined);
}

let consoleErrorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  logError.mockResolvedValue();
  sendAdminAlertEmail.mockResolvedValue();
  // The route's error branches console.error every unexpected failure by
  // design (visibility for ops) — expected noise here, so it's silenced
  // rather than asserted on.
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('POST /api/chat — validation', () => {
  test('400 when messages is missing or not an array', async () => {
    const res = await request(buildApp()).post('/api/chat').send({});
    expect(res.status).toBe(400);
  });

  test('400 when messages is empty', async () => {
    const res = await request(buildApp()).post('/api/chat').send({ messages: [] });
    expect(res.status).toBe(400);
  });

  test('400 when the conversation has gotten too long (>60 messages)', async () => {
    const messages = Array.from({ length: 61 }, () => ({ role: 'user', content: 'hi' }));
    const res = await request(buildApp()).post('/api/chat').send({ messages });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gotten long/);
    expect(runChat).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat — success', () => {
  test('200 with the updated messages and meta, passing auth context through', async () => {
    runChat.mockResolvedValue({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], meta: null });

    const res = await request(buildApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.body.meta).toBeNull();
    expect(runChat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hi' }],
      { authenticatedCustomerId: undefined, isAuthenticated: false }
    );
  });
});

describe('POST /api/chat — error handling', () => {
  test('ChatNotConfiguredError → 500 with a friendly message, logs and alerts admin', async () => {
    runChat.mockRejectedValue(new ChatNotConfiguredError('no key'));
    const res = await request(buildApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/order using the menu instead/);
    expect(logError).toHaveBeenCalled();
    expect(sendAdminAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('not configured') })
    );
  });

  test('Anthropic.AuthenticationError → 500 with the same friendly message', async () => {
    runChat.mockRejectedValue(apiError(Anthropic.AuthenticationError, 'bad key', 401));
    const res = await request(buildApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(500);
    expect(sendAdminAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('authentication failed') })
    );
  });

  test('Anthropic.RateLimitError → 429', async () => {
    runChat.mockRejectedValue(apiError(Anthropic.RateLimitError, 'slow down', 429));
    const res = await request(buildApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/a bit busy/);
  });

  test('Anthropic.APIError (e.g. low credit) → 502', async () => {
    runChat.mockRejectedValue(apiError(Anthropic.APIError, 'insufficient credit', 400));
    const res = await request(buildApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(502);
    expect(sendAdminAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('out of Anthropic credit') })
    );
  });

  test('a totally unexpected error → 500 generic message', async () => {
    runChat.mockRejectedValue(new Error('something weird'));
    const res = await request(buildApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Something went wrong. Please try again.');
    expect(sendAdminAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('crashed with an unexpected error') })
    );
  });

  test('every error path still responds even when the admin alert email itself fails', async () => {
    sendAdminAlertEmail.mockRejectedValue(new Error('zoho down'));
    runChat.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(500);
  });
});
