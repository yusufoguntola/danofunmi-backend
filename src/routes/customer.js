const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const prisma = require('../db');
const { requireCustomer } = require('../middleware/auth');
const { authRateLimit, requireBrowserOrigin } = require('../middleware/security');
const { requireRecaptcha } = require('../lib/recaptcha');

const router = express.Router();
router.use(requireBrowserOrigin);

const orderIncludes = {
  location: true,
  items: true,
  receipts: { orderBy: { createdAt: 'desc' } },
};

function signCustomerToken(customer) {
  return jwt.sign(
    { type: 'customer', id: customer.id, name: customer.name, email: customer.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function publicCustomer(customer) {
  return { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone };
}

// POST /api/customer/signup — no email/phone verification, per product decision
router.post('/signup', authRateLimit, requireRecaptcha(), async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: 'name, email, phone, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const byEmail = await prisma.customer.findUnique({ where: { email } });
  if (byEmail) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // A phone that already has guest orders under it gets upgraded into a real
  // account instead of failing — those past orders show up immediately.
  const byPhone = await prisma.customer.findUnique({ where: { phone } });
  let customer;
  if (byPhone) {
    if (byPhone.passwordHash || byPhone.googleId) {
      return res.status(409).json({ error: 'An account with that phone number already exists' });
    }
    customer = await prisma.customer.update({
      where: { id: byPhone.id },
      data: { name, email, passwordHash },
    });
  } else {
    customer = await prisma.customer.create({ data: { name, email, phone, passwordHash } });
  }

  res.status(201).json({ token: signCustomerToken(customer), customer: publicCustomer(customer) });
});

// POST /api/customer/login — identifier is email or phone
router.post('/login', authRateLimit, requireRecaptcha(), async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'identifier and password are required' });
  }

  const customer = await prisma.customer.findFirst({
    where: { OR: [{ email: identifier }, { phone: identifier }] },
  });
  if (!customer || !customer.passwordHash) {
    return res.status(401).json({
      error: customer ? 'This account signs in with Google' : 'Invalid credentials',
    });
  }

  const valid = await bcrypt.compare(password, customer.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({ token: signCustomerToken(customer), customer: publicCustomer(customer) });
});

// POST /api/customer/google — body { credential } is the Google ID token
router.post('/google', authRateLimit, async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: "Google sign-in isn't configured yet." });
  }

  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'credential is required' });
  }

  let payload;
  try {
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Could not verify Google sign-in' });
  }

  const { sub: googleId, email, name } = payload;

  let customer = await prisma.customer.findUnique({ where: { googleId } });
  if (!customer) {
    customer = await prisma.customer.findUnique({ where: { email } });
    if (customer) {
      customer = await prisma.customer.update({ where: { id: customer.id }, data: { googleId } });
    } else {
      customer = await prisma.customer.create({ data: { name: name || email, email, googleId } });
    }
  }

  res.json({ token: signCustomerToken(customer), customer: publicCustomer(customer) });
});

// GET /api/customer/orders — this device's signed-in account's order history
router.get('/orders', requireCustomer, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { customerId: req.customer.id },
    include: orderIncludes,
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
});

module.exports = router;
