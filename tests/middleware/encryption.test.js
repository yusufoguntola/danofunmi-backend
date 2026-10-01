jest.mock('../../src/lib/payloadCrypto', () => ({
  isEnabled: jest.fn(),
  encryptString: jest.fn(),
  decryptString: jest.fn(),
}));

const { isEnabled, encryptString, decryptString } = require('../../src/lib/payloadCrypto');
const { decryptRequest, encryptResponse } = require('../../src/middleware/encryption');

function mockRes() {
  const res = {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    set: jest.fn(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('decryptRequest', () => {
  test('a no-op for requests without the X-Encrypted header', () => {
    const req = { get: () => undefined, body: { a: 1 } };
    const next = jest.fn();
    const res = mockRes();
    decryptRequest(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.wantsEncryptedResponse).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('400s when the header is set but obfuscation is not enabled', () => {
    isEnabled.mockReturnValue(false);
    const req = { get: () => '1', body: {} };
    const next = jest.fn();
    const res = mockRes();
    decryptRequest(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('decrypts the envelope and replaces req.body with the parsed JSON', () => {
    isEnabled.mockReturnValue(true);
    decryptString.mockReturnValue('{"name":"Ada"}');
    const req = { get: () => '1', body: { data: 'base64stuff' } };
    const next = jest.fn();
    decryptRequest(req, mockRes(), next);

    expect(decryptString).toHaveBeenCalledWith('base64stuff');
    expect(req.body).toEqual({ name: 'Ada' });
    expect(req.wantsEncryptedResponse).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  test('an empty decrypted string becomes an empty object, not a JSON.parse crash', () => {
    isEnabled.mockReturnValue(true);
    decryptString.mockReturnValue('');
    const req = { get: () => '1', body: { data: 'x' } };
    const next = jest.fn();
    decryptRequest(req, mockRes(), next);
    expect(req.body).toEqual({});
    expect(next).toHaveBeenCalled();
  });

  test('400s when decryption throws (bad ciphertext)', () => {
    isEnabled.mockReturnValue(true);
    decryptString.mockImplementation(() => {
      throw new Error('bad tag');
    });
    const req = { get: () => '1', body: { data: 'tampered' } };
    const next = jest.fn();
    const res = mockRes();
    decryptRequest(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('leaves req.body untouched when there is no envelope string', () => {
    isEnabled.mockReturnValue(true);
    const req = { get: () => '1', body: { already: 'plain json' } };
    const next = jest.fn();
    decryptRequest(req, mockRes(), next);
    expect(req.body).toEqual({ already: 'plain json' });
    expect(req.wantsEncryptedResponse).toBe(true);
    expect(next).toHaveBeenCalled();
  });
});

describe('encryptResponse', () => {
  test('a no-op (does not wrap res.json) when obfuscation is not enabled', () => {
    isEnabled.mockReturnValue(false);
    const res = mockRes();
    const originalJson = res.json;
    const next = jest.fn();
    encryptResponse({}, res, next);
    expect(res.json).toBe(originalJson);
    expect(next).toHaveBeenCalled();
  });

  test('passes the body straight through, unwrapped, when the client never asked for encryption', () => {
    isEnabled.mockReturnValue(true);
    const sendJson = jest.fn();
    const res = { json: sendJson, set: jest.fn(), status: jest.fn().mockReturnThis() };
    const req = {}; // wantsEncryptedResponse never set (decryptRequest never saw the opt-in header)
    encryptResponse(req, res, jest.fn());

    res.json({ hello: 'world' });

    expect(sendJson).toHaveBeenCalledWith({ hello: 'world' });
    expect(encryptString).not.toHaveBeenCalled();
    expect(res.set).not.toHaveBeenCalled();
  });

  test('wraps the response body in an encrypted envelope when the client opted in', () => {
    isEnabled.mockReturnValue(true);
    encryptString.mockReturnValue('encrypted-blob');
    const sendJson = jest.fn();
    const res = { json: sendJson, set: jest.fn(), status: jest.fn().mockReturnThis() };
    const req = { wantsEncryptedResponse: true };
    const next = jest.fn();

    encryptResponse(req, res, next);
    res.json({ ok: true });

    expect(encryptString).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(res.set).toHaveBeenCalledWith('X-Encrypted', '1');
    expect(sendJson).toHaveBeenCalledWith({ data: 'encrypted-blob' });
  });

  test('encodes an undefined body as "null" before encrypting', () => {
    isEnabled.mockReturnValue(true);
    encryptString.mockReturnValue('encrypted-null');
    const sendJson = jest.fn();
    const res = { json: sendJson, set: jest.fn(), status: jest.fn().mockReturnThis() };
    encryptResponse({ wantsEncryptedResponse: true }, res, jest.fn());

    res.json(undefined);
    expect(encryptString).toHaveBeenCalledWith('null');
  });

  test('500s with an unencrypted error body if encryption itself fails', () => {
    isEnabled.mockReturnValue(true);
    encryptString.mockImplementation(() => {
      throw new Error('key missing');
    });
    const sendJson = jest.fn();
    const res = { json: sendJson, set: jest.fn(), status: jest.fn().mockReturnThis() };
    encryptResponse({ wantsEncryptedResponse: true }, res, jest.fn());

    res.json({ ok: true });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(sendJson).toHaveBeenCalledWith({ error: 'Response encryption failed.' });
  });
});
