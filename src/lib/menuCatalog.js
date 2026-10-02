const prisma = require('../db');

// A MenuItem/MenuGroup `icon` is either an emoji/text glyph or a real
// uploaded/generated photo (see routes/menu.js's icon upload/generate
// endpoints) — mirrors frontend/src/components/MenuIcon.jsx's own copy of
// this pattern, which can't share code across the frontend/backend split.
const IMAGE_ICON_RE = /^(\/uploads\/|https?:\/\/)/;

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

/** Active menu items, catalog-shaped with an explicit `type: 'item'`. Any
 * category can now freely mix public and admin-only items — an item opts
 * out of the public catalog/AI chat individually via `hiddenFromCatalog`
 * (e.g. the free "First Taste" item — see lib/firstTaste.js), not by which
 * category it's filed under. */
async function listActiveItems() {
  const items = await prisma.menuItem.findMany({
    where: { active: true, hiddenFromCatalog: false },
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
    where: { active: true },
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

/** Active menu items that have a real photo (not just an emoji glyph) —
 * used anywhere a feature needs genuine food photography rather than the
 * full catalog, e.g. the go-live announcement email/status card (see
 * lib/email.js's sendGoLiveEmail). Ordered by creation so results stay
 * stable between calls; capped at `limit`. */
async function listPhotoItems(limit = 4) {
  const items = await listActiveItems();
  return items.filter((item) => IMAGE_ICON_RE.test(item.icon || '')).slice(0, limit);
}

module.exports = {
  getCatalog,
  listActiveItems,
  listActiveGroups,
  listPhotoItems,
  shapeGroup,
  computeDiscountAmount,
  IMAGE_ICON_RE,
};
