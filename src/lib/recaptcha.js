// Google reCAPTCHA v3 — invisible, score-based (0.0 = likely a bot, 1.0 =
// likely a human), no challenge UI. A no-op everywhere it's used if
// RECAPTCHA_SECRET_KEY isn't set, matching this project's pattern for
// optional external services (ANTHROPIC_API_KEY, VAPID_*, GOOGLE_CLIENT_ID).
const SCORE_THRESHOLD = 0.5;

function isConfigured() {
  return !!process.env.RECAPTCHA_SECRET_KEY;
}

async function verifyRecaptcha(token) {
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: process.env.RECAPTCHA_SECRET_KEY, response: token || '' }),
  });
  const data = await res.json();
  const ok = data.success === true && (data.score === undefined || data.score >= SCORE_THRESHOLD);
  if (!ok) console.warn('reCAPTCHA rejected:', JSON.stringify(data));
  return ok;
}

/** Express middleware factory. Rejects the request if reCAPTCHA is configured
 * and the token (req.body.recaptchaToken) is missing, invalid, or low-score.
 * A no-op if RECAPTCHA_SECRET_KEY isn't set. */
function requireRecaptcha() {
  return async (req, res, next) => {
    if (!isConfigured()) return next();

    const { recaptchaToken } = req.body;
    if (!recaptchaToken) {
      return res.status(400).json({ error: 'Missing verification token. Please refresh and try again.' });
    }

    try {
      const ok = await verifyRecaptcha(recaptchaToken);
      if (!ok) {
        return res.status(403).json({ error: "We couldn't verify this request. Please refresh and try again." });
      }
      next();
    } catch (err) {
      console.error('reCAPTCHA verification failed:', err);
      res.status(502).json({ error: 'Verification service unavailable — please try again shortly.' });
    }
  };
}

module.exports = { requireRecaptcha, isConfigured };
