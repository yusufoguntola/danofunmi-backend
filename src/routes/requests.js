const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { suggestItemsFromMessage, ChatNotConfiguredError } = require('../lib/requestItemSuggester');
const { createAdminCustomOrder, OrderValidationError } = require('../lib/orderCreation');

const router = express.Router();

router.use(requireAdmin);

// GET /api/admin/requests — all (non-deleted) logged chat requests, newest first
router.get('/', async (req, res) => {
  const requests = await prisma.extraneousRequest.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  res.json(requests);
});

// GET /api/admin/requests/unread-count — for the admin nav tab badge
router.get('/unread-count', async (req, res) => {
  const count = await prisma.extraneousRequest.count({ where: { readAt: null, deletedAt: null } });
  res.json({ count });
});

// PATCH /api/admin/requests/read-all — mark every unread request as read
router.patch('/read-all', async (req, res) => {
  await prisma.extraneousRequest.updateMany({
    where: { readAt: null, deletedAt: null },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});

// PATCH /api/admin/requests/:id — mark a single request read/unread
router.patch('/:id', async (req, res) => {
  const { read } = req.body;
  try {
    const request = await prisma.extraneousRequest.update({
      where: { id: req.params.id, deletedAt: null },
      data: { readAt: read === false ? null : new Date() },
    });
    res.json(request);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Request not found' });
    throw err;
  }
});

// POST /api/admin/requests/:id/suggest-items — best-effort AI guess at the
// line items behind this request's free-text message, for pre-filling the
// "Create order" modal. Admin always reviews/edits before saving.
router.post('/:id/suggest-items', async (req, res) => {
  const request = await prisma.extraneousRequest.findUnique({ where: { id: req.params.id, deletedAt: null } });
  if (!request) return res.status(404).json({ error: 'Request not found' });

  try {
    const items = await suggestItemsFromMessage(request.message);
    res.json({ items });
  } catch (err) {
    if (err instanceof ChatNotConfiguredError) {
      return res.status(503).json({ error: 'AI item suggestions are not set up on this server.' });
    }
    throw err;
  }
});

// POST /api/admin/requests/:id/create-order — turns this request into a real
// order after a follow-up conversation with the customer (call/WhatsApp —
// see the request's own detail actions). Items/total are exactly what the
// admin entered in the "Create order" modal, not re-priced from the catalog.
router.post('/:id/create-order', async (req, res) => {
  const request = await prisma.extraneousRequest.findUnique({ where: { id: req.params.id, deletedAt: null } });
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.orderId) return res.status(400).json({ error: 'An order has already been created from this request.' });

  try {
    const order = await createAdminCustomOrder({ ...req.body, source: request.source });
    await prisma.extraneousRequest.update({ where: { id: request.id }, data: { orderId: order.id } });
    res.status(201).json(order);
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// DELETE /api/admin/requests/:id — soft-delete: kept in the DB, just hidden
// from admin's list/count/actions from here on.
router.delete('/:id', async (req, res) => {
  try {
    await prisma.extraneousRequest.update({
      where: { id: req.params.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Request not found' });
    throw err;
  }
});

module.exports = router;
