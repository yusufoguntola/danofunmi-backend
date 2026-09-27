const prisma = require('../db');

// Categories that exist for internal/admin-triggered orders only (e.g. the
// free "First Taste" item created for shortlisted interest registrations,
// see lib/firstTaste.js) and must never appear in the public catalog or the
// AI ordering chat's menu awareness — customers can't add them to a cart
// themselves.
const HIDDEN_CATEGORIES = ['Promotions'];

/** Discount amount for a group given its gross (pre-discount) total, clamped to [0, gross]. */
function computeDiscountAmount(group, gross) {
  if (!group.discountType || group.discountValue == null) return 0;
  const value = Number(group.discountValue);
  const raw = group.discountType === 'PERCENTAGE' ? gross * (value / 100) : value;
  return Math.min(Math.max(raw, 0), gross);
}

/** Shapes one MenuGroup (with items -> menuItemOption -> menuItem included) into its public/catalog form. */
function shapeGroup(group) {
  const items = group.items.map((gi) => ({
    id: gi.id,
    menuItemOptionId: gi.menuItemOptionId,
    menuItemId: gi.menuItemOption.menuItemId,
    name: gi.menuItemOption.menuItem.name,
    icon: gi.menuItemOption.menuItem.icon,
    size: gi.menuItemOption.size,
    unitPrice: Number(gi.menuItemOption.price),
    quantity: gi.quantity,
    isBonus: gi.isBonus,
  }));
  const gross = items
    .filter((i) => !i.isBonus)
    .reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const discountAmount = computeDiscountAmount(group, gross);
  const total = gross - discountAmount;

  return {
    id: group.id,
    type: 'group',
    name: group.name,
    categoryId: group.categoryId,
    category: group.category?.name ?? null,
    description: group.description,
    icon: group.icon,
    active: group.active,
    items,
    grossTotal: gross,
    discount: group.discountType
      ? { type: group.discountType, value: Number(group.discountValue), amount: discountAmount }
      : null,
    total,
  };
}

/** Active menu items, catalog-shaped with an explicit `type: 'item'`. */
async function listActiveItems() {
  const items = await prisma.menuItem.findMany({
    where: { active: true, category: { name: { notIn: HIDDEN_CATEGORIES } } },
    orderBy: { createdAt: 'asc' },
    include: {
      category: true,
      options: { where: { active: true }, orderBy: { price: 'asc' } },
    },
  });
  return items.map((item) => ({
    id: item.id,
    type: 'item',
    name: item.name,
    category: item.category?.name ?? null,
    description: item.description,
    icon: item.icon,
    options: item.options.map((o) => ({ id: o.id, size: o.size, price: Number(o.price) })),
  }));
}

/** Active menu groups (combos), catalog-shaped with computed totals. */
async function listActiveGroups() {
  const groups = await prisma.menuGroup.findMany({
    where: { active: true, category: { name: { notIn: HIDDEN_CATEGORIES } } },
    orderBy: { createdAt: 'asc' },
    include: {
      category: true,
      items: { include: { menuItemOption: { include: { menuItem: true } } } },
    },
  });
  return groups.map(shapeGroup);
}

/** The full public catalog — active items and groups, merged into one list for menu browsing/chat. */
async function getCatalog() {
  const [items, groups] = await Promise.all([listActiveItems(), listActiveGroups()]);
  return [...items, ...groups];
}

module.exports = { getCatalog, listActiveItems, listActiveGroups, shapeGroup, computeDiscountAmount, HIDDEN_CATEGORIES };
