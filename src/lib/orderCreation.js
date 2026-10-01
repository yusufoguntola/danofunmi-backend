const prisma = require('../db');
const { generateNarration } = require('./narration');
const { generateOrderNumber } = require('./orderNumber');
const { computeDiscountAmount } = require('./menuCatalog');
const { ITEM_CUTOFF_DAY, computeOrderMonth, partitionLineItemsByCutoff } = require('./orderSchedule');

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

/** Retries order creation up to 5x on a narration/orderNumber collision
 * (rare but possible — 6-char narration from a 32-char alphabet; 1-in-900,000
 * for the order number). `data` omits narration/orderNumber — this fills
 * them in fresh each attempt. Shared by createOrderRecord and
 * createAdminCustomOrder below. */
async function createOrderWithUniqueNarration(data, include) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const narration = generateNarration();
    const orderNumber = generateOrderNumber();
    try {
      return await prisma.order.create({ data: { ...data, narration, orderNumber }, include });
    } catch (err) {
      if (err.code === 'P2002' && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique order narration/number');
}

async function createOrderRecord({
  customerName,
  customerPhone,
  deliveryAddress,
  landmark,
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

  const { lineItems } = await priceItems(items);
  const logisticsFee = Number(location.logisticsFee);

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

  // Unlike name/phone above, delivery address and landmark have no identity
  // purpose — pure convenience — so they're kept in sync with whatever was
  // just used, letting them pre-fill next order (see OrderPage.jsx).
  // Address is required on every order, so it's always synced; landmark is
  // optional, so an order placed without one leaves a previously-saved
  // landmark alone rather than clearing it.
  const customerPatch = {};
  if (customer.address !== deliveryAddress) customerPatch.address = deliveryAddress;
  if (landmark && customer.landmark !== landmark) customerPatch.landmark = landmark;
  if (Object.keys(customerPatch).length) {
    customer = await prisma.customer.update({ where: { id: customer.id }, data: customerPatch });
  }

  // A cart of only individual items or only a combo always stays one Order.
  // One mixing both only splits into two Orders when the combo and
  // individual-item lines actually resolve to different processing months
  // (placed after the 10th but on/before the 15th) — each half then needs
  // its own narration/payment reference and its own full logistics fee,
  // since it's genuinely a separate delivery run. See lib/orderSchedule.js.
  const groups = partitionLineItemsByCutoff(lineItems);

  const orders = [];
  for (const group of groups) {
    const groupSubtotal = group.lines.reduce((sum, l) => sum + l.lineTotal, 0);
    const order = await createOrderWithUniqueNarration(
      {
        customerId: customer.id,
        locationId,
        deliveryAddress,
        landmark: landmark || null,
        subtotal: groupSubtotal,
        logisticsFee,
        total: groupSubtotal + logisticsFee,
        orderMonth: group.orderMonth,
        source,
        notes,
        statusUpdatedAt: new Date(),
        items: { create: group.lines },
      },
      { items: true, location: true, customer: true }
    );
    orders.push(order);
  }

  if (orders.length > 1) {
    const splitGroupId = orders[0].id;
    await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { splitGroupId } });
    orders.forEach((o) => {
      o.splitGroupId = splitGroupId;
    });
  }

  return { orders };
}

/**
 * An admin-authored order created from a follow-up conversation about a
 * logged ExtraneousRequest (see routes/requests.js) — no catalog lookup:
 * `items` are exactly the name/size/price/quantity lines the admin entered
 * (always stored as free-text lines, like the WhatsApp bot's off-menu
 * catch-all — never linked back to a real MenuItemOption, since an edited
 * quote may no longer match one anyway), and `total` is whatever figure was
 * actually quoted rather than always subtotal + logisticsFee. Customer is
 * always upserted by phone — there's no "authenticated customer" concept
 * from the admin side.
 */
async function createAdminCustomOrder({
  customerName,
  customerPhone,
  deliveryAddress,
  landmark,
  locationId,
  items,
  total,
  notes,
  source,
}) {
  if (!customerName || !customerPhone || !deliveryAddress || !locationId) {
    throw new OrderValidationError('customerName, customerPhone, deliveryAddress, and locationId are required');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderValidationError('At least one order item is required');
  }

  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location || !location.active) {
    throw new OrderValidationError('Selected location is not available');
  }

  let subtotal = 0;
  const lineItems = items.map((line) => {
    const quantity = requireQuantity(line.quantity);
    const unitPrice = Number(line.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new OrderValidationError(`Invalid price for "${line.itemName || 'an item'}"`);
    }
    if (!line.itemName?.trim() || !line.size?.trim()) {
      throw new OrderValidationError('Each item needs a name and size/label');
    }
    const lineTotal = unitPrice * quantity;
    subtotal += lineTotal;
    return {
      menuItemId: null,
      menuItemOptionId: null,
      menuGroupId: null,
      itemName: line.itemName.trim(),
      size: line.size.trim(),
      unitPrice,
      quantity,
      lineTotal,
    };
  });

  const logisticsFee = Number(location.logisticsFee);
  const finalTotal = Number.isFinite(Number(total)) && total !== '' ? Number(total) : subtotal + logisticsFee;
  if (finalTotal < 0) throw new OrderValidationError('Total cannot be negative');

  let customer = await prisma.customer.upsert({
    where: { phone: customerPhone },
    update: { name: customerName },
    create: { name: customerName, phone: customerPhone },
  });

  const customerPatch = {};
  if (customer.address !== deliveryAddress) customerPatch.address = deliveryAddress;
  if (landmark && customer.landmark !== landmark) customerPatch.landmark = landmark;
  if (Object.keys(customerPatch).length) {
    customer = await prisma.customer.update({ where: { id: customer.id }, data: customerPatch });
  }

  return createOrderWithUniqueNarration(
    {
      customerId: customer.id,
      locationId,
      deliveryAddress,
      landmark: landmark || null,
      subtotal,
      logisticsFee,
      total: finalTotal,
      // Admin-authored lines are always free-text, never a real combo
      // (menuGroupId is always null here) — so only the item cutoff ever
      // applies, and this never needs to split across months.
      orderMonth: computeOrderMonth(ITEM_CUTOFF_DAY).orderMonth,
      source: source || 'WEB_CHAT',
      notes: notes || null,
      statusUpdatedAt: new Date(),
      items: { create: lineItems },
    },
    { items: true, location: true, customer: true }
  );
}

module.exports = { createOrderRecord, createAdminCustomOrder, priceItems, OrderValidationError };
