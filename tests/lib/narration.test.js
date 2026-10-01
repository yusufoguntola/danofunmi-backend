const { generateNarration } = require('../../src/lib/narration');

describe('generateNarration', () => {
  test('matches the DFM-XXXXXX shape, using only the restricted alphabet', () => {
    // ABCDEFGHJKLMNPQRSTUVWXYZ23456789 — no I, O, 0, 1, so a customer reading
    // it back over the phone/WhatsApp never has to guess which letter/digit
    // was meant.
    const narration = generateNarration();
    expect(narration).toMatch(/^DFM-[A-HJ-NP-Z2-9]{6}$/);
  });

  test('is not the same every call', () => {
    const samples = new Set(Array.from({ length: 50 }, () => generateNarration()));
    // 50 draws from a 32^6 space colliding at all would be exceptionally
    // unlucky — this is really just checking the generator isn't constant.
    expect(samples.size).toBeGreaterThan(1);
  });
});
