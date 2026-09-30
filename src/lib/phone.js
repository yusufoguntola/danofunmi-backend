// A Nigerian mobile number: optional "+", then "234" or a leading "0",
// then a 10-digit subscriber number starting 7/8/9 (every Nigerian mobile
// prefix). Accepts both the local "0801..." and international "234801..."
// forms — other write paths (admin edits, the WhatsApp bot, first-taste
// registrations) still use local format, so the validator has to accept
// both even though the web order/signup forms now always submit
// international (see frontend/src/lib/phone.js's NigerianPhoneInput).
const NG_PHONE_RE = /^\+?(?:234|0)[789]\d{9}$/;

function isValidNigerianPhone(phone) {
  return NG_PHONE_RE.test(String(phone || '').trim());
}

module.exports = { isValidNigerianPhone };
