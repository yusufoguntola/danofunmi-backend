// priceItems/createAdminCustomOrder talk to the DB via ../db (a shared
// PrismaClient instance) — mocked here so these are true unit tests of the
// pricing/validation logic, never touching a real database.
jest.mock('../../src/db', () => ({
  menuItemOption: { findMany: jest.fn() },
  menuGroup: { findMany: jest.fn() },
  customer: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  location: { findUnique: jest.fn() },
  order: { create: jest.fn(), updateMany: jest.fn() },
}));

const prisma = require('../../src/db');
const { priceItems, createOrderRecord, createAdminCustomOrder, OrderValidationError } = require('../../src/lib/orderCreation');

const BUKA_STEW_OPTION = {
  id: 'opt-buka-5l',
  price: 20000,
  active: true,
  size: '5L',
  menuItemId: 'item-buka',
  menuItem: { id: 'item-buka', name: 'Buka Stew', active: true },
};

const INACTIVE_OPTION = {
  id: 'opt-discontinued',
  price: 5000,
  active: false,
  size: '1L',
  menuItemId: 'item-discontinued',
  menuItem: { id: 'item-discontinued', name: 'Discontinued Soup', active: true },
};

const FAMILY_COMBO_GROUP = {
  id: 'grp-family',
  name: 'Family Combo',
  active: true,
  discountType: 'FLAT',
  discountValue: 500,
  items: [
    {
      menuItemOptionId: 'opt-buka-5l',
      quantity: 1,
      isBonus: false,
      menuItemOption: BUKA_STEW_OPTION,
    },
    {
      menuItemOptionId: 'opt-ewedu-1l',
      quantity: 1,
      isBonus: true, // free bonus item — never counted toward the gross total
      menuItemOption: {
        id: 'opt-ewedu-1l',
        price: 3000,
        active: true,
        size: '1L',
        menuItemId: 'item-ewedu',
        menuItem: { id: 'item-ewedu', name: 'Ewedu', active: true },
      },
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('priceItems', () => {
  test('rejects an empty/missing items array', async () => {
    await expect(priceItems([])).rejects.toBeInstanceOf(OrderValidationError);
    await expect(priceItems(undefined)).rejects.toBeInstanceOf(OrderValidationError);
  });

  test('rejects a line with neither or both of menuItemOptionId/menuGroupId', async () => {
    await expect(priceItems([{ quantity: 1 }])).rejects.toThrow(
      'Each item needs exactly one of menuItemOptionId or menuGroupId'
    );
    await expect(
      priceItems([{ menuItemOptionId: 'a', menuGroupId: 'b', quantity: 1 }])
    ).rejects.toThrow('Each item needs exactly one of menuItemOptionId or menuGroupId');
  });

  test('rejects a non-positive or fractional quantity', async () => {
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    await expect(priceItems([{ menuItemOptionId: 'opt-buka-5l', quantity: 0 }])).rejects.toThrow(
      'Quantity must be a positive integer'
    );
    await expect(priceItems([{ menuItemOptionId: 'opt-buka-5l', quantity: 1.5 }])).rejects.toThrow(
      'Quantity must be a positive integer'
    );
  });

  test('prices an individual item line from the DB, never the caller', async () => {
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);

    const { lineItems, subtotal } = await priceItems([{ menuItemOptionId: 'opt-buka-5l', quantity: 2 }]);

    expect(subtotal).toBe(40000);
    expect(lineItems).toEqual([
      {
        menuItemId: 'item-buka',
        menuItemOptionId: 'opt-buka-5l',
        menuGroupId: null,
        itemName: 'Buka Stew',
        size: '5L',
        unitPrice: 20000,
        quantity: 2,
        lineTotal: 40000,
      },
    ]);
  });

  test('rejects an option that no longer exists or is inactive', async () => {
    prisma.menuItemOption.findMany.mockResolvedValue([]);
    await expect(priceItems([{ menuItemOptionId: 'opt-gone', quantity: 1 }])).rejects.toThrow(
      'Menu option opt-gone is not available'
    );

    prisma.menuItemOption.findMany.mockResolvedValue([INACTIVE_OPTION]);
    await expect(priceItems([{ menuItemOptionId: 'opt-discontinued', quantity: 1 }])).rejects.toThrow(
      'not available'
    );
  });

  test('prices a combo: discount applied, bonus item excluded from the total, quantity = number of bundles', async () => {
    prisma.menuGroup.findMany.mockResolvedValue([FAMILY_COMBO_GROUP]);

    const { lineItems, subtotal } = await priceItems([{ menuGroupId: 'grp-family', quantity: 2 }]);

    // gross = 20000 (Buka Stew only — the Ewedu bonus line is free and
    // excluded), minus the flat 500 discount = 19500 per bundle.
    expect(lineItems[0].unitPrice).toBe(19500);
    expect(lineItems[0].lineTotal).toBe(39000); // 2 bundles
    expect(subtotal).toBe(39000);
    expect(lineItems[0].groupSnapshot.items.find((i) => i.isBonus).name).toBe('Ewedu');
  });

  test('rejects a combo that is no longer active', async () => {
    prisma.menuGroup.findMany.mockResolvedValue([{ ...FAMILY_COMBO_GROUP, active: false }]);
    await expect(priceItems([{ menuGroupId: 'grp-family', quantity: 1 }])).rejects.toThrow(
      'That combo is not available'
    );
  });
});

describe('createAdminCustomOrder', () => {
  test('requires the basic customer/delivery fields', async () => {
    await expect(createAdminCustomOrder({})).rejects.toThrow(
      'customerName, customerPhone, deliveryAddress, and locationId are required'
    );
  });

  test('requires at least one item', async () => {
    await expect(
      createAdminCustomOrder({
        customerName: 'A',
        customerPhone: '08012345678',
        deliveryAddress: 'addr',
        locationId: 'loc1',
        items: [],
      })
    ).rejects.toThrow('At least one order item is required');
  });

  test('never looks up the catalog — stores exactly what the admin typed, never repriced', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: null, landmark: null });
    prisma.customer.update.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createAdminCustomOrder({
      customerName: 'Bulk Buyer',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ itemName: 'Custom Jollof', size: 'Large pot', quantity: 2, unitPrice: 15000 }],
      total: 35000, // the actual quote — deliberately not subtotal(30000) + fee(1000)
    });

    expect(prisma.menuItemOption.findMany).not.toHaveBeenCalled();
    expect(prisma.menuGroup.findMany).not.toHaveBeenCalled();

    const createCall = prisma.order.create.mock.calls[0][0];
    expect(createCall.data.subtotal).toBe(30000);
    expect(createCall.data.total).toBe(35000); // the admin's own figure wins
    expect(createCall.data.items.create[0]).toMatchObject({
      itemName: 'Custom Jollof',
      size: 'Large pot',
      unitPrice: 15000,
      quantity: 2,
      lineTotal: 30000,
      menuItemId: null,
      menuItemOptionId: null,
      menuGroupId: null,
    });
  });

  test('defaults the total to subtotal + logistics fee when none is given', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1500 });
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: null, landmark: null });
    prisma.customer.update.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createAdminCustomOrder({
      customerName: 'Bulk Buyer',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ itemName: 'Custom Jollof', size: 'Large pot', quantity: 1, unitPrice: 10000 }],
    });

    expect(prisma.order.create.mock.calls[0][0].data.total).toBe(11500);
  });
});

describe('createOrderRecord', () => {
  test('requires the basic customer/delivery fields', async () => {
    await expect(createOrderRecord({})).rejects.toThrow(
      'customerName, customerPhone, deliveryAddress, and locationId are required'
    );
  });

  test('rejects a missing/inactive location', async () => {
    prisma.location.findUnique.mockResolvedValue(null);
    await expect(
      createOrderRecord({
        customerName: 'A',
        customerPhone: '08012345678',
        deliveryAddress: 'addr',
        locationId: 'loc1',
        items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
      })
    ).rejects.toThrow('Selected location is not available');

    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: false, logisticsFee: 1000 });
    await expect(
      createOrderRecord({
        customerName: 'A',
        customerPhone: '08012345678',
        deliveryAddress: 'addr',
        locationId: 'loc1',
        items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
      })
    ).rejects.toThrow('Selected location is not available');
  });

  test('upserts a guest customer by phone, syncs address, and creates the order', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', name: 'Old Name', address: null, landmark: null });
    prisma.customer.update.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
      source: 'WEB',
    });

    expect(prisma.customer.upsert).toHaveBeenCalledWith({
      where: { phone: '08012345678' },
      update: { name: 'Jane Doe' },
      create: { name: 'Jane Doe', phone: '08012345678' },
    });
    expect(prisma.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust1' },
      data: { address: '1 Market Rd' },
    });
    const createCall = prisma.order.create.mock.calls[0][0];
    expect(createCall.data.customerId).toBe('cust1');
    expect(createCall.data.subtotal).toBe(20000);
    expect(createCall.data.logisticsFee).toBe(1000);
    expect(createCall.data.total).toBe(21000);
    expect(createCall.data.landmark).toBeNull();
  });

  test('does not touch the customer record when address/landmark already match', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: 'Big Mall' });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      landmark: 'Big Mall',
      locationId: 'loc1',
      items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
    });

    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  test('a landmark omitted on this order never clears a previously-saved one', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: 'Old Landmark' });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
    });

    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  test('an authenticated customer is looked up by id, never re-upserted by phone', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1', phone: '08012345678', address: null, landmark: null });
    prisma.customer.update.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
      authenticatedCustomerId: 'cust1',
    });

    expect(prisma.customer.upsert).not.toHaveBeenCalled();
    expect(prisma.customer.findUnique).toHaveBeenCalledWith({ where: { id: 'cust1' } });
  });

  test('rejects an authenticated customer id that no longer exists', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.findUnique.mockResolvedValue(null);

    await expect(
      createOrderRecord({
        customerName: 'Jane Doe',
        customerPhone: '08012345678',
        deliveryAddress: '1 Market Rd',
        locationId: 'loc1',
        items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
        authenticatedCustomerId: 'ghost',
      })
    ).rejects.toThrow('Account not found');
  });

  test('backfills a missing phone onto an authenticated account, but skips silently on a phone conflict', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1', phone: null, address: '1 Market Rd', landmark: null });
    prisma.customer.update.mockRejectedValueOnce(Object.assign(new Error('unique violation'), { code: 'P2002' }));
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
      authenticatedCustomerId: 'cust1',
    });

    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'cust1' }, data: { phone: '08012345678' } });
    expect(prisma.order.create).toHaveBeenCalled(); // never threw despite the P2002
  });

  test('propagates a non-P2002 error from the phone backfill', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1', phone: null, address: '1 Market Rd', landmark: null });
    prisma.customer.update.mockRejectedValueOnce(new Error('DB is down'));

    await expect(
      createOrderRecord({
        customerName: 'Jane Doe',
        customerPhone: '08012345678',
        deliveryAddress: '1 Market Rd',
        locationId: 'loc1',
        items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
        authenticatedCustomerId: 'cust1',
      })
    ).rejects.toThrow('DB is down');
  });

  test('retries order creation on a narration/orderNumber collision (P2002), up to 5 attempts', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create
      .mockRejectedValueOnce(Object.assign(new Error('collision'), { code: 'P2002' }))
      .mockRejectedValueOnce(Object.assign(new Error('collision'), { code: 'P2002' }))
      .mockResolvedValueOnce({ id: 'order1' });

    const { orders } = await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
    });

    expect(orders).toEqual([{ id: 'order1' }]);
    expect(prisma.order.create).toHaveBeenCalledTimes(3);
    // Each retry gets a fresh narration/orderNumber, not a repeat of the failed one.
    const narrations = prisma.order.create.mock.calls.map((c) => c[0].data.narration);
    expect(new Set(narrations).size).toBe(3);
  });

  test('gives up after 5 collisions in a row', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockRejectedValue(Object.assign(new Error('collision'), { code: 'P2002' }));

    await expect(
      createOrderRecord({
        customerName: 'Jane Doe',
        customerPhone: '08012345678',
        deliveryAddress: '1 Market Rd',
        locationId: 'loc1',
        items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
      })
    ).rejects.toThrow('collision'); // the 5th attempt's own error propagates, not a generic message
    expect(prisma.order.create).toHaveBeenCalledTimes(5);
  });

  test('a non-collision error from order.create propagates immediately, without retrying', async () => {
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockRejectedValue(new Error('DB is down'));

    await expect(
      createOrderRecord({
        customerName: 'Jane Doe',
        customerPhone: '08012345678',
        deliveryAddress: '1 Market Rd',
        locationId: 'loc1',
        items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
      })
    ).rejects.toThrow('DB is down');
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
  });
});

describe('createOrderRecord — monthly schedule / splitting', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function mockNow(year, month, day) {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(year, month - 1, day));
  }

  test('an individual-only order on/before the 15th gets this month, no split', async () => {
    mockNow(2026, 10, 5);
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    const { orders } = await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
    });

    expect(orders).toHaveLength(1);
    expect(prisma.order.create.mock.calls[0][0].data.orderMonth).toBe('2026-10');
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  test('an individual-only order after the 15th rolls into next month', async () => {
    mockNow(2026, 10, 20);
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ menuItemOptionId: 'opt-buka-5l', quantity: 1 }],
    });

    expect(prisma.order.create.mock.calls[0][0].data.orderMonth).toBe('2026-11');
  });

  test('a combo-only order uses the stricter 10th cutoff', async () => {
    mockNow(2026, 10, 12); // past the 10th, not past the 15th
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuGroup.findMany.mockResolvedValue([FAMILY_COMBO_GROUP]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [{ menuGroupId: 'grp-family', quantity: 1 }],
    });

    expect(prisma.order.create.mock.calls[0][0].data.orderMonth).toBe('2026-11');
  });

  test('a mixed cart before both cutoffs stays a single order', async () => {
    mockNow(2026, 10, 5);
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.menuGroup.findMany.mockResolvedValue([FAMILY_COMBO_GROUP]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValue({ id: 'order1' });

    const { orders } = await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [
        { menuItemOptionId: 'opt-buka-5l', quantity: 1 },
        { menuGroupId: 'grp-family', quantity: 1 },
      ],
    });

    expect(orders).toHaveLength(1);
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    const data = prisma.order.create.mock.calls[0][0].data;
    expect(data.orderMonth).toBe('2026-10');
    expect(data.items.create).toHaveLength(2);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  test('a mixed cart between the two cutoffs splits into two orders, each with its own fee', async () => {
    mockNow(2026, 10, 12); // past combo cutoff (10th), not past item cutoff (15th)
    prisma.location.findUnique.mockResolvedValue({ id: 'loc1', active: true, logisticsFee: 1000 });
    prisma.menuItemOption.findMany.mockResolvedValue([BUKA_STEW_OPTION]);
    prisma.menuGroup.findMany.mockResolvedValue([FAMILY_COMBO_GROUP]);
    prisma.customer.upsert.mockResolvedValue({ id: 'cust1', address: '1 Market Rd', landmark: null });
    prisma.order.create.mockResolvedValueOnce({ id: 'order-combo' }).mockResolvedValueOnce({ id: 'order-item' });
    prisma.order.updateMany.mockResolvedValue({ count: 2 });

    const { orders } = await createOrderRecord({
      customerName: 'Jane Doe',
      customerPhone: '08012345678',
      deliveryAddress: '1 Market Rd',
      locationId: 'loc1',
      items: [
        { menuGroupId: 'grp-family', quantity: 1 },
        { menuItemOptionId: 'opt-buka-5l', quantity: 1 },
      ],
    });

    expect(prisma.order.create).toHaveBeenCalledTimes(2);
    const [comboCall, itemCall] = prisma.order.create.mock.calls;
    expect(comboCall[0].data.orderMonth).toBe('2026-11'); // combo rolled over past its 10th cutoff
    expect(comboCall[0].data.items.create).toHaveLength(1);
    expect(comboCall[0].data.logisticsFee).toBe(1000); // its own full fee — a separate delivery
    expect(itemCall[0].data.orderMonth).toBe('2026-10'); // item line still inside its own cutoff
    expect(itemCall[0].data.items.create).toHaveLength(1);
    expect(itemCall[0].data.logisticsFee).toBe(1000);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['order-combo', 'order-item'] } },
      data: { splitGroupId: 'order-combo' },
    });
    expect(orders).toEqual([
      { id: 'order-combo', splitGroupId: 'order-combo' },
      { id: 'order-item', splitGroupId: 'order-combo' },
    ]);
  });
});
