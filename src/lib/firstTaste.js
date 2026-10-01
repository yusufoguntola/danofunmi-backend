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
 * Creates (or backfills) the Customer record for someone who registered
 * interest in a first-taste slot — independent of whether/when an order is
 * ever created for them (see createFirstTasteOrder below, which calls this
 * too). Conservative like the phone backfill in orderCreation.js: only
 * fills in fields that are still empty, never overwrites an existing
 * customer's real account details with older interest-form values.
 */
async function ensureCustomerForFirstTaste(registration) {
  const { name, phone, email, address, landmark } = registration;
  if (!phone) return null;

  let customer = await prisma.customer.findUnique({ where: { phone } });
  if (!customer) {
    customer = await prisma.customer.create({ data: { name, phone, address, landmark } });
  }

  const patch = {};
  if (!customer.address && address) patch.address = address;
  if (!customer.landmark && landmark) patch.landmark = landmark;
  if (Object.keys(patch).length) {
    customer = await prisma.customer.update({ where: { id: customer.id }, data: patch });
  }

  // Email has its own unique constraint and could collide with an unrelated
  // existing account — skip rather than fail, same pattern as phone/email
  // elsewhere in this file and in orderCreation.js.
  if (!customer.email && email) {
    try {
      customer = await prisma.customer.update({ where: { id: customer.id }, data: { email } });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
    }
  }

  return customer;
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

  // Always a single individual-item line, so createOrderRecord never splits
  // it — safe to take the one order it returns.
  const { orders } = await createOrderRecord({
    customerName: registration.name,
    customerPhone: registration.phone,
    deliveryAddress: registration.address,
    landmark: registration.landmark,
    locationId,
    items: [{ menuItemOptionId: optionId, quantity: 1 }],
    source: 'WEB',
    notes: 'First-taste offer — created from the coming-soon interest list.',
  });
  let order = orders[0];

  // Free, nothing to pay — go straight to confirmed so it flows into the
  // standard packed / out-for-delivery / delivered pipeline.
  order = await prisma.order.update({
    where: { id: order.id },
    data: { status: 'CONFIRMED', statusUpdatedAt: new Date() },
    include: { customer: true, location: true, items: true, receipts: true },
  });

  // The order's customer record is found-or-created by phone (see
  // createOrderRecord), which already synced its address/landmark — this
  // only backfills what that couldn't: email (its own unique-constraint
  // handling — see ensureCustomerForFirstTaste).
  const customer = await ensureCustomerForFirstTaste(registration);
  if (customer) order = { ...order, customer };

  await prisma.interestRegistration.update({
    where: { id: registration.id },
    data: { orderId: order.id },
  });

  notifyOrderStatusChange(order, { title: `Order ${order.narration}`, body: 'Your first-taste order is confirmed!' });

  return order;
}

module.exports = { ensureFirstTasteMenuOption, createFirstTasteOrder, ensureCustomerForFirstTaste };
