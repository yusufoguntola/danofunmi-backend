jest.mock('../../src/db', () => ({
  menuCategory: { upsert: jest.fn() },
  menuItem: { upsert: jest.fn() },
  menuItemOption: { upsert: jest.fn() },
  customer: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  order: { update: jest.fn() },
  interestRegistration: { update: jest.fn() },
}));
jest.mock('../../src/lib/orderCreation', () => ({
  createOrderRecord: jest.fn(),
  OrderValidationError: class OrderValidationError extends Error {},
}));
jest.mock('../../src/lib/orderNotifications', () => ({ notifyOrderStatusChange: jest.fn() }));

const prisma = require('../../src/db');
const { createOrderRecord, OrderValidationError } = require('../../src/lib/orderCreation');
const { notifyOrderStatusChange } = require('../../src/lib/orderNotifications');
const { ensureFirstTasteMenuOption, createFirstTasteOrder, ensureCustomerForFirstTaste } = require('../../src/lib/firstTaste');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ensureFirstTasteMenuOption', () => {
  test('upserts the hidden category, item, and Standard/free option, returning the option id', async () => {
    prisma.menuCategory.upsert.mockResolvedValue({ id: 'cat1' });
    prisma.menuItem.upsert.mockResolvedValue({ id: 'item1' });
    prisma.menuItemOption.upsert.mockResolvedValue({ id: 'opt1' });

    const optionId = await ensureFirstTasteMenuOption();

    expect(optionId).toBe('opt1');
    expect(prisma.menuCategory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'Promotions' } })
    );
    expect(prisma.menuItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'First Taste' },
        create: expect.objectContaining({ categoryId: 'cat1', hiddenFromCatalog: true }),
        update: {}, // never re-hides it if an admin has since made it visible
      })
    );
    expect(prisma.menuItemOption.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { menuItemId_size: { menuItemId: 'item1', size: 'Standard' } },
        create: expect.objectContaining({ menuItemId: 'item1', price: 0, active: true }),
      })
    );
  });
});

describe('ensureCustomerForFirstTaste', () => {
  test('returns null when the registration has no phone', async () => {
    const result = await ensureCustomerForFirstTaste({ name: 'Ada', phone: null });
    expect(result).toBeNull();
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
  });

  test('creates a new customer when none exists for that phone', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    prisma.customer.create.mockResolvedValue({ id: 'cust1', address: '1 Rd', landmark: null, email: null });

    const result = await ensureCustomerForFirstTaste({
      name: 'Ada',
      phone: '08012345678',
      address: '1 Rd',
      landmark: null,
      email: null,
    });

    expect(prisma.customer.create).toHaveBeenCalledWith({
      data: { name: 'Ada', phone: '08012345678', address: '1 Rd', landmark: null },
    });
    expect(result.id).toBe('cust1');
  });

  test('backfills only the empty fields of an existing customer, never overwriting real ones', async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'cust1',
      address: 'Existing Address',
      landmark: null,
      email: null,
    });
    prisma.customer.update.mockResolvedValue({ id: 'cust1', address: 'Existing Address', landmark: 'New Landmark', email: null });

    await ensureCustomerForFirstTaste({
      name: 'Ada',
      phone: '08012345678',
      address: 'Ignored New Address',
      landmark: 'New Landmark',
      email: null,
    });

    expect(prisma.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust1' },
      data: { landmark: 'New Landmark' }, // address untouched — already set
    });
  });

  test('backfills email, skipping silently on a unique-constraint conflict', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1', address: 'A', landmark: 'L', email: null });
    prisma.customer.update.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));

    const result = await ensureCustomerForFirstTaste({
      name: 'Ada',
      phone: '08012345678',
      address: 'A',
      landmark: 'L',
      email: 'ada@b.com',
    });

    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'cust1' }, data: { email: 'ada@b.com' } });
    expect(result.email).toBeNull(); // update failed, so the pre-patch customer object is what's returned
  });

  test('propagates a non-P2002 error from the email backfill', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1', address: 'A', landmark: 'L', email: null });
    prisma.customer.update.mockRejectedValueOnce(new Error('DB down'));

    await expect(
      ensureCustomerForFirstTaste({ name: 'Ada', phone: '08012345678', address: 'A', landmark: 'L', email: 'ada@b.com' })
    ).rejects.toThrow('DB down');
  });

  test('does not touch the customer at all when nothing new was supplied', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'cust1', address: 'A', landmark: 'L', email: 'a@b.com' });
    const result = await ensureCustomerForFirstTaste({ name: 'Ada', phone: '08012345678', address: 'A', landmark: 'L', email: 'a@b.com' });
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(result.id).toBe('cust1');
  });
});

const REGISTRATION = {
  id: 'reg1',
  orderId: null,
  name: 'Ada',
  phone: '08012345678',
  address: '1 Rd',
  landmark: 'Shoprite',
  email: 'ada@b.com',
};

describe('createFirstTasteOrder', () => {
  test('rejects a registration that already has an order', async () => {
    await expect(createFirstTasteOrder({ ...REGISTRATION, orderId: 'order1' }, 'loc1')).rejects.toBeInstanceOf(
      OrderValidationError
    );
    expect(createOrderRecord).not.toHaveBeenCalled();
  });

  test('creates a free order, confirms it immediately, links the registration, and notifies', async () => {
    prisma.menuCategory.upsert.mockResolvedValue({ id: 'cat1' });
    prisma.menuItem.upsert.mockResolvedValue({ id: 'item1' });
    prisma.menuItemOption.upsert.mockResolvedValue({ id: 'opt1' });
    createOrderRecord.mockResolvedValue({ orders: [{ id: 'order1', narration: 'DFM-AB12CD' }] });
    prisma.order.update.mockResolvedValue({
      id: 'order1',
      narration: 'DFM-AB12CD',
      status: 'CONFIRMED',
      customer: { id: 'cust-old', name: 'Ada' },
    });
    prisma.customer.findUnique.mockResolvedValue(null);
    prisma.customer.create.mockResolvedValue({ id: 'cust1', address: '1 Rd', landmark: 'Shoprite', email: null });
    prisma.interestRegistration.update.mockResolvedValue({});

    const order = await createFirstTasteOrder(REGISTRATION, 'loc1');

    expect(createOrderRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: 'Ada',
        customerPhone: '08012345678',
        locationId: 'loc1',
        items: [{ menuItemOptionId: 'opt1', quantity: 1 }],
        source: 'WEB',
      })
    );
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order1' },
      data: { status: 'CONFIRMED', statusUpdatedAt: expect.any(Date) },
      include: { customer: true, location: true, items: true, receipts: true },
    });
    expect(prisma.interestRegistration.update).toHaveBeenCalledWith({
      where: { id: 'reg1' },
      data: { orderId: 'order1' },
    });
    expect(notifyOrderStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order1' }),
      expect.objectContaining({ body: 'Your first-taste order is confirmed!' })
    );
    // the backfilled customer (from ensureCustomerForFirstTaste) replaces the order's customer
    expect(order.customer.id).toBe('cust1');
  });

  test('keeps the order.update customer when ensureCustomerForFirstTaste returns null (no phone)', async () => {
    prisma.menuCategory.upsert.mockResolvedValue({ id: 'cat1' });
    prisma.menuItem.upsert.mockResolvedValue({ id: 'item1' });
    prisma.menuItemOption.upsert.mockResolvedValue({ id: 'opt1' });
    createOrderRecord.mockResolvedValue({ orders: [{ id: 'order1', narration: 'DFM-AB12CD' }] });
    const confirmedOrder = { id: 'order1', narration: 'DFM-AB12CD', status: 'CONFIRMED', customer: { id: 'cust-old' } };
    prisma.order.update.mockResolvedValue(confirmedOrder);
    prisma.interestRegistration.update.mockResolvedValue({});

    const order = await createFirstTasteOrder({ ...REGISTRATION, phone: null }, 'loc1');

    expect(order.customer.id).toBe('cust-old');
  });
});
