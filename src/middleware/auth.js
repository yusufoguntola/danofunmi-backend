const jwt = require('jsonwebtoken');

function extractToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function requireAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing admin token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'admin') throw new Error('not an admin token');
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireCustomer(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing customer token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'customer') throw new Error('not a customer token');
    req.customer = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Decodes a customer token if one is present and valid, but never rejects —
// for routes guests must still be able to hit (order creation, chat), where
// being signed in just links the result to an account instead of upserting
// by phone.
function optionalCustomerAuth(req, res, next) {
  const token = extractToken(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.type === 'customer') req.customer = decoded;
    } catch {
      // ignore — treat as a guest
    }
  }
  next();
}

function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Invalid internal key' });
  }
  next();
}

module.exports = { requireAdmin, requireCustomer, optionalCustomerAuth, requireInternalKey };
