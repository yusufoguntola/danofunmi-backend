// Pushes a shortlisted "I'm interested" registration into the standard
// ordering flow — a free "First Taste" order, confirmed immediately (no
// payment step, since it's free) so the customer can track it exactly like
// any other order.
const prisma = require('../db');
const { createOrderRecord, OrderValidationError } = require('./orderCreation');
const { notifyOrderStatusChange } = require('./orderNotifications');
const { HIDDEN_CATEGORIES } = require('./menuCatalog');

// Filed under a HIDDEN_CATEGORIES category (see menuCatalog.js) so it never
// shows up in the public menu or AI chat catalog — only ever ordered via
// createFirstTasteOrder below, never added to a cart by a customer directly.
const CATEGORY_NAME = HIDDEN_CATEGORIES[0];
const ITEM_NAME = 'First Taste';
const OPTION_SIZE = 'Standard';

/** Idempotent get-or-create — returns the free MenuItemOption id to order. */
async function ensureFirstTasteMenuOption() {
  const category = await prisma.menuCategory.upsert({
    where: { name: CATEGORY_NAME },
    update: {},
    create: { name: CATEGORY_NAME },
  });

  const item = await prisma.menuItem.upsert({
    where: { name: ITEM_NAME },
    update: {},
    create: {
      name: ITEM_NAME,
      categoryId: category.id,
      description: 'Your free first taste of dánọ́fúnmi — on the house.',
      active: true,
    },
  });

  const option = await prisma.menuItemOption.upsert({
    where: { menuItemId_size: { menuItemId: item.id, size: OPTION_SIZE } },
    update: {},
    create: { menuItemId: item.id, size: OPTION_SIZE, price: 0, active: true },
  });

  return option.id;
}

/**
 * Creates the free order for a shortlisted InterestRegistration and marks it
 * CONFIRMED (skipping the payment steps — there's nothing to pay). Throws
 * OrderValidationError if `registration.orderId` is already set (one order
 * per registration) or the chosen location isn't valid.
 */
async function createFirstTasteOrder(registration, locationId) {
  if (registration.orderId) {
    throw new OrderValidationError('An order has already been created for this registration');
  }

  const optionId = await ensureFirstTasteMenuOption();
  const deliveryAddress = registration.landmark
    ? `${registration.address} — near ${registration.landmark}`
    : registration.address;

  let order = await createOrderRecord({
    customerName: registration.name,
    customerPhone: registration.phone,
    deliveryAddress,
    locationId,
    items: [{ menuItemOptionId: optionId, quantity: 1 }],
    source: 'WEB',
    notes: 'First-taste offer — created from the coming-soon interest list.',
  });

  // Free, nothing to pay — go straight to confirmed so it flows into the
  // standard packed / out-for-delivery / delivered pipeline.
  order = await prisma.order.update({
    where: { id: order.id },
    data: { status: 'CONFIRMED' },
    include: { customer: true, location: true, items: true, receipts: true },
  });

  // The order's customer record is found-or-created by phone (see
  // createOrderRecord) and may not have an email yet — backfill it from the
  // registration so future order-status emails actually reach them. Same
  // "skip on conflict" pattern createOrderRecord itself uses for phone.
  if (!order.customer.email) {
    try {
      order = {
        ...order,
        customer: await prisma.customer.update({
          where: { id: order.customer.id },
          data: { email: registration.email },
        }),
      };
    } catch (err) {
      if (err.code !== 'P2002') throw err; // email taken by another account — leave it
    }
  }

  await prisma.interestRegistration.update({
    where: { id: registration.id },
    data: { orderId: order.id },
  });

  notifyOrderStatusChange(order, { title: `Order ${order.narration}`, body: 'Your first-taste order is confirmed!' });

  return order;
}

module.exports = { ensureFirstTasteMenuOption, createFirstTasteOrder };
