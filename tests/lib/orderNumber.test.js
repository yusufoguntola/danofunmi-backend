const { generateOrderNumber } = require('../../src/lib/orderNumber');

describe('generateOrderNumber', () => {
  test('is always a 6-digit integer in [100000, 999999]', () => {
    for (let i = 0; i < 200; i++) {
      const n = generateOrderNumber();
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });

  test('is not the same every call', () => {
    const samples = new Set(Array.from({ length: 50 }, () => generateOrderNumber()));
    expect(samples.size).toBeGreaterThan(1);
  });
});
