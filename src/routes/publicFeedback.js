const express = require('express');
const prisma = require('../db');

const router = express.Router();

// Only the customer's first name is ever exposed here — never contact details.
function firstName(full) {
  const first = String(full || '').trim().split(/\s+/)[0];
  if (!first) return 'A customer';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// GET /api/feedback — public. The most recent feedback that carries a written
// comment, for the landing page "what customers say" section. Ratings-only
// feedback (no comment) is left for the admin dashboard.
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.feedback.findMany({
      where: { comment: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { order: { select: { customer: { select: { name: true } } } } },
    });

    const items = rows
      .filter((f) => f.comment && f.comment.trim().length > 0)
      .slice(0, 12)
      .map((f) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment.trim(),
        createdAt: f.createdAt,
        name: firstName(f.order?.customer?.name),
      }));

    res.json(items);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
