const jwt = require('jsonwebtoken');
const { requireAdmin, requireCustomer, optionalCustomerAuth, requireInternalKey } = require('../../src/middleware/auth');

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'test-jwt-secret';

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function reqWithToken(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

describe('requireAdmin', () => {
  test('401s with no Authorization header', () => {
    const next = jest.fn();
    const res = mockRes();
    requireAdmin(reqWithToken(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing admin token' });
    expect(next).not.toHaveBeenCalled();
  });

  test('401s on a malformed/non-Bearer header', () => {
    const next = jest.fn();
    const res = mockRes();
    requireAdmin({ headers: { authorization: 'Basic abc123' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('401s on an invalid token', () => {
    const next = jest.fn();
    const res = mockRes();
    requireAdmin(reqWithToken('not-a-real-token'), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
  });

  test('401s on an expired token', () => {
    const token = jwt.sign({ type: 'admin', id: 'a1' }, SECRET, { expiresIn: -10 });
    const next = jest.fn();
    const res = mockRes();
    requireAdmin(reqWithToken(token), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('401s on a valid token of the wrong type (customer, not admin)', () => {
    const token = jwt.sign({ type: 'customer', id: 'c1' }, SECRET);
    const next = jest.fn();
    const res = mockRes();
    requireAdmin(reqWithToken(token), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('calls next and attaches req.admin on a valid admin token', () => {
    const token = jwt.sign({ type: 'admin', id: 'a1', email: 'a@b.com', name: 'Admin' }, SECRET);
    const next = jest.fn();
    const req = reqWithToken(token);
    requireAdmin(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.admin).toMatchObject({ type: 'admin', id: 'a1', email: 'a@b.com' });
  });
});

describe('requireCustomer', () => {
  test('401s with no token', () => {
    const next = jest.fn();
    const res = mockRes();
    requireCustomer(reqWithToken(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing customer token' });
  });

  test('401s on an admin token (wrong type)', () => {
    const token = jwt.sign({ type: 'admin', id: 'a1' }, SECRET);
    const next = jest.fn();
    const res = mockRes();
    requireCustomer(reqWithToken(token), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('calls next and attaches req.customer on a valid customer token', () => {
    const token = jwt.sign({ type: 'customer', id: 'c1', name: 'Jane' }, SECRET);
    const next = jest.fn();
    const req = reqWithToken(token);
    requireCustomer(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.customer).toMatchObject({ type: 'customer', id: 'c1' });
  });
});

describe('optionalCustomerAuth', () => {
  test('calls next without req.customer when there is no token (guest)', () => {
    const next = jest.fn();
    const req = reqWithToken();
    optionalCustomerAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.customer).toBeUndefined();
  });

  test('calls next without req.customer on an invalid token — never rejects', () => {
    const next = jest.fn();
    const req = reqWithToken('garbage');
    optionalCustomerAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.customer).toBeUndefined();
  });

  test('ignores a valid admin-type token (wrong type for this route)', () => {
    const token = jwt.sign({ type: 'admin', id: 'a1' }, SECRET);
    const next = jest.fn();
    const req = reqWithToken(token);
    optionalCustomerAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.customer).toBeUndefined();
  });

  test('attaches req.customer on a valid customer token', () => {
    const token = jwt.sign({ type: 'customer', id: 'c1' }, SECRET);
    const next = jest.fn();
    const req = reqWithToken(token);
    optionalCustomerAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.customer).toMatchObject({ id: 'c1' });
  });
});

describe('requireInternalKey', () => {
  const ORIGINAL_KEY = process.env.INTERNAL_API_KEY;
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = 'secret-internal-key';
  });
  afterEach(() => {
    process.env.INTERNAL_API_KEY = ORIGINAL_KEY;
  });

  test('401s with no key header', () => {
    const next = jest.fn();
    const res = mockRes();
    requireInternalKey({ headers: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401s with the wrong key', () => {
    const next = jest.fn();
    const res = mockRes();
    requireInternalKey({ headers: { 'x-internal-key': 'wrong' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('calls next with the correct key', () => {
    const next = jest.fn();
    requireInternalKey({ headers: { 'x-internal-key': 'secret-internal-key' } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});
