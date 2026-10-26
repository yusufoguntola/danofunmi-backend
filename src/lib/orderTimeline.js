const prisma = require('../db');
const { ITEM_CUTOFF_DAY, computeOrderMonth, monthKey, monthLabel, ordinalDay } = require('./orderSchedule');

// The admin-set ordering timeline: when ordering opens and closes for the
// current run, and the delivery date range. OrderTimeline rows are
// append-only history — every save creates a new one, and the newest is the
// current timeline. Dates are calendar days with no time component — stored
// as Postgres DATE (which Prisma hands back as a UTC-midnight Date) and
// passed over the API as 'YYYY-MM-DD' strings.
const HISTORY_LIMIT = 50;
const FIELDS = ['opensOn', 'closesOn', 'deliveryStartsOn', 'deliveryEndsOn'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> a UTC-midnight Date, or null if it isn't a real calendar day. */
function parseDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || toDateString(date) !== value ? null : date;
}

function serialize(row) {
  if (!row) return null;
  const out = { id: row.id, createdAt: row.createdAt, createdByName: row.createdByName ?? null };
  for (const field of FIELDS) out[field] = toDateString(row[field]);
  return out;
}

const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }];

/** The current (newest) timeline as `{ id, opensOn, closesOn,
 * deliveryStartsOn, deliveryEndsOn, createdAt, createdByName }`
 * ('YYYY-MM-DD' dates), or null if none has ever been set. */
async function getOrderTimeline(client = prisma) {
  return serialize(await client.orderTimeline.findFirst({ orderBy: NEWEST_FIRST }));
}

/** Past and current timelines, newest (current) first. */
async function listOrderTimelineHistory(client = prisma) {
  const rows = await client.orderTimeline.findMany({ orderBy: NEWEST_FIRST, take: HISTORY_LIMIT });
  return rows.map(serialize);
}

/**
 * Validates an admin-submitted timeline. Returns `{ data }` (UTC-midnight
 * Dates, ready for Prisma) or `{ error }` describing the first problem.
 */
function validateOrderTimeline(body = {}) {
  const data = {};
  for (const field of FIELDS) {
    const date = parseDateString(body[field]);
    if (!date) return { error: `${field} must be a valid date (YYYY-MM-DD).` };
    data[field] = date;
  }
  if (data.closesOn < data.opensOn) return { error: 'Ordering must close on or after the day it opens.' };
  if (data.deliveryStartsOn <= data.closesOn) return { error: 'Delivery must start after ordering closes.' };
  if (data.deliveryEndsOn < data.deliveryStartsOn) return { error: 'Delivery must end on or after the day it starts.' };
  return { data };
}

/** Records `data` (from validateOrderTimeline) as the new current timeline —
 * a new history row, never an edit of an existing one. */
async function saveOrderTimeline(data, { createdByName } = {}, client = prisma) {
  return serialize(await client.orderTimeline.create({ data: { ...data, createdByName: createdByName || null } }));
}

/** '2026-11-16' -> '16th of November'. */
function formatTimelineDate(value) {
  const date = parseDateString(value);
  if (!date) return '';
  const month = date.toLocaleDateString('en-NG', { month: 'long', timeZone: 'UTC' });
  return `${ordinalDay(date.getUTCDate())} of ${month}`;
}

/** '16th – 18th of November', or '30th of November – 2nd of December' when
 * the range spans two months, or just '16th of November' for a single day. */
function formatDeliveryRange({ deliveryStartsOn, deliveryEndsOn }) {
  if (deliveryStartsOn === deliveryEndsOn) return formatTimelineDate(deliveryStartsOn);
  if (deliveryStartsOn.slice(0, 7) === deliveryEndsOn.slice(0, 7)) {
    const startDay = ordinalDay(Number(deliveryStartsOn.slice(8)));
    return `${startDay} – ${formatTimelineDate(deliveryEndsOn)}`;
  }
  return `${formatTimelineDate(deliveryStartsOn)} – ${formatTimelineDate(deliveryEndsOn)}`;
}

function localDateString(date) {
  return `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
}

function nextMonthKey(key) {
  const [year, month] = key.split('-').map(Number);
  return monthKey(new Date(year, month, 1));
}

/**
 * Which month's run (the admin month filter's orderMonth, 'YYYY-MM') an order
 * submitted `now` belongs to. With a timeline set: on or before its closing
 * day, the run being delivered (deliveryStartsOn's month); after it, the next
 * month's run — or, if admin has let the timeline go stale, whichever month
 * the fixed-day fallback gives, if that's later still. With none set: the
 * fixed-day fallback (lib/orderSchedule.js) alone.
 */
function orderMonthFor(timeline, now = new Date()) {
  const fallback = computeOrderMonth(ITEM_CUTOFF_DAY, now).orderMonth;
  if (!timeline) return fallback;
  const run = timeline.deliveryStartsOn.slice(0, 7);
  if (localDateString(now) <= timeline.closesOn) return run;
  const next = nextMonthKey(run);
  return next > fallback ? next : fallback;
}

async function resolveOrderMonth(now = new Date(), client = prisma) {
  return orderMonthFor(await getOrderTimeline(client), now);
}

/** Public snapshot for GET /api/orders/schedule — which month's run an order
 * placed now lands in, so the order page can say so before checkout. */
async function scheduleStatus(now = new Date()) {
  const timeline = await getOrderTimeline();
  const orderMonth = orderMonthFor(timeline, now);
  return {
    today: localDateString(now),
    closesOn: timeline?.closesOn ?? null,
    orderMonth,
    orderMonthLabel: monthLabel(orderMonth),
  };
}

module.exports = {
  getOrderTimeline,
  listOrderTimelineHistory,
  orderMonthFor,
  resolveOrderMonth,
  scheduleStatus,
  validateOrderTimeline,
  saveOrderTimeline,
  formatTimelineDate,
  formatDeliveryRange,
};
