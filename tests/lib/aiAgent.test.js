const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
jest.mock('../../src/db', () => ({
  location: { findMany: jest.fn() },
  order: { findFirst: jest.fn() },
  feedback: { create: jest.fn() },
  extraneousRequest: { create: jest.fn() },
}));
jest.mock('../../src/lib/orderCreation', () => ({
  createOrderRecord: jest.fn(),
  priceItems: jest.fn(),
  OrderValidationError: class OrderValidationError extends Error {},
}));
jest.mock('../../src/lib/menuCatalog', () => ({ getCatalog: jest.fn() }));

const prisma = require('../../src/db');
const { createOrderRecord, priceItems, OrderValidationError } = require('../../src/lib/orderCreation');
const { getCatalog } = require('../../src/lib/menuCatalog');
const { runChat, ChatNotConfiguredError } = require('../../src/lib/aiAgent');

const ORIGINAL_ENV = { ...process.env };

function textTurn(text) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

function toolUseTurn(blocks) {
  return { content: blocks.map((b) => ({ type: 'tool_use', ...b })), stop_reason: 'tool_use' };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('runChat — configuration', () => {
  test('throws ChatNotConfiguredError when no API key/token is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    await expect(runChat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(ChatNotConfiguredError);
  });
});

describe('runChat — plain text reply, no tools', () => {
  test('returns the updated conversation with no meta', async () => {
    mockCreate.mockResolvedValue(textTurn('Hello! How can I help?'));

    const { messages, meta } = await runChat([{ role: 'user', content: 'hi' }]);

    expect(meta).toBeNull();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'assistant', content: textTurn('Hello! How can I help?').content });
  });

  test('includes the guest account-creation note in the system prompt when not authenticated', async () => {
    mockCreate.mockResolvedValue(textTurn('hi'));
    await runChat([{ role: 'user', content: 'hi' }], { isAuthenticated: false });
    const call = mockCreate.mock.calls[0][0];
    expect(call.system[0].text).toContain('This customer is NOT signed in');
  });

  test('omits the guest note when authenticated', async () => {
    mockCreate.mockResolvedValue(textTurn('hi'));
    await runChat([{ role: 'user', content: 'hi' }], { isAuthenticated: true });
    const call = mockCreate.mock.calls[0][0];
    expect(call.system[0].text).not.toContain('This customer is NOT signed in');
  });
});

describe('runChat — list_menu tool round trip', () => {
  test('calls getCatalog and feeds the result back as a tool_result', async () => {
    getCatalog.mockResolvedValue([{ id: 'item1', type: 'item', name: 'Buka Stew' }]);
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'list_menu', input: {} }]))
      .mockResolvedValueOnce(textTurn('Here is our menu!'));

    const { messages, meta } = await runChat([{ role: 'user', content: 'what do you sell' }]);

    expect(getCatalog).toHaveBeenCalled();
    expect(meta).toBeNull();
    const toolResultMsg = messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
    expect(JSON.parse(toolResultMsg.content[0].content)).toEqual([{ id: 'item1', type: 'item', name: 'Buka Stew' }]);
    expect(toolResultMsg.content[0].is_error).toBe(false);
  });
});

describe('runChat — list_locations tool', () => {
  test('returns active locations with numeric logisticsFee', async () => {
    prisma.location.findMany.mockResolvedValue([{ id: 'loc1', name: 'Lekki', logisticsFee: { toString: () => '1500' } }]);
    // Number() on an object with a custom toString coerces via it.
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'list_locations', input: {} }]))
      .mockResolvedValueOnce(textTurn('ok'));

    const { messages } = await runChat([{ role: 'user', content: 'where do you deliver' }]);

    expect(prisma.location.findMany).toHaveBeenCalledWith({ where: { active: true }, orderBy: { name: 'asc' } });
    const toolResultMsg = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'tool_result');
    expect(JSON.parse(toolResultMsg.content[0].content)).toEqual([{ id: 'loc1', name: 'Lekki', logisticsFee: 1500 }]);
  });
});

describe('runChat — update_cart tool', () => {
  test('empty items array returns an empty cart without pricing', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'update_cart', input: { items: [] } }]))
      .mockResolvedValueOnce(textTurn('ok'));

    const { messages, meta } = await runChat([{ role: 'user', content: 'clear my cart' }]);

    expect(priceItems).not.toHaveBeenCalled();
    expect(meta.cart).toEqual({ items: [], subtotal: 0 });
  });

  test('prices the cart and surfaces it in meta.cart, with icons resolved per line', async () => {
    priceItems.mockResolvedValue({
      lineItems: [
        { menuItemOptionId: 'opt1', menuGroupId: null, itemName: 'Buka Stew', size: '1L', unitPrice: 5000, quantity: 2 },
      ],
      subtotal: 10000,
      optionsById: new Map([['opt1', { menuItem: { icon: '🍛' } }]]),
      groupsById: new Map(),
    });
    mockCreate
      .mockResolvedValueOnce(
        toolUseTurn([{ id: 'call1', name: 'update_cart', input: { items: [{ menuItemOptionId: 'opt1', quantity: 2 }] } }])
      )
      .mockResolvedValueOnce(textTurn('ok'));

    const { meta } = await runChat([{ role: 'user', content: '2 buka stew' }]);

    expect(meta.cart).toEqual({
      items: [
        { menuItemOptionId: 'opt1', menuGroupId: null, itemName: 'Buka Stew', icon: '🍛', size: '1L', unitPrice: 5000, quantity: 2 },
      ],
      subtotal: 10000,
    });
  });

  test('a validation error from priceItems comes back as a tool error, not a crash', async () => {
    priceItems.mockRejectedValue(new OrderValidationError('Menu option opt-gone is not available'));
    mockCreate
      .mockResolvedValueOnce(
        toolUseTurn([{ id: 'call1', name: 'update_cart', input: { items: [{ menuItemOptionId: 'opt-gone', quantity: 1 }] } }])
      )
      .mockResolvedValueOnce(textTurn('ok'));

    const { messages } = await runChat([{ role: 'user', content: 'add opt-gone' }]);
    const toolResultMsg = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'tool_result');
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(toolResultMsg.content[0].content).toBe('Menu option opt-gone is not available');
  });
});

describe('runChat — create_order tool', () => {
  const ORDER_INPUT = {
    customerName: 'Jane',
    customerPhone: '08012345678',
    deliveryAddress: '1 Rd',
    locationId: 'loc1',
    items: [{ menuItemOptionId: 'opt1', quantity: 1 }],
  };

  test('creates the order and surfaces order meta + payment details', async () => {
    process.env.BANK_NAME = 'Test Bank';
    createOrderRecord.mockResolvedValue({
      id: 'order1',
      narration: 'DFM-AB12CD',
      orderNumber: 10042,
      status: 'PENDING_PAYMENT',
      subtotal: 5000,
      logisticsFee: 1000,
      total: 6000,
      customer: { phone: '08012345678' },
    });
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'create_order', input: ORDER_INPUT }]))
      .mockResolvedValueOnce(textTurn('Your order is in!'));

    const { meta } = await runChat([{ role: 'user', content: 'confirm order' }], { authenticatedCustomerId: 'cust1' });

    expect(createOrderRecord).toHaveBeenCalledWith(
      expect.objectContaining({ ...ORDER_INPUT, source: 'WEB_CHAT', authenticatedCustomerId: 'cust1' })
    );
    expect(meta).toEqual({
      orderId: 'order1',
      narration: 'DFM-AB12CD',
      orderNumber: 10042,
      status: 'PENDING_PAYMENT',
      total: 6000,
      customerPhone: '08012345678',
      cart: null,
      humanHandoff: null,
    });
  });

  test('a declined order (OrderValidationError) returns a tool error, no meta is set', async () => {
    createOrderRecord.mockRejectedValue(new OrderValidationError('Selected location is not available'));
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'create_order', input: ORDER_INPUT }]))
      .mockResolvedValueOnce(textTurn('Looks like that location is unavailable.'));

    const { messages, meta } = await runChat([{ role: 'user', content: 'confirm order' }]);

    expect(meta).toBeNull();
    const toolResultMsg = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'tool_result');
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(toolResultMsg.content[0].content).toBe('Selected location is not available');
  });
});

describe('runChat — track_order tool', () => {
  test('finds by id/narration/orderNumber and returns order meta', async () => {
    prisma.order.findFirst.mockResolvedValue({
      narration: 'DFM-AB12CD',
      orderNumber: 10042,
      status: 'PACKED',
      total: 6000,
      items: [{ itemName: 'Jollof', size: '5L', quantity: 1 }],
      receipts: [{ status: 'CONFIRMED' }],
    });
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'track_order', input: { narration: '10042' } }]))
      .mockResolvedValueOnce(textTurn('Your order is packed!'));

    const { meta } = await runChat([{ role: 'user', content: 'wheres my order' }]);

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: '10042' }, { narration: '10042' }, { orderNumber: 10042 }] },
      include: { items: true, receipts: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    expect(meta).toEqual({
      narration: 'DFM-AB12CD',
      orderNumber: 10042,
      status: 'PACKED',
      total: 6000,
      cart: null,
      humanHandoff: null,
    });
  });

  test('a non-numeric lookup does not add the orderNumber OR clause', async () => {
    prisma.order.findFirst.mockResolvedValue({
      narration: 'DFM-AB12CD',
      orderNumber: 10042,
      status: 'PACKED',
      total: 6000,
      items: [],
      receipts: [],
    });
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'track_order', input: { narration: 'DFM-AB12CD' } }]))
      .mockResolvedValueOnce(textTurn('ok'));

    await runChat([{ role: 'user', content: 'track' }]);
    expect(prisma.order.findFirst.mock.calls[0][0].where.OR).toHaveLength(2);
  });

  test('a not-found order comes back as a tool error', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'track_order', input: { narration: 'nope' } }]))
      .mockResolvedValueOnce(textTurn("Couldn't find that order."));

    const { messages } = await runChat([{ role: 'user', content: 'track nope' }]);
    const toolResultMsg = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'tool_result');
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(toolResultMsg.content[0].content).toContain('No order found matching "nope"');
  });
});

describe('runChat — submit_feedback tool', () => {
  test('attaches feedback to the matched order', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'order1' });
    prisma.feedback.create.mockResolvedValue({});
    mockCreate
      .mockResolvedValueOnce(
        toolUseTurn([{ id: 'call1', name: 'submit_feedback', input: { narration: 'DFM-AB12CD', rating: 5, comment: 'Great!' } }])
      )
      .mockResolvedValueOnce(textTurn('Thanks for the feedback!'));

    await runChat([{ role: 'user', content: 'feedback' }]);

    expect(prisma.feedback.create).toHaveBeenCalledWith({
      data: { orderId: 'order1', rating: 5, comment: 'Great!' },
    });
  });

  test('a not-found order comes back as a tool error', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'submit_feedback', input: { narration: 'nope', rating: 5 } }]))
      .mockResolvedValueOnce(textTurn('hmm'));

    const { messages } = await runChat([{ role: 'user', content: 'feedback' }]);
    const toolResultMsg = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'tool_result');
    expect(toolResultMsg.content[0].is_error).toBe(true);
  });
});

describe('runChat — log_special_request tool', () => {
  test('logs the request, attaching the authenticated customer id when present', async () => {
    prisma.extraneousRequest.create.mockResolvedValue({});
    mockCreate
      .mockResolvedValueOnce(
        toolUseTurn([
          {
            id: 'call1',
            name: 'log_special_request',
            input: { requestType: 'item_request', message: '50 plates of amala', customerName: 'Jane', customerPhone: '08012345678' },
          },
        ])
      )
      .mockResolvedValueOnce(textTurn("I've noted that for the team."));

    const { meta } = await runChat([{ role: 'user', content: 'can I get 50 plates of amala' }], {
      authenticatedCustomerId: 'cust1',
    });

    expect(prisma.extraneousRequest.create).toHaveBeenCalledWith({
      data: {
        requestType: 'item_request',
        message: '50 plates of amala',
        customerName: 'Jane',
        customerPhone: '08012345678',
        orderNarration: null,
        customerId: 'cust1',
        source: 'WEB_CHAT',
      },
    });
    expect(meta).toBeNull(); // log_special_request doesn't populate any meta field
  });
});

describe('runChat — request_human_handoff tool', () => {
  test('surfaces meta.humanHandoff with the given reason', async () => {
    mockCreate
      .mockResolvedValueOnce(
        toolUseTurn([{ id: 'call1', name: 'request_human_handoff', input: { reason: 'Urgent order change' } }])
      )
      .mockResolvedValueOnce(textTurn("I've put a WhatsApp button up for you."));

    const { meta } = await runChat([{ role: 'user', content: 'let me talk to a human' }]);
    expect(meta).toEqual({ cart: null, humanHandoff: { reason: 'Urgent order change' } });
  });
});

describe('runChat — unexpected tool failure', () => {
  test('an unexpected (non-validation) error is swallowed into a generic tool error, not thrown', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    prisma.location.findMany.mockRejectedValue(new Error('DB exploded'));
    mockCreate
      .mockResolvedValueOnce(toolUseTurn([{ id: 'call1', name: 'list_locations', input: {} }]))
      .mockResolvedValueOnce(textTurn('Something went wrong, let me try again.'));

    const { messages } = await runChat([{ role: 'user', content: 'where do you deliver' }]);

    const toolResultMsg = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'tool_result');
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(toolResultMsg.content[0].content).toContain('Something went wrong on our end');
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('runChat — multiple tool calls in one round', () => {
  test('executes every tool_use block in the round and keeps the latest meta', async () => {
    getCatalog.mockResolvedValue([]);
    prisma.location.findMany.mockResolvedValue([]);
    mockCreate
      .mockResolvedValueOnce(
        toolUseTurn([
          { id: 'call1', name: 'list_menu', input: {} },
          { id: 'call2', name: 'list_locations', input: {} },
        ])
      )
      .mockResolvedValueOnce(textTurn('Here you go.'));

    const { messages } = await runChat([{ role: 'user', content: 'show me everything' }]);
    const toolResultMsg = messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
    expect(toolResultMsg.content).toHaveLength(2);
  });
});

describe('runChat — tool-round cap', () => {
  test('gives up with a friendly fallback message after MAX_TOOL_ROUNDS (6) rounds of tool use', async () => {
    getCatalog.mockResolvedValue([]);
    // Every round returns another tool_use turn — never settling on text.
    mockCreate.mockImplementation(() => Promise.resolve(toolUseTurn([{ id: 'call', name: 'list_menu', input: {} }])));

    const { messages, meta } = await runChat([{ role: 'user', content: 'loop forever' }]);

    expect(mockCreate).toHaveBeenCalledTimes(6);
    const last = messages[messages.length - 1];
    expect(last).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: "Sorry, that's taking a bit long — could you rephrase or try again?" }],
    });
    expect(meta).toBeNull(); // list_menu never populates meta, so none was ever set
  });
});
