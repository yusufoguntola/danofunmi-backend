// getKey() caches the derived 32-byte key at module scope on first use, and
// isEnabled()/the key itself come straight from process.env — so every test
// that changes either needs a fresh module instance.
describe('payloadCrypto', () => {
  const ORIGINAL_ENABLED = process.env.PAYLOAD_OBFUSCATION_ENABLED;
  const ORIGINAL_KEY = process.env.PAYLOAD_OBFUSCATION_KEY;
  const HEX_KEY = 'a'.repeat(64); // 32 bytes of 0xaa
  const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

  afterEach(() => {
    process.env.PAYLOAD_OBFUSCATION_ENABLED = ORIGINAL_ENABLED;
    process.env.PAYLOAD_OBFUSCATION_KEY = ORIGINAL_KEY;
  });

  function load() {
    jest.resetModules();
    return require('../../src/lib/payloadCrypto');
  }

  describe('isEnabled', () => {
    test('true only for the literal string "true" (case-insensitive)', () => {
      process.env.PAYLOAD_OBFUSCATION_ENABLED = 'true';
      expect(load().isEnabled()).toBe(true);
    });

    test('"TRUE" also counts (case-insensitive)', () => {
      process.env.PAYLOAD_OBFUSCATION_ENABLED = 'TRUE';
      expect(load().isEnabled()).toBe(true);
    });

    test('unset, "false", or anything else → false', () => {
      delete process.env.PAYLOAD_OBFUSCATION_ENABLED;
      expect(load().isEnabled()).toBe(false);
      process.env.PAYLOAD_OBFUSCATION_ENABLED = 'false';
      expect(load().isEnabled()).toBe(false);
      process.env.PAYLOAD_OBFUSCATION_ENABLED = 'yes';
      expect(load().isEnabled()).toBe(false);
    });
  });

  describe('encryptString / decryptString round trip', () => {
    test('round-trips a plaintext string with a hex key', () => {
      process.env.PAYLOAD_OBFUSCATION_KEY = HEX_KEY;
      const { encryptString, decryptString } = load();
      const payload = encryptString('{"hello":"world"}');
      expect(decryptString(payload)).toBe('{"hello":"world"}');
    });

    test('round-trips with a base64 key', () => {
      process.env.PAYLOAD_OBFUSCATION_KEY = BASE64_KEY;
      const { encryptString, decryptString } = load();
      const payload = encryptString('some plaintext');
      expect(decryptString(payload)).toBe('some plaintext');
    });

    test('two encryptions of the same plaintext differ (random IV) but both decrypt correctly', () => {
      process.env.PAYLOAD_OBFUSCATION_KEY = HEX_KEY;
      const { encryptString, decryptString } = load();
      const a = encryptString('same text');
      const b = encryptString('same text');
      expect(a).not.toBe(b);
      expect(decryptString(a)).toBe('same text');
      expect(decryptString(b)).toBe('same text');
    });

    test('decrypting a tampered payload throws (auth tag check fails)', () => {
      process.env.PAYLOAD_OBFUSCATION_KEY = HEX_KEY;
      const { encryptString, decryptString } = load();
      const payload = encryptString('secret');
      const buf = Buffer.from(payload, 'base64');
      buf[buf.length - 1] ^= 0xff; // flip a bit in the auth tag
      expect(() => decryptString(buf.toString('base64'))).toThrow();
    });

    test('decrypting a too-short payload throws', () => {
      process.env.PAYLOAD_OBFUSCATION_KEY = HEX_KEY;
      const { decryptString } = load();
      expect(() => decryptString(Buffer.from('short').toString('base64'))).toThrow('ciphertext too short');
    });
  });

  describe('getKey validation', () => {
    test('a key that does not decode to 32 bytes throws', () => {
      process.env.PAYLOAD_OBFUSCATION_KEY = 'too-short';
      const { encryptString } = load();
      expect(() => encryptString('x')).toThrow('must decode to 32 bytes');
    });

    test('a missing key throws the same way', () => {
      delete process.env.PAYLOAD_OBFUSCATION_KEY;
      const { encryptString } = load();
      expect(() => encryptString('x')).toThrow('must decode to 32 bytes');
    });
  });
});
