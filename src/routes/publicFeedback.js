const express = require('express');
const prisma = require('../db');
const { authRateLimit, orderLookupRateLimit, requireBrowserOrigin } = require('../middleware/security');
const { requireRecaptcha } = require('../lib/recaptcha');

const router = express.Router();

function orderLookupWhere(idOrNarration) {
  const or = [{ id: idOrNarration }, { narration: idOrNarration }];
  if (/^\d+$/.test(idOrNarration)) or.push({ orderNumber: Number(idOrNarration) });
  return { OR: or };
}

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// Only the customer's first name is ever exposed here — never contact details.
function firstName(full) {
  const first = String(full || '').trim().split(/\s+/)[0];
  if (!first) return 'A customer';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Landing-page testimonials are capped at LANDING_FEEDBACK_LIMIT — the best
// ones (by rating, then recency — see orderBy below) from whatever admin has
// left enabled via visibleOnLanding always win, never just the most recent.
const LANDING_FEEDBACK_LIMIT = 6;

// GET /api/feedback — public. The top-rated feedback that carries a written
// comment, for the landing page "what customers say" section. Ratings-only
// feedback (no comment) is left for the admin dashboard. Admin can hide an
// individual row from here via visibleOnLanding without soft-deleting it.
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.feedback.findMany({
      where: { comment: { not: null }, deletedAt: null, visibleOnLanding: true },
      orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
      // Buffer above LANDING_FEEDBACK_LIMIT since the trim-filter below can
      // still drop a few (a comment that's whitespace-only after trimming).
      take: LANDING_FEEDBACK_LIMIT * 3,
      include: { order: { select: { customer: { select: { name: true } } } } },
    });

    const items = rows
      .filter((f) => f.comment && f.comment.trim().length > 0)
      .slice(0, LANDING_FEEDBACK_LIMIT)
      .map((f) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment.trim(),
        createdAt: f.createdAt,
        name: firstName(f.order?.customer?.name || f.customerName),
      }));

    res.json(items);
  } catch (err) {
    next(err);
  }
});

// GET /api/feedback/order/:idOrNarration — public, the minimal order info the
// post-delivery feedback page (linked from the delivery email — see
// lib/email.js) needs: deliberately a narrower shape than the order-tracking
// endpoint (no address/receipts/full customer record), plus whatever
// feedback already exists for it so the page can show a thank-you instead of
// the form on a repeat visit. Same enumeration-risk shape as order tracking,
// so it shares that endpoint's rate limit.
router.get('/order/:idOrNarration', orderLookupRateLimit, requireBrowserOrigin, async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: orderLookupWhere(req.params.idOrNarration),
      include: { customer: { select: { name: true } }, items: true },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const existing = await prisma.feedback.findFirst({
      where: { orderId: order.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      orderId: order.id,
      narration: order.narration,
      orderNumber: order.orderNumber,
      status: order.status,
      customerName: order.customer?.name || null,
      items: order.items.map((i) => ({ itemName: i.itemName, size: i.size, quantity: i.quantity })),
      existingFeedback: existing
        ? { rating: existing.rating, comment: existing.comment, createdAt: existing.createdAt }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/feedback/order/:idOrNarration — public, submits feedback for a
// delivered order. Only one feedback per order — an app-level check rather
// than a DB constraint, since Feedback is soft-deletable (deletedAt) and a
// unique index would block re-submission after admin soft-deletes a row.
router.post('/order/:idOrNarration', orderLookupRateLimit, requireBrowserOrigin, async (req, res, next) => {
  try {
    const rating = Number(req.body.rating);
    const comment = req.body.comment ? String(req.body.comment).trim().slice(0, 1000) || null : null;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
    }

    const order = await prisma.order.findFirst({ where: orderLookupWhere(req.params.idOrNarration) });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'DELIVERED') {
      return res.status(400).json({ error: 'Feedback can only be left once an order has been delivered.' });
    }

    const existing = await prisma.feedback.findFirst({ where: { orderId: order.id, deletedAt: null } });
    if (existing) {
      return res.status(409).json({
        error: "You've already left feedback for this order.",
        existingFeedback: { rating: existing.rating, comment: existing.comment, createdAt: existing.createdAt },
      });
    }

    const feedback = await prisma.feedback.create({ data: { orderId: order.id, rating, comment } });
    res.status(201).json({ rating: feedback.rating, comment: feedback.comment, createdAt: feedback.createdAt });
  } catch (err) {
    next(err);
  }
});

// POST /api/feedback/general — public, feedback that isn't about a specific
// order — reached via the standalone /feedback link (shared manually, or
// linked from the landing page — see SiteFooter.jsx), not the per-order
// /feedback/:id page linked from the delivery email. Everything but the
// rating is optional and free text — there's no order to pull a name/
// location/items from, so the customer can volunteer their own. More open
// to spam than the order-scoped endpoint (no order to check against), hence
// the rate limit + reCAPTCHA also used by the "I'm interested" form.
router.post('/general', authRateLimit, requireBrowserOrigin, requireRecaptcha(), async (req, res, next) => {
  try {
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
    }

    const feedback = await prisma.feedback.create({
      data: {
        orderId: null,
        rating,
        comment: clean(req.body.comment, 1000) || null,
        customerName: clean(req.body.customerName, 120) || null,
        location: clean(req.body.location, 120) || null,
        foodType: clean(req.body.foodType, 200) || null,
      },
    });
    res.status(201).json({ id: feedback.id, rating: feedback.rating, comment: feedback.comment, createdAt: feedback.createdAt });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
