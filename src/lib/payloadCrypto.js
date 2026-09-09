// Optional symmetric encryption of JSON API payloads, layered on top of HTTPS
// (defence in depth / traffic obfuscation). AES-256-GCM with a pre-shared key
// from the environment. A no-op unless ENCRYPTION_ENABLED is "true", matching
// this project's pattern for optional features.
//
// Wire format for a payload: base64( iv[12] | ciphertext | authTag[16] ).

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function isEnabled() {
  return String(process.env.ENCRYPTION_ENABLED).toLowerCase() === 'true';
}

let cachedKey;
function getKey() {
  if (cachedKey) return cachedKey;
  const raw = (process.env.ENCRYPTION_KEY || '').trim();
  // Accept a 64-char hex string or standard base64; both must decode to 32 bytes.
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes (hex or base64) for AES-256-GCM');
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
