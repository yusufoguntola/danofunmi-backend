const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
jest.mock('../../src/lib/menuCatalog', () => ({ getCatalog: jest.fn() }));

const { getCatalog } = require('../../src/lib/menuCatalog');
const { suggestItemsFromMessage, ChatNotConfiguredError } = require('../../src/lib/requestItemSuggester');

const CATALOG = [
  {
    type: 'item',
    name: 'Buka Stew',
    category: 'Soups',
    options: [
      { id: 'opt-buka-1l', size: '1L', price: 5000 },
      { id: 'opt-buka-5l', size: '5L', price: 20000 },
    ],
  },
  { type: 'group', name: 'Family Combo', category: 'Combos', total: 19500 },
];

function textResponse(text) {
  return { content: [{ type: 'text', text }] };
}

const ORIGINAL_ENV = { ...process.env };

describe('suggestItemsFromMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCatalog.mockResolvedValue(CATALOG);
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('throws ChatNotConfiguredError when no API key/token is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    await expect(suggestItemsFromMessage('2 pots of jollof')).rejects.toBeInstanceOf(ChatNotConfiguredError);
  });

  test('ANTHROPIC_AUTH_TOKEN alone is also sufficient', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'token';
    mockCreate.mockResolvedValue(textResponse('[]'));
    await expect(suggestItemsFromMessage('anything')).resolves.toEqual([]);
  });

  test('matches a menuItemOptionId against the catalog and reprices it server-side', async () => {
    mockCreate.mockResolvedValue(
      textResponse(JSON.stringify([{ itemName: 'ignored', size: 'ignored', quantity: 2, menuItemOptionId: 'opt-buka-5l' }]))
    );

    const result = await suggestItemsFromMessage('2 big pots of buka stew');

    expect(result).toEqual([
      { itemName: 'Buka Stew', size: '5L', quantity: 2, unitPrice: 20000, matched: true },
    ]);
  });

  test('an unmatched guess comes back with unitPrice 0 and matched:false', async () => {
    mockCreate.mockResolvedValue(
      textResponse(JSON.stringify([{ itemName: 'Custom Asun', size: 'Large tray', quantity: 3 }]))
    );

    const result = await suggestItemsFromMessage('3 large trays of asun');

    expect(result).toEqual([
      { itemName: 'Custom Asun', size: 'Large tray', quantity: 3, unitPrice: 0, matched: false },
    ]);
  });

  test('defaults quantity to 1 when missing/invalid, and size to "Standard" when blank', async () => {
    mockCreate.mockResolvedValue(
      textResponse(JSON.stringify([{ itemName: 'Mystery Item', quantity: -5 }]))
    );

    const result = await suggestItemsFromMessage('one mystery item');

    expect(result).toEqual([{ itemName: 'Mystery Item', size: 'Standard', quantity: 1, unitPrice: 0, matched: false }]);
  });

  test('a menuItemOptionId that no longer exists falls back to unmatched', async () => {
    mockCreate.mockResolvedValue(
      textResponse(JSON.stringify([{ itemName: 'Stew', size: '5L', quantity: 1, menuItemOptionId: 'opt-gone' }]))
    );

    const result = await suggestItemsFromMessage('a pot of stew');
    expect(result[0]).toMatchObject({ matched: false, unitPrice: 0 });
  });

  test('extracts a JSON array embedded in surrounding prose (no fenced JSON)', async () => {
    mockCreate.mockResolvedValue(
      textResponse('Sure, here you go:\n[{"itemName":"Jollof","size":"Large","quantity":1}]\nHope that helps!')
    );

    const result = await suggestItemsFromMessage('a large jollof');
    expect(result).toEqual([{ itemName: 'Jollof', size: 'Large', quantity: 1, unitPrice: 0, matched: false }]);
  });

  test('returns [] when the model responds with something that is not a JSON array', async () => {
    mockCreate.mockResolvedValue(textResponse('Sorry, I could not parse that request.'));
    await expect(suggestItemsFromMessage('???')).resolves.toEqual([]);
  });

  test('returns [] when the model returns a JSON object instead of an array', async () => {
    mockCreate.mockResolvedValue(textResponse('{"not": "an array"}'));
    await expect(suggestItemsFromMessage('???')).resolves.toEqual([]);
  });

  test('caps the result at 20 entries', async () => {
    const guesses = Array.from({ length: 30 }, (_, i) => ({ itemName: `Item ${i}`, quantity: 1 }));
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(guesses)));

    const result = await suggestItemsFromMessage('lots of items');
    expect(result).toHaveLength(20);
  });

  test('truncates an overlong itemName/size to their max lengths', async () => {
    mockCreate.mockResolvedValue(
      textResponse(JSON.stringify([{ itemName: 'x'.repeat(200), size: 'y'.repeat(100), quantity: 1 }]))
    );

    const result = await suggestItemsFromMessage('a very long name');
    expect(result[0].itemName).toHaveLength(100);
    expect(result[0].size).toHaveLength(50);
  });

  test('ignores non-object entries in the guesses array', async () => {
    mockCreate.mockResolvedValue(textResponse(JSON.stringify(['nonsense', null, { itemName: 'Real', quantity: 1 }])));
    const result = await suggestItemsFromMessage('mixed garbage');
    expect(result).toEqual([{ itemName: 'Real', size: 'Standard', quantity: 1, unitPrice: 0, matched: false }]);
  });

  test('includes the catalog summary (with option ids) in the prompt sent to the model', async () => {
    mockCreate.mockResolvedValue(textResponse('[]'));
    await suggestItemsFromMessage('whatever');

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain('Buka Stew');
    expect(call.messages[0].content).toContain('[id:opt-buka-5l]');
    expect(call.messages[0].content).toContain('whatever');
  });
});
