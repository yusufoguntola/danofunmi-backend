const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// GET /api/admin/error-logs — most recent first, capped so a bad afternoon
// doesn't ship megabytes of stack traces to the browser.
router.get('/', async (req, res) => {
  const logs = await prisma.errorLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(logs);
});

// DELETE /api/admin/error-logs/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.errorLog.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Error log not found' });
    throw err;
  }
});

// DELETE /api/admin/error-logs — clear everything, once reviewed.
router.delete('/', async (req, res) => {
  await prisma.errorLog.deleteMany({});
  res.json({ ok: true });
});

module.exports = router;
