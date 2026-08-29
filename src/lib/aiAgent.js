const Anthropic = require('@anthropic-ai/sdk');
const prisma = require('../db');
const { createOrderRecord, priceItems, OrderValidationError } = require('./orderCreation');

const MODEL = 'claude-opus-5';
const MAX_TOOL_ROUNDS = 6;

class ChatNotConfiguredError extends Error {}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new ChatNotConfiguredError('ANTHROPIC_API_KEY is not set');
  }
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You are the ordering assistant for dánọ́fúnmi, a home-cooked soup & rice
delivery service that takes orders once a month. You chat with customers directly inside the
web app (a PWA) to replace what used to be a numbered WhatsApp menu — so talk naturally, don't
make the customer reply with item numbers.

Responsibilities, roughly in order:
1. Greet the customer and help them browse the menu. ALWAYS call list_menu before describing
   items or quoting a price — never invent menu items, sizes, or prices from memory.
2. Build up their order in the conversation (items + quantities). Confirm the running list back
   to them in plain language as it grows. Call update_cart with the full current item list every
   time the selection changes (add, remove, change quantity) — this keeps a live cart preview in
   sync on the web app, so the customer can also see and finish their order there if they want.
3. Once they're done choosing, call list_locations and ask which delivery location applies (this
   determines the logistics fee).
4. Collect their full name, a phone number, and a delivery address (street, area, landmark).
   Also ask, briefly, if they'd like to add an optional delivery note (gate code, "call on
   arrival", a landmark, etc.) — don't push if they have nothing to add.
5. Read back a clear order summary (items, sizes, quantities, subtotal, logistics fee, total,
   delivery address) and get an explicit "yes"/confirmation before calling create_order. Never
   call create_order without that confirmation.
6. After create_order succeeds, tell them the order narration AND the shorter order number it
   returns (either works for tracking later), plus the bank payment details, and let them know
   there's an "Upload payment receipt" button right here in the chat they can use once they've
   paid — you don't handle the image yourself.
7. If a customer asks about an existing order, call track_order with whichever they give you —
   the narration (format DFM-XXXXXX) or the order number — to check status.
8. If an order's status is DELIVERED (from track_order) and the customer wants to share feedback,
   ask for a 1-5 rating and an optional comment, then call submit_feedback.

Keep replies short and warm — this is a chat interface, not an email. If a tool call fails,
explain the problem in plain language and help the customer fix it (e.g. an invalid location or
a sold-out item) rather than repeating the same call.`;

const GUEST_ACCOUNT_NOTE = `

This customer is NOT signed in. Once — either right after an order is successfully placed, or
if the conversation seems to be wrapping up (they say thanks/bye/that's all) — mention that
creating a free account (top of the page) makes managing and tracking orders easier. Say it once,
warmly, don't push it, and never bring it up more than once in the conversation.`;

function buildSystemPrompt(isAuthenticated) {
  return isAuthenticated ? SYSTEM_PROMPT : SYSTEM_PROMPT + GUEST_ACCOUNT_NOTE;
}

const TOOLS = [
  {
    name: 'list_menu',
    description: 'Get the current active menu: categories, items, and their priced size options (with option ids needed for create_order).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_locations',
    description: 'Get active delivery locations and their logistics fees.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_cart',
    description: 'Sync the customer\'s current in-progress item selection so it shows up as a live cart preview on the web app. Call with the FULL current list every time it changes (this replaces the previous cart, it does not append). Call with an empty items array if they clear their cart.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              menuItemOptionId: { type: 'string', description: 'option id from list_menu' },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['menuItemOptionId', 'quantity'],
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_order',
    description: 'Create a new order once the customer has confirmed their items, location, and delivery details. Prices are always recomputed server-side.',
    input_schema: {
      type: 'object',
      properties: {
        customerName: { type: 'string' },
        customerPhone: { type: 'string' },
        deliveryAddress: { type: 'string' },
        locationId: { type: 'string', description: 'id from list_locations' },
        notes: {
          type: 'string',
          description: 'Optional delivery note — gate code, "call on arrival", landmark, etc. Only ask if the customer wants to add one; never required.',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              menuItemOptionId: { type: 'string', description: 'option id from list_menu' },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['menuItemOptionId', 'quantity'],
          },
        },
      },
      required: ['customerName', 'customerPhone', 'deliveryAddress', 'locationId', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'track_order',
    description: "Look up an order's current status by its narration code (e.g. DFM-AB12CD) or its shorter order number (e.g. 10042).",
    input_schema: {
      type: 'object',
      properties: { narration: { type: 'string', description: 'Narration code or order number' } },
      required: ['narration'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_feedback',
    description: 'Record customer feedback for an order.',
    input_schema: {
      type: 'object',
      properties: {
        narration: { type: 'string' },
        rating: { type: 'integer', minimum: 1, maximum: 5 },
        comment: { type: 'string' },
      },
      required: ['narration', 'rating'],
      additionalProperties: false,
    },
  },
];

async function toolListMenu() {
  const items = await prisma.menuItem.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    include: {
      category: true,
      options: { where: { active: true }, orderBy: { price: 'asc' } },
    },
  });
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category?.name ?? null,
    description: item.description,
    options: item.options.map((o) => ({ id: o.id, size: o.size, price: Number(o.price) })),
  }));
}

async function toolListLocations() {
  const locations = await prisma.location.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
  });
  return locations.map((l) => ({ id: l.id, name: l.name, logisticsFee: Number(l.logisticsFee) }));
}

async function toolUpdateCart({ items }) {
  if (!items || items.length === 0) return { items: [], subtotal: 0 };

  const { lineItems, subtotal, optionsById } = await priceItems(items);
  return {
    items: lineItems.map((li) => ({
      menuItemOptionId: li.menuItemOptionId,
      itemName: li.itemName,
      icon: optionsById.get(li.menuItemOptionId)?.menuItem.icon ?? null,
      size: li.size,
      unitPrice: li.unitPrice,
      quantity: li.quantity,
    })),
    subtotal,
  };
}

async function toolCreateOrder(input, context) {
  const order = await createOrderRecord({
    ...input,
    source: 'WEB_CHAT',
    authenticatedCustomerId: context?.authenticatedCustomerId,
  });
  return {
    order: {
      id: order.id,
      narration: order.narration,
      orderNumber: order.orderNumber,
      status: order.status,
      subtotal: Number(order.subtotal),
      logisticsFee: Number(order.logisticsFee),
      total: Number(order.total),
      customerPhone: order.customer.phone,
    },
    payment: {
      bankName: process.env.BANK_NAME,
      accountName: process.env.BANK_ACCOUNT_NAME,
      accountNumber: process.env.BANK_ACCOUNT_NUMBER,
      amount: Number(order.total),
      narration: order.narration,
    },
  };
}

async function toolTrackOrder({ narration }) {
  const or = [{ id: narration }, { narration }];
  if (/^\d+$/.test(String(narration).trim())) or.push({ orderNumber: Number(narration) });

  const order = await prisma.order.findFirst({
    where: { OR: or },
    include: { items: true, receipts: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!order) {
    const err = new Error(`No order found matching "${narration}". Ask the customer to double-check the narration or order number.`);
    err.isToolError = true;
    throw err;
  }
  return {
    narration: order.narration,
    orderNumber: order.orderNumber,
    status: order.status,
    total: Number(order.total),
    items: order.items.map((i) => ({ name: i.itemName, size: i.size, quantity: i.quantity })),
    latestReceiptStatus: order.receipts[0]?.status ?? null,
  };
}

async function toolSubmitFeedback({ narration, rating, comment }) {
  const order = await prisma.order.findFirst({ where: { OR: [{ id: narration }, { narration }] } });
  if (!order) {
    const err = new Error(`No order found with narration "${narration}" — can't attach feedback to it.`);
    err.isToolError = true;
    throw err;
  }
  await prisma.feedback.create({ data: { orderId: order.id, rating, comment: comment || null } });
  return { ok: true };
}

const HANDLERS = {
  list_menu: toolListMenu,
  list_locations: toolListLocations,
  update_cart: toolUpdateCart,
  create_order: toolCreateOrder,
  track_order: toolTrackOrder,
  submit_feedback: toolSubmitFeedback,
};

async function executeTool(name, input, context) {
  const handler = HANDLERS[name];
  if (!handler) return { isError: true, content: `Unknown tool: ${name}` };
  try {
    const result = await handler(input, context);
    return { isError: false, content: JSON.stringify(result) };
  } catch (err) {
    if (err instanceof OrderValidationError || err.isToolError) {
      return { isError: true, content: err.message };
    }
    console.error(`aiAgent tool "${name}" failed:`, err);
    return { isError: true, content: 'Something went wrong on our end running that step. Try again in a moment.' };
  }
}

/**
 * Extracts the last create_order/track_order and update_cart tool results from
 * this turn's new content, for the frontend — order info under the returned
 * object's top level (unchanged shape), cart info under `.cart`.
 */
function extractMeta(newAssistantBlocks, toolResultsByCallId) {
  let orderMeta = null;
  let cartMeta = null;

  for (const block of newAssistantBlocks) {
    if (block.type !== 'tool_use') continue;
    const result = toolResultsByCallId.get(block.id);
    if (!result || result.isError) continue;
    const parsed = JSON.parse(result.content);

    if (block.name === 'create_order') {
      orderMeta = {
        orderId: parsed.order.id,
        narration: parsed.order.narration,
        orderNumber: parsed.order.orderNumber,
        status: parsed.order.status,
        total: parsed.order.total,
        customerPhone: parsed.order.customerPhone,
      };
    } else if (block.name === 'track_order') {
      orderMeta = {
        narration: parsed.narration,
        orderNumber: parsed.orderNumber,
        status: parsed.status,
        total: parsed.total,
      };
    } else if (block.name === 'update_cart') {
      cartMeta = { items: parsed.items, subtotal: parsed.subtotal };
    }
  }

  if (!orderMeta && !cartMeta) return null;
  return { ...orderMeta, cart: cartMeta };
}

/**
 * Runs the agentic loop for one chat turn. `messages` is the full client-held
 * conversation (Anthropic message-param shape); returns the updated array
 * plus `meta` describing the most recent order touched this turn, if any.
 */
async function runChat(messages, context = {}) {
  const conversation = [...messages];
  let meta = null;
  const systemPrompt = buildSystemPrompt(context.isAuthenticated);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      tools: TOOLS,
      messages: conversation,
    });

    conversation.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return { messages: conversation, meta };
    }

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResultsByCallId = new Map();
    const toolResultBlocks = [];
    for (const block of toolUseBlocks) {
      const result = await executeTool(block.name, block.input, context);
      toolResultsByCallId.set(block.id, result);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }
    conversation.push({ role: 'user', content: toolResultBlocks });

    const roundMeta = extractMeta(toolUseBlocks, toolResultsByCallId);
    if (roundMeta) meta = roundMeta;
  }

  conversation.push({
    role: 'assistant',
    content: [{ type: 'text', text: "Sorry, that's taking a bit long — could you rephrase or try again?" }],
  });
  return { messages: conversation, meta };
}

module.exports = { runChat, ChatNotConfiguredError };
