const express = require('express');
const prisma = require('../db');
const { requireInternalKey } = require('../middleware/auth');
const { uploadReceipt } = require('../lib/uploads');
const { createOrderRecord, OrderValidationError } = require('../lib/orderCreation');

// Endpoints called by the whatsapp-bot service (never exposed to browsers).
// Protected by a shared secret (INTERNAL_API_KEY) rather than admin login,
// since the bot acts on behalf of whichever customer is chatting with it.
const router = express.Router();

router.use(requireInternalKey);

// POST /api/internal/orders — bot creates an order from a chat conversation
router.post('/orders', async (req, res) => {
  try {
    const order = await createOrderRecord({ ...req.body, source: 'WHATSAPP' });
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

// POST /api/internal/orders/:id/receipt — bot forwards a receipt image
router.post('/orders/:id/receipt', uploadReceipt.single('receipt'), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!req.file) return res.status(400).json({ error: 'A receipt image is required' });

  const [receipt] = await prisma.$transaction([
    prisma.paymentReceipt.create({
      data: {
        orderId: order.id,
        imagePath: `/uploads/receipts/${req.file.filename}`,
        submittedVia: 'WHATSAPP',
      },
    }),
    prisma.order.update({ where: { id: order.id }, data: { status: 'PAYMENT_SUBMITTED' } }),
  ]);

  res.status(201).json(receipt);
});

// GET /api/internal/orders/by-phone/:phone — bot looks up a customer's recent orders
router.get('/orders/by-phone/:phone', async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { phone: req.params.phone } });
  if (!customer) return res.json([]);

  const orders = await prisma.order.findMany({
    where: { customerId: customer.id },
    include: { items: true, location: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  res.json(orders);
});

// POST /api/internal/messages — log an inbound/outbound whatsapp message
router.post('/messages', async (req, res) => {
  const { fromPhone, direction, body, mediaPath } = req.body;
  if (!fromPhone || !direction) {
    return res.status(400).json({ error: 'fromPhone and direction are required' });
  }
  const log = await prisma.whatsappMessageLog.create({
    data: { fromPhone, direction, body, mediaPath },
  });
  res.status(201).json(log);
});

module.exports = router;
