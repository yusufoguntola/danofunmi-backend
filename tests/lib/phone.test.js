const { isValidNigerianPhone } = require('../../src/lib/phone');

describe('isValidNigerianPhone', () => {
  test.each([
    ['08012345678', true], // local, 0 + 10 digits
    ['07012345678', true],
    ['09012345678', true],
    ['+2348012345678', true], // international with +
    ['2348012345678', true], // international without +
  ])('accepts %s', (phone) => {
    expect(isValidNigerianPhone(phone)).toBe(true);
  });

  test.each([
    ['', false],
    [null, false],
    [undefined, false],
    ['0801234567', false], // local, one digit short
    ['080123456789', false], // local, one digit too many
    ['+234801234567890', false], // international, too long
    ['+12345678901', false], // not a Nigerian prefix
    ['06012345678', false], // local but starts 6, not a mobile prefix
    ['abcdefghijk', false], // not digits at all
    ['+2340012345678', false], // starts with 234 but subscriber part starts 0
  ])('rejects %s', (phone) => {
    expect(isValidNigerianPhone(phone)).toBe(false);
  });
});
