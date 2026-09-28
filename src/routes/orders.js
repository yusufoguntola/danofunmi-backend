const express = require('express');
const prisma = require('../db');
const { requireAdmin, optionalCustomerAuth } = require('../middleware/auth');
const { orderLookupRateLimit, requireBrowserOrigin } = require('../middleware/security');
const { requireRecaptcha } = require('../lib/recaptcha');
const { uploadReceipt } = require('../lib/uploads');
const { createOrderRecord, OrderValidationError } = require('../lib/orderCreation');
const { notifyOrderStatusChange } = require('../lib/orderNotifications');

const router = express.Router();

const orderIncludes = {
  customer: true,
  location: true,
  items: true,
  receipts: { orderBy: { createdAt: 'desc' } },
};

// POST /api/orders — public, web checkout. optionalCustomerAuth links the
// order to a signed-in account instead of the guest phone-upsert, if present.
router.post('/', requireBrowserOrigin, requireRecaptcha(), optionalCustomerAuth, async (req, res) => {
  try {
    const order = await createOrderRecord({
      ...req.body,
      source: 'WEB',
      authenticatedCustomerId: req.customer?.id,
    });
    res.status(201).json({
      order,
      payment: {
        bankName: process.env.BANK_NAME,
        accountName: process.env.BANK_ACCOUNT_NAME,
        accountNumber: process.env.BANK_ACCOUNT_NUMBER,
        amount: order.total,
        narration: order.narration,
      },
    });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not create order' });
  }
});

// GET /api/orders/:idOrNarration — public order lookup/tracking, by internal id,
// narration (DFM-XXXXXX), or the shorter numeric order number. Extra-tight rate
// limit + browser-origin check: this is the endpoint someone would script
// against to "farm" other customers' order details by guessing IDs.
router.get('/:idOrNarration', orderLookupRateLimit, requireBrowserOrigin, async (req, res) => {
  const { idOrNarration } = req.params;
  const or = [{ id: idOrNarration }, { narration: idOrNarration }];
  if (/^\d+$/.test(idOrNarration)) or.push({ orderNumber: Number(idOrNarration) });

  const order = await prisma.order.findFirst({
    where: { OR: or },
    include: orderIncludes,
  });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// POST /api/orders/:id/receipt — public, confirm payment either by uploading a
// receipt image (multipart, field `receipt`) or by providing the sender name
// + bank a transfer was made from (JSON body). uploadReceipt.single() is a
// no-op for non-multipart requests, so both modes share this one route.
router.post('/:id/receipt', uploadReceipt.single('receipt'), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { senderName, senderBank } = req.body;
  let receiptData;
  if (req.file) {
    receiptData = { orderId: order.id, imagePath: `/uploads/receipts/${req.file.filename}`, submittedVia: 'WEB' };
  } else if (senderName?.trim() && senderBank?.trim()) {
    receiptData = { orderId: order.id, senderName: senderName.trim(), senderBank: senderBank.trim(), submittedVia: 'WEB' };
  } else {
    return res.status(400).json({ error: 'A receipt image, or a sender name and bank, is required' });
  }

  const [receipt] = await prisma.$transaction([
    prisma.paymentReceipt.create({ data: receiptData }),
    prisma.order.update({
      where: { id: order.id },
      data: { status: 'PAYMENT_SUBMITTED' },
    }),
  ]);

  res.status(201).json(receipt);
});

// GET /api/admin/orders — admin list, optional ?status= filter
router.get('/admin/all', requireAdmin, async (req, res) => {
  const { status } = req.query;
  const orders = await prisma.order.findMany({
    where: status ? { status } : undefined,
    include: orderIncludes,
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
});

// PATCH /api/admin/orders/:id/status — admin status transitions
const STATUS_TIMESTAMP_FIELD = {
  PACKED: 'packedAt',
  OUT_FOR_DELIVERY: 'outForDeliveryAt',
  DELIVERED: 'deliveredAt',
  CANCELLED: 'cancelledAt',
};

router.patch('/admin/:id/status', requireAdmin, async (req, res) => {
  const { status, riderContact } = req.body;
  const valid = [
    'PENDING_PAYMENT',
    'PAYMENT_SUBMITTED',
    'CONFIRMED',
    'PACKED',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'CANCELLED',
  ];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const data = { status };
  const timestampField = STATUS_TIMESTAMP_FIELD[status];
  if (timestampField) data[timestampField] = new Date();
  // Optional, only meaningful alongside the move to OUT_FOR_DELIVERY — but
  // accepted whenever sent so admin can also correct it later via the same
  // endpoint (e.g. a status re-save) without a dedicated route.
  if (riderContact !== undefined) data.riderContact = riderContact ? String(riderContact).trim() || null : null;

  const order = await prisma.order.update({
    where: { id: req.params.id },
    data,
    include: orderIncludes,
  });

  notifyOrderStatusChange(order);

  res.json(order);
});

// PATCH /api/admin/orders/:id/location — admin correcting the delivery
// location on an order (e.g. one picked hastily when creating a first-taste
// order — see lib/firstTaste.js). Recomputes logisticsFee/total from the new
// location; item lines and subtotal are untouched. Blocked once the order is
// DELIVERED or CANCELLED — by then the fee has already counted toward
// revenue (see reports.js's REVENUE_STATUSES) and shouldn't be rewritten
// after the fact.
router.patch('/admin/:id/location', requireAdmin, async (req, res, next) => {
  try {
    const { locationId } = req.body;
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });

    const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Order not found' });
    if (['DELIVERED', 'CANCELLED'].includes(existing.status)) {
      return res.status(400).json({ error: 'Cannot change the location of a delivered or cancelled order.' });
    }

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location || !location.active) {
      return res.status(400).json({ error: 'Selected location is not available' });
    }

    const logisticsFee = Number(location.logisticsFee);
    const total = Number(existing.subtotal) + logisticsFee;

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { locationId, logisticsFee, total },
      include: orderIncludes,
    });

    res.json(order);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/orders/:id/receipts/:receiptId — confirm/reject a receipt
router.patch('/admin/:id/receipts/:receiptId', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['CONFIRMED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'status must be CONFIRMED or REJECTED' });
  }

  const receipt = await prisma.paymentReceipt.update({
    where: { id: req.params.receiptId },
    data: { status, confirmedBy: req.admin.email, confirmedAt: new Date() },
  });

  if (status === 'CONFIRMED') {
    await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'CONFIRMED' },
    });
  }

  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: orderIncludes,
  });
  if (order) {
    notifyOrderStatusChange(order, {
      body:
        status === 'CONFIRMED'
          ? 'Payment confirmed!'
          : "Your receipt couldn't be verified — please upload a clearer copy.",
    });
  }

  res.json(receipt);
});

module.exports = router;
