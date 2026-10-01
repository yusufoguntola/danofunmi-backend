jest.mock('../../src/db', () => ({
  errorLog: { create: jest.fn() },
}));

const prisma = require('../../src/db');
const { logError } = require('../../src/lib/errorLog');

describe('logError', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('writes source/message/stack/context to the DB', async () => {
    prisma.errorLog.create.mockResolvedValue({});
    await logError({ source: 'http', message: 'boom', stack: 'at x.js:1', context: { path: '/a' } });

    expect(prisma.errorLog.create).toHaveBeenCalledWith({
      data: { source: 'http', message: 'boom', stack: 'at x.js:1', context: { path: '/a' } },
    });
  });

  test('falls back to "Unknown error" when message is missing', async () => {
    prisma.errorLog.create.mockResolvedValue({});
    await logError({ source: 'http' });

    expect(prisma.errorLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ message: 'Unknown error', stack: null }) })
    );
  });

  test('truncates an overlong message to 2000 chars and stack to 8000', async () => {
    prisma.errorLog.create.mockResolvedValue({});
    await logError({ source: 'http', message: 'x'.repeat(3000), stack: 'y'.repeat(9000) });

    const { data } = prisma.errorLog.create.mock.calls[0][0];
    expect(data.message).toHaveLength(2000);
    expect(data.stack).toHaveLength(8000);
  });

  test('context defaults to undefined (not null) when omitted', async () => {
    prisma.errorLog.create.mockResolvedValue({});
    await logError({ source: 'http', message: 'boom' });

    expect(prisma.errorLog.create.mock.calls[0][0].data.context).toBeUndefined();
  });

  test('swallows its own DB failure rather than throwing', async () => {
    prisma.errorLog.create.mockRejectedValue(new Error('DB is down'));
    await expect(logError({ source: 'http', message: 'boom' })).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('logError itself failed:', expect.any(Error));
  });
});
