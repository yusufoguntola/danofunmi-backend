const express = require('express');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const prisma = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { uploadMenuIcon, MENU_ICONS_DIR } = require('../lib/uploads');
const { generateMenuIcon } = require('../lib/generateIcon');

const router = express.Router();

// MenuItem.category is stored as a relation, but every existing consumer
// (public menu, order builder, admin table) expects a flat `category`
// string — flatten here so the rest of the app doesn't need to change.
function flattenItem(item) {
  const { category, ...rest } = item;
  return { ...rest, category: category?.name ?? null };
}

// GET /api/menu — public, active items only
router.get('/', async (req, res) => {
  const items = await prisma.menuItem.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    include: {
      category: true,
      options: { where: { active: true }, orderBy: { price: 'asc' } },
    },
  });
  res.json(items.map(flattenItem));
});

// GET /api/menu/admin/all — admin, all items including inactive
router.get('/admin/all', requireAdmin, async (req, res) => {
  const items = await prisma.menuItem.findMany({
    orderBy: { createdAt: 'asc' },
    include: { category: true, options: true },
  });
  res.json(items.map(flattenItem));
});

// GET /api/menu/admin/categories — admin, for the category dropdown
router.get('/admin/categories', requireAdmin, async (req, res) => {
  const categories = await prisma.menuCategory.findMany({ orderBy: { name: 'asc' } });
  res.json(categories);
});

// POST /api/menu/admin/categories — create a category
router.post('/admin/categories', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const category = await prisma.menuCategory.create({ data: { name } });
    res.status(201).json(category);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'That category already exists' });
    throw err;
  }
});

// PATCH /api/menu/admin/categories/:id — rename a category
router.patch('/admin/categories/:id', requireAdmin, async (req, res) => {
  const { name } = req.body;
  try {
    const category = await prisma.menuCategory.update({
      where: { id: req.params.id },
      data: { name },
    });
    res.json(category);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'That category already exists' });
    if (err.code === 'P2025') return res.status(404).json({ error: 'Category not found' });
    throw err;
  }
});

// DELETE /api/menu/admin/categories/:id — remove a category (only if unused)
router.delete('/admin/categories/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.menuCategory.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Category not found' });
    if (err.code === 'P2003') {
      return res.status(409).json({ error: 'Move or delete its menu items before deleting this category.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not delete category' });
  }
});

// GET /api/menu/admin/:id — single item detail, for the edit page
router.get('/admin/:id', requireAdmin, async (req, res) => {
  const item = await prisma.menuItem.findUnique({
    where: { id: req.params.id },
    include: { category: true, options: true },
  });
  if (!item) return res.status(404).json({ error: 'Menu item not found' });
  res.json(flattenItem(item));
});

// POST /api/menu/admin/icons/upload — upload a custom icon/logo image
router.post('/admin/icons/upload', requireAdmin, uploadMenuIcon.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'An image file is required' });
  res.status(201).json({ path: `/uploads/menu-icons/${req.file.filename}` });
});

// POST /api/menu/admin/icons/generate — generate an icon with AI from a name/description
router.post('/admin/icons/generate', requireAdmin, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const buffer = await generateMenuIcon({ name, description });
    const filename = `${Date.now()}-${nanoid(8)}.jpg`;
    fs.writeFileSync(path.join(MENU_ICONS_DIR, filename), buffer);
    res.status(201).json({ path: `/uploads/menu-icons/${filename}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not generate icon' });
  }
});

// POST /api/menu/admin — create a menu item with its size/price options
router.post('/admin', requireAdmin, async (req, res) => {
  const { name, categoryId, description, icon, options } = req.body;

  if (!name || !categoryId || !Array.isArray(options) || options.length === 0) {
    return res.status(400).json({ error: 'name, categoryId, and at least one option are required' });
  }

  try {
    const item = await prisma.menuItem.create({
      data: {
        name,
        categoryId,
        description,
        icon,
        options: {
          create: options.map((o) => ({ size: o.size, price: o.price })),
        },
      },
      include: { category: true, options: true },
    });
    res.status(201).json(flattenItem(item));
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'A menu item with that name already exists' });
    if (err.code === 'P2003') return res.status(400).json({ error: 'Selected category does not exist' });
    throw err;
  }
});

// PATCH /api/menu/admin/:id — update name/category/description/icon/active
router.patch('/admin/:id', requireAdmin, async (req, res) => {
  const { name, categoryId, description, icon, active } = req.body;

  try {
    const item = await prisma.menuItem.update({
      where: { id: req.params.id },
      data: { name, categoryId, description, icon, active },
      include: { category: true, options: true },
    });
    res.json(flattenItem(item));
  } catch (err) {
    if (err.code === 'P2003') return res.status(400).json({ error: 'Selected category does not exist' });
    throw err;
  }
});

// DELETE /api/menu/admin/:id — remove a menu item entirely
router.delete('/admin/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.menuItem.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Menu item not found' });
    if (err.code === 'P2003') {
      return res.status(409).json({
        error: 'This item has already been ordered and can\'t be deleted. Set it inactive instead.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not delete menu item' });
  }
});

// POST /api/menu/admin/:id/options — add a size/price option to an item
router.post('/admin/:id/options', requireAdmin, async (req, res) => {
  const { size, price } = req.body;
  if (!size || price == null) {
    return res.status(400).json({ error: 'size and price are required' });
  }

  const option = await prisma.menuItemOption.create({
    data: { menuItemId: req.params.id, size, price },
  });

  res.status(201).json(option);
});

// PATCH /api/menu/admin/options/:optionId — update price/active on an option
router.patch('/admin/options/:optionId', requireAdmin, async (req, res) => {
  const { price, active } = req.body;

  const option = await prisma.menuItemOption.update({
    where: { id: req.params.optionId },
    data: { price, active },
  });

  res.json(option);
});

// DELETE /api/menu/admin/options/:optionId — remove a single size/price option
router.delete('/admin/options/:optionId', requireAdmin, async (req, res) => {
  try {
    await prisma.menuItemOption.delete({ where: { id: req.params.optionId } });
    res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Option not found' });
    if (err.code === 'P2003') {
      return res.status(409).json({
        error: 'This size has already been ordered and can\'t be deleted. Set it inactive instead.',
      });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not delete option' });
  }
});

module.exports = router;
