// getFrontendOrigins reads straight from process.env at call time (no
// module-level caching), so these can all share one require.
const { getFrontendOrigins } = require('../../src/lib/frontendOrigins');

describe('getFrontendOrigins', () => {
  const ORIGINAL = process.env.FRONTEND_ORIGIN;

  afterEach(() => {
    process.env.FRONTEND_ORIGIN = ORIGINAL;
  });

  test('unset → empty array', () => {
    delete process.env.FRONTEND_ORIGIN;
    expect(getFrontendOrigins()).toEqual([]);
  });

  test('empty string → empty array', () => {
    process.env.FRONTEND_ORIGIN = '';
    expect(getFrontendOrigins()).toEqual([]);
  });

  test('a single origin', () => {
    process.env.FRONTEND_ORIGIN = 'https://danofunmi.com';
    expect(getFrontendOrigins()).toEqual(['https://danofunmi.com']);
  });

  test('comma-separated list', () => {
    process.env.FRONTEND_ORIGIN = 'https://danofunmi.com,https://www.danofunmi.com';
    expect(getFrontendOrigins()).toEqual(['https://danofunmi.com', 'https://www.danofunmi.com']);
  });

  test('also splits on semicolons, whitespace, and pipes', () => {
    process.env.FRONTEND_ORIGIN = 'https://a.com; https://b.com https://c.com|https://d.com';
    expect(getFrontendOrigins()).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
      'https://d.com',
    ]);
  });

  test('strips a surrounding quote pair on the whole value', () => {
    process.env.FRONTEND_ORIGIN = '"https://danofunmi.com,https://www.danofunmi.com"';
    expect(getFrontendOrigins()).toEqual(['https://danofunmi.com', 'https://www.danofunmi.com']);
  });

  test('strips quotes from individual items too', () => {
    process.env.FRONTEND_ORIGIN = `'https://a.com',"https://b.com"`;
    expect(getFrontendOrigins()).toEqual(['https://a.com', 'https://b.com']);
  });

  test('drops empty entries from stray separators', () => {
    process.env.FRONTEND_ORIGIN = 'https://a.com,,https://b.com,';
    expect(getFrontendOrigins()).toEqual(['https://a.com', 'https://b.com']);
  });
});
