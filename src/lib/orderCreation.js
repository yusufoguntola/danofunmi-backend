const prisma = require('../db');
const { generateNarration } = require('./narration');
const { generateOrderNumber } = require('./orderNumber');
const { computeDiscountAmount } = require('./menuCatalog');

class OrderValidationError extends Error {}

function requireQuantity(quantity) {
  const n = Number(quantity);
  if (!Number.isInteger(n) || n < 1) {
    throw new OrderValidationError('Quantity must be a positive integer');
  }
  return n;
}

/** Prices one requested group line — quantity is the number of bundles. */
function priceGroupLine(group, quantity) {
  if (!group || !group.active) {
    throw new OrderValidationError('That combo is not available');
  }

  const snapshotItems = group.items.map((gi) => {
    const option = gi.menuItemOption;
    if (!option.active || !option.menuItem.active) {
      throw new OrderValidationError(`"${group.name}" includes an item that's no longer available`);
    }
    return {
      menuItemId: option.menuItemId,
      menuItemOptionId: option.id,
      name: option.menuItem.name,
      size: option.size,
      unitPrice: Number(option.price),
      quantity: gi.quantity,
      isBonus: gi.isBonus,
    };
  });

  const gross = snapshotItems.filter((i) => !i.isBonus).reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const discountAmount = computeDiscountAmount(group, gross);
  const unitPrice = gross - discountAmount;
  const lineTotal = unitPrice * quantity;

  return {
    menuItemId: null,
    menuItemOptionId: null,
    menuGroupId: group.id,
    itemName: group.name,
    size: 'Combo',
    unitPrice,
    quantity,
    lineTotal,
    groupSnapshot: {
      discountType: group.discountType,
      discountValue: group.discountValue != null ? Number(group.discountValue) : null,
      grossTotal: gross,
      discountAmount,
      items: snapshotItems,
    },
  };
}

/**
 * Prices are always recomputed from the DB — never trusted from the caller.
 * `items` is [{ menuItemOptionId, quantity }] for an individual item, or
 * [{ menuGroupId, quantity }] for a combo bundle (quantity = number of
 * bundles) — exactly one id per entry. Returns DB-shaped `lineItems` (safe to
 * pass straight into `prisma.order.create({ items: { create: ... } })`) plus
 * `optionsById` so callers needing extra display fields (e.g. `icon` for the
 * AI chat's cart preview) can pull them without widening `lineItems`.
 */
async function priceItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderValidationError('At least one order item is required');
  }
  for (const requested of items) {
    if (!!requested.menuItemOptionId === !!requested.menuGroupId) {
      throw new OrderValidationError('Each item needs exactly one of menuItemOptionId or menuGroupId');
    }
  }

  const optionIds = items.filter((i) => i.menuItemOptionId).map((i) => i.menuItemOptionId);
  const groupIds = items.filter((i) => i.menuGroupId).map((i) => i.menuGroupId);

  const [options, groups] = await Promise.all([
    optionIds.length
      ? prisma.menuItemOption.findMany({ where: { id: { in: optionIds } }, include: { menuItem: true } })
      : [],
    groupIds.length
      ? prisma.menuGroup.findMany({
          where: { id: { in: groupIds } },
          include: { items: { include: { menuItemOption: { include: { menuItem: true } } } } },
        })
      : [],
  ]);
  const optionsById = new Map(options.map((o) => [o.id, o]));
  const groupsById = new Map(groups.map((g) => [g.id, g]));

  let subtotal = 0;
  const lineItems = items.map((requested) => {
    const quantity = requireQuantity(requested.quantity);

    if (requested.menuGroupId) {
      const line = priceGroupLine(groupsById.get(requested.menuGroupId), quantity);
      subtotal += line.lineTotal;
      return line;
    }

    const option = optionsById.get(requested.menuItemOptionId);
    if (!option || !option.active || !option.menuItem.active) {
      throw new OrderValidationError(`Menu option ${requested.menuItemOptionId} is not available`);
    }
    const unitPrice = Number(option.price);
    const lineTotal = unitPrice * quantity;
    subtotal += lineTotal;

    return {
      menuItemId: option.menuItemId,
      menuItemOptionId: option.id,
      menuGroupId: null,
      itemName: option.menuItem.name,
      size: option.size,
      unitPrice,
      quantity,
      lineTotal,
    };
  });

  return { lineItems, subtotal, optionsById, groupsById };
}

async function createOrderRecord({
  customerName,
  customerPhone,
  deliveryAddress,
  locationId,
  items,
  source,
  notes,
  authenticatedCustomerId,
}) {
  if (!customerName || !customerPhone || !deliveryAddress || !locationId) {
    throw new OrderValidationError('customerName, customerPhone, deliveryAddress, and locationId are required');
  }

  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location || !location.active) {
    throw new OrderValidationError('Selected location is not available');
  }

  const { lineItems, subtotal } = await priceItems(items);

  const logisticsFee = Number(location.logisticsFee);
  const total = subtotal + logisticsFee;

  // A signed-in order links to that account by id — never by re-upserting on
  // phone, which could detach it from the account (a Google signup may have
  // no phone on file yet, or the typed delivery phone may just differ). The
  // account's own name is never overwritten here: the delivery name may
  // legitimately differ (e.g. ordering for someone else).
  let customer;
  if (authenticatedCustomerId) {
    customer = await prisma.customer.findUnique({ where: { id: authenticatedCustomerId } });
    if (!customer) throw new OrderValidationError('Account not found');
    if (!customer.phone) {
      try {
        customer = await prisma.customer.update({ where: { id: customer.id }, data: { phone: customerPhone } });
      } catch (err) {
        if (err.code !== 'P2002') throw err; // phone taken by another account — just skip backfilling it
      }
    }
  } else {
    customer = await prisma.customer.upsert({
      where: { phone: customerPhone },
      update: { name: customerName },
      create: { name: customerName, phone: customerPhone },
    });
  }

  // Narration/order-number collisions are rare (6-char narration from a 32-char
  // alphabet; 1-in-900,000 for the order number) but retry defensively — a
  // P2002 could come from either unique constraint, so just regenerate both.
  for (let attempt = 0; attempt < 5; attempt++) {
    const narration = generateNarration();
    const orderNumber = generateOrderNumber();
    try {
      const order = await prisma.order.create({
        data: {
          narration,
          orderNumber,
          customerId: customer.id,
          locationId,
          deliveryAddress,
          subtotal,
          logisticsFee,
          total,
          source,
          notes,
          items: { create: lineItems },
        },
        include: { items: true, location: true, customer: true },
      });
      return order;
    } catch (err) {
      if (err.code === 'P2002' && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique order narration/number');
}

module.exports = { createOrderRecord, priceItems, OrderValidationError };
