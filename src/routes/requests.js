const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(requireAdmin);

// GET /api/admin/requests — all logged chat requests, newest first
router.get('/', async (req, res) => {
  const requests = await prisma.extraneousRequest.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(requests);
});

// GET /api/admin/requests/unread-count — for the admin nav tab badge
router.get('/unread-count', async (req, res) => {
  const count = await prisma.extraneousRequest.count({ where: { readAt: null } });
  res.json({ count });
});

// PATCH /api/admin/requests/read-all — mark every unread request as read
router.patch('/read-all', async (req, res) => {
  await prisma.extraneousRequest.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

// PATCH /api/admin/requests/:id — mark a single request read/unread
router.patch('/:id', async (req, res) => {
  const { read } = req.body;
  try {
    const request = await prisma.extraneousRequest.update({
      where: { id: req.params.id },
      data: { readAt: read === false ? null : new Date() },
    });
    res.json(request);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Request not found' });
    throw err;
  }
});

module.exports = router;
