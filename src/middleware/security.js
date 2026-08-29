const rateLimit = require('express-rate-limit');

// A generous, general ceiling on all API traffic per IP — the safety net.
// Skips /api/internal/*, which is the whatsapp-bot's own always-on service
// process (authenticated separately via INTERNAL_API_KEY), not a browser.
const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
  skip: (req) => req.originalUrl.startsWith('/api/internal'),
});

// Order lookup is the "farm other customers' orders by guessing IDs" target —
// each response includes the customer's name, phone, and address. A much
// tighter cap makes scripted guessing across the ~900,000 possible order
// numbers impractical from any single IP.
const orderLookupRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many order lookups. Please try again in a few minutes.' },
});

// Login/signup — brute-force / credential-stuffing protection.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

// Rejects requests that don't look like they came from the web app itself —
// i.e. a script hitting the API directly, which typically sends neither
// header. This is not a strong guarantee (both headers are attacker-
// controlled and easy to spoof for anyone motivated enough to read the
// frontend's network requests) but it filters out the casual bots/crawlers
// the vast majority of scraping tools actually are. A no-op if
// FRONTEND_ORIGIN isn't configured, so a fresh/misconfigured deploy doesn't
// lock everyone out.
function requireBrowserOrigin(req, res, next) {
  const allowed = process.env.FRONTEND_ORIGIN;
  if (!allowed) return next();

  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try {
      origin = new URL(req.headers.referer).origin;
    } catch {
      origin = null;
    }
  }

  if (origin !== allowed) {
    return res.status(403).json({ error: 'This request must come from the web app.' });
  }
  next();
}

module.exports = { apiRateLimit, orderLookupRateLimit, authRateLimit, requireBrowserOrigin };
