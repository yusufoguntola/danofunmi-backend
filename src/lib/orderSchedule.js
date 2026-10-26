// Fixed day-of-month cutoffs — now only the fallback for when admin hasn't
// set an order timeline (see lib/orderTimeline.js's resolveOrderMonth, which
// otherwise cuts off on the timeline's closing date): anything submitted
// after the 15th is batched into next month's run. COMBO_CUTOFF_DAY no longer
// drives ordering; it's kept only for the (already-sent) go-live email's
// schedule copy in lib/email.js.
const ITEM_CUTOFF_DAY = 15;
const COMBO_CUTOFF_DAY = 10;

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, date.getDate());
}

/** Which month a line submitted `now` lands in, given its cutoff day. */
function computeOrderMonth(cutoffDay, now = new Date()) {
  const afterCutoff = now.getDate() > cutoffDay;
  const monthDate = afterCutoff ? addMonths(now, 1) : now;
  return { orderMonth: monthKey(monthDate), afterCutoff };
}

/** 10 -> '10th', 15 -> '15th'. Only ever called with the two cutoff
 * constants above, so this doesn't need to handle every day 1-31. */
function ordinalDay(day) {
  if (day % 10 === 1 && day !== 11) return `${day}st`;
  if (day % 10 === 2 && day !== 12) return `${day}nd`;
  if (day % 10 === 3 && day !== 13) return `${day}rd`;
  return `${day}th`;
}

/** 'YYYY-MM' -> 'October 2026'. */
function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

module.exports = {
  ITEM_CUTOFF_DAY,
  COMBO_CUTOFF_DAY,
  monthKey,
  computeOrderMonth,
  monthLabel,
  ordinalDay,
};
