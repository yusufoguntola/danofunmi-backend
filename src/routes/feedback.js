const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(requireAdmin);

// GET /api/admin/feedback — admin, all (non-deleted) feedback newest first
router.get('/', async (req, res) => {
  const feedback = await prisma.feedback.findMany({
    where: { deletedAt: null },
    include: { order: { include: { customer: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(feedback);
});

// DELETE /api/admin/feedback/:id — soft-delete: the row stays in the DB, just
// hidden from the admin list and the public landing-page testimonials from
// here on.
router.delete('/:id', async (req, res) => {
  try {
    await prisma.feedback.update({
      where: { id: req.params.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Feedback not found' });
    throw err;
  }
});

// PATCH /api/admin/feedback/:id — toggle whether this feedback shows up in
// the public landing-page testimonials, without soft-deleting it (it stays
// visible in the admin list either way).
router.patch('/:id', async (req, res) => {
  try {
    const feedback = await prisma.feedback.update({
      where: { id: req.params.id, deletedAt: null },
      data: { visibleOnLanding: !!req.body.visibleOnLanding },
    });
    res.json(feedback);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Feedback not found' });
    throw err;
  }
});

module.exports = router;
