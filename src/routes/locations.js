const express = require('express');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/locations — public, active only, for the order form
router.get('/', async (req, res) => {
  const locations = await prisma.location.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
  });
  res.json(locations);
});

// GET /api/admin/locations — admin, all locations
router.get('/admin/all', requireAdmin, async (req, res) => {
  const locations = await prisma.location.findMany({ orderBy: { name: 'asc' } });
  res.json(locations);
});

// POST /api/admin/locations — create a location with its logistics fee
router.post('/admin', requireAdmin, async (req, res) => {
  const { name, logisticsFee } = req.body;
  if (!name || logisticsFee == null) {
    return res.status(400).json({ error: 'name and logisticsFee are required' });
  }

  const location = await prisma.location.create({ data: { name, logisticsFee } });
  res.status(201).json(location);
});

// PATCH /api/admin/locations/:id — update fee / name / active
router.patch('/admin/:id', requireAdmin, async (req, res) => {
  const { name, logisticsFee, active } = req.body;

  const location = await prisma.location.update({
    where: { id: req.params.id },
    data: { name, logisticsFee, active },
  });

  res.json(location);
});

module.exports = router;
