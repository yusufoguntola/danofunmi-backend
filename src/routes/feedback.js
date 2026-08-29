const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(requireAdmin);

// GET /api/admin/feedback — admin, all feedback newest first
router.get('/', async (req, res) => {
  const feedback = await prisma.feedback.findMany({
    include: { order: { include: { customer: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(feedback);
});

module.exports = router;
