const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(requireAdmin);

// GET /api/admin/costs?from=&to=
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  const where = {};
  if (from || to) {
    where.incurredOn = {};
    if (from) where.incurredOn.gte = new Date(from);
    if (to) where.incurredOn.lte = new Date(to);
  }

  const costs = await prisma.costEntry.findMany({
    where,
    orderBy: { incurredOn: 'desc' },
    include: { createdBy: { select: { name: true, email: true } } },
  });
  res.json(costs);
});

// POST /api/admin/costs
router.post('/', async (req, res) => {
  const { description, category, amount, incurredOn } = req.body;
  if (!description || !category || amount == null || !incurredOn) {
    return res.status(400).json({ error: 'description, category, amount, and incurredOn are required' });
  }

  const cost = await prisma.costEntry.create({
    data: {
      description,
      category,
      amount,
      incurredOn: new Date(incurredOn),
      createdById: req.admin.id,
    },
  });
  res.status(201).json(cost);
});

// PATCH /api/admin/costs/:id
router.patch('/:id', async (req, res) => {
  const { description, category, amount, incurredOn } = req.body;
  const cost = await prisma.costEntry.update({
    where: { id: req.params.id },
    data: {
      description,
      category,
      amount,
      incurredOn: incurredOn ? new Date(incurredOn) : undefined,
    },
  });
  res.json(cost);
});

// DELETE /api/admin/costs/:id
router.delete('/:id', async (req, res) => {
  await prisma.costEntry.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

module.exports = router;
