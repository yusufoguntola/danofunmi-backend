jest.mock('../../src/db', () => ({
  menuItem: { findMany: jest.fn() },
  menuGroup: { findMany: jest.fn() },
}));

const prisma = require('../../src/db');
const { computeDiscountAmount, shapeGroup, listActiveItems, listActiveGroups, getCatalog } = require('../../src/lib/menuCatalog');

describe('computeDiscountAmount', () => {
  test('no discount configured → 0', () => {
    expect(computeDiscountAmount({ discountType: null, discountValue: null }, 10000)).toBe(0);
    expect(computeDiscountAmount({ discountType: 'FLAT', discountValue: null }, 10000)).toBe(0);
  });

  test('PERCENTAGE discount', () => {
    expect(computeDiscountAmount({ discountType: 'PERCENTAGE', discountValue: 10 }, 10000)).toBe(1000);
    expect(computeDiscountAmount({ discountType: 'PERCENTAGE', discountValue: 50 }, 2000)).toBe(1000);
  });

  test('FLAT discount', () => {
    expect(computeDiscountAmount({ discountType: 'FLAT', discountValue: 500 }, 10000)).toBe(500);
  });

  test('clamps to the gross total — a discount can never make a line negative', () => {
    expect(computeDiscountAmount({ discountType: 'FLAT', discountValue: 99999 }, 1000)).toBe(1000);
    expect(computeDiscountAmount({ discountType: 'PERCENTAGE', discountValue: 200 }, 1000)).toBe(1000);
  });

  test('clamps to 0 — a (malformed) negative discount never increases the price', () => {
    expect(computeDiscountAmount({ discountType: 'FLAT', discountValue: -500 }, 1000)).toBe(0);
  });
});

const RAW_GROUP = {
  id: 'grp1',
  name: 'Family Combo',
  categoryId: 'cat1',
  category: { name: 'Combos' },
  description: 'A combo',
  icon: '🍲',
  active: true,
  discountType: 'FLAT',
  discountValue: 500,
  items: [
    {
      id: 'gi1',
      menuItemOptionId: 'opt1',
      quantity: 1,
      isBonus: false,
      menuItemOption: { menuItemId: 'item1', size: '5L', price: 20000, menuItem: { name: 'Buka Stew', icon: '🍛' } },
    },
    {
      id: 'gi2',
      menuItemOptionId: 'opt2',
      quantity: 1,
      isBonus: true,
      menuItemOption: { menuItemId: 'item2', size: '1L', price: 3000, menuItem: { name: 'Ewedu', icon: '🥬' } },
    },
  ],
};

describe('shapeGroup', () => {
  test('shapes items, computes grossTotal/discount/total — bonus items excluded from gross', () => {
    const shaped = shapeGroup(RAW_GROUP);

    expect(shaped).toMatchObject({
      id: 'grp1',
      type: 'group',
      name: 'Family Combo',
      category: 'Combos',
      grossTotal: 20000,
      discount: { type: 'FLAT', value: 500, amount: 500 },
      total: 19500,
    });
    expect(shaped.items).toHaveLength(2);
    expect(shaped.items[0]).toMatchObject({ name: 'Buka Stew', unitPrice: 20000, isBonus: false });
    expect(shaped.items[1]).toMatchObject({ name: 'Ewedu', unitPrice: 3000, isBonus: true });
  });

  test('discount is null when no discountType is set', () => {
    const shaped = shapeGroup({ ...RAW_GROUP, discountType: null, discountValue: null });
    expect(shaped.discount).toBeNull();
    expect(shaped.total).toBe(shaped.grossTotal);
  });

  test('category is null when the group has no category relation', () => {
    const shaped = shapeGroup({ ...RAW_GROUP, category: null });
    expect(shaped.category).toBeNull();
  });
});

describe('listActiveItems', () => {
  beforeEach(() => jest.clearAllMocks());

  test('queries active, non-catalog-hidden items (any category), catalog-shapes them', async () => {
    prisma.menuItem.findMany.mockResolvedValue([
      {
        id: 'item1',
        name: 'Buka Stew',
        category: { name: 'Soups' },
        description: 'desc',
        icon: '🍛',
        options: [{ id: 'opt1', size: '1L', price: 5000 }],
      },
    ]);

    const items = await listActiveItems();

    expect(prisma.menuItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true, hiddenFromCatalog: false },
      })
    );
    expect(items).toEqual([
      {
        id: 'item1',
        type: 'item',
        name: 'Buka Stew',
        category: 'Soups',
        description: 'desc',
        icon: '🍛',
        options: [{ id: 'opt1', size: '1L', price: 5000 }],
      },
    ]);
  });

  test('category is null when an item has no category', async () => {
    prisma.menuItem.findMany.mockResolvedValue([{ id: 'item1', name: 'X', category: null, options: [] }]);
    const [item] = await listActiveItems();
    expect(item.category).toBeNull();
  });
});

describe('listActiveGroups', () => {
  beforeEach(() => jest.clearAllMocks());

  test('queries active groups (any category), shapes them', async () => {
    prisma.menuGroup.findMany.mockResolvedValue([RAW_GROUP]);
    const groups = await listActiveGroups();

    expect(prisma.menuGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } })
    );
    expect(groups).toEqual([shapeGroup(RAW_GROUP)]);
  });
});

describe('getCatalog', () => {
  beforeEach(() => jest.clearAllMocks());

  test('merges active items and groups into one list', async () => {
    prisma.menuItem.findMany.mockResolvedValue([
      { id: 'item1', name: 'Buka Stew', category: { name: 'Soups' }, options: [] },
    ]);
    prisma.menuGroup.findMany.mockResolvedValue([RAW_GROUP]);

    const catalog = await getCatalog();

    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({ type: 'item', name: 'Buka Stew' });
    expect(catalog[1]).toMatchObject({ type: 'group', name: 'Family Combo' });
  });
});
