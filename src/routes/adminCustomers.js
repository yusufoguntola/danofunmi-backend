const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// GET /api/admin/customers — every customer, newest first, with just enough
// summary (order count + lifetime spend) for the list view — full order/
// feedback/request history lives behind GET /:id instead of bloating this.
router.get('/', async (req, res) => {
  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: 'desc' },
    include: { orders: { select: { total: true } } },
  });

  res.json(
    customers.map(({ orders, ...customer }) => ({
      ...customer,
      orderCount: orders.length,
      totalSpent: orders.reduce((sum, o) => sum + Number(o.total), 0),
    }))
  );
});

// GET /api/admin/customers/:id — a customer's full footprint on the
// platform: every order (with items/receipts/location — the transaction
// history), feedback left on those orders, chat requests logged against
// them, and — matched by phone, since WhatsappMessageLog has no formal
// customer relation — their WhatsApp message history, if any.
router.get('/:id', async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const [orders, feedback, requests, whatsappMessages] = await Promise.all([
    prisma.order.findMany({
      where: { customerId: customer.id },
      include: { items: true, receipts: true, location: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.feedback.findMany({
      where: { order: { customerId: customer.id }, deletedAt: null },
      include: { order: { select: { narration: true, orderNumber: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.extraneousRequest.findMany({
      where: { customerId: customer.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    }),
    customer.phone
      ? prisma.whatsappMessageLog.findMany({
          where: { fromPhone: customer.phone },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      : [],
  ]);

  res.json({ customer, orders, feedback, requests, whatsappMessages });
});

module.exports = router;
