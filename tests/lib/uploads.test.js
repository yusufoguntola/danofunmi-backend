// RECEIPT_MAX_FILE_SIZE_KB is parsed once, at module load time, from
// process.env — so each case here needs a fresh module instance (jest's
// module registry reset) with the env var set beforehand.
describe('RECEIPT_MAX_FILE_SIZE_KB parsing', () => {
  const ORIGINAL_ENV = process.env.RECEIPT_MAX_FILE_SIZE_KB;

  afterEach(() => {
    process.env.RECEIPT_MAX_FILE_SIZE_KB = ORIGINAL_ENV;
  });

  function loadWith(value) {
    jest.resetModules();
    if (value === undefined) delete process.env.RECEIPT_MAX_FILE_SIZE_KB;
    else process.env.RECEIPT_MAX_FILE_SIZE_KB = value;
    return require('../../src/lib/uploads');
  }

  test('uses the env value when it is a positive number', () => {
    const { RECEIPT_MAX_FILE_SIZE_KB, RECEIPT_MAX_BYTES } = loadWith('5000');
    expect(RECEIPT_MAX_FILE_SIZE_KB).toBe(5000);
    expect(RECEIPT_MAX_BYTES).toBe(5000 * 1024);
  });

  test('falls back to 15360 (15MB) when unset', () => {
    const { RECEIPT_MAX_FILE_SIZE_KB } = loadWith(undefined);
    expect(RECEIPT_MAX_FILE_SIZE_KB).toBe(15360);
  });

  test.each(['0', '-100', 'not-a-number', ''])('falls back to the default for an invalid value %s', (value) => {
    const { RECEIPT_MAX_FILE_SIZE_KB } = loadWith(value);
    expect(RECEIPT_MAX_FILE_SIZE_KB).toBe(15360);
  });
});
