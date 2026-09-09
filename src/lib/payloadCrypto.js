// Optional AES-256-GCM wrapping of JSON API payloads, layered on top of HTTPS.
// A no-op unless PAYLOAD_OBFUSCATION_ENABLED is "true".
//
// This is *obfuscation*, not end-to-end confidentiality: the peer key lives in
// the frontend bundle (VITE_PAYLOAD_OBFUSCATION_KEY) and is readable by any
// user, so anyone motivated can decrypt. It only raises the bar against casual
// on-the-wire inspection. TLS remains the real transport security.
//
// Wire format for a payload: base64( iv[12] | ciphertext | authTag[16] ).

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function isEnabled() {
  return String(process.env.PAYLOAD_OBFUSCATION_ENABLED).toLowerCase() === 'true';
}

let cachedKey;
function getKey() {
  if (cachedKey) return cachedKey;
  const raw = (process.env.PAYLOAD_OBFUSCATION_KEY || '').trim();
  // Accept a 64-char hex string or standard base64; both must decode to 32 bytes.
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('PAYLOAD_OBFUSCATION_KEY must decode to 32 bytes (hex or base64) for AES-256-GCM');
  }
  cachedKey = buf;
  return buf;
}

function encryptString(plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

function decryptString(payload) {
  const buf = Buffer.from(String(payload), 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { isEnabled, encryptString, decryptString };
