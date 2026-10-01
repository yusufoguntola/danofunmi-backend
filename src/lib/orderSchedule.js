// The monthly ordering cutoff rule: individual menu-item lines may be
// ordered up to the 15th of the month, combo/group-deal lines only up to the
// 10th (they need more prep lead time) — anything submitted after its cutoff
// is batched into next month's processing instead. Single source of truth
// for these two numbers (also used by lib/email.js's GO_LIVE_SCHEDULE copy).
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

/**
 * Groups priced order lines (as produced by lib/orderCreation.js's
 * priceItems — each already carrying menuItemId/menuGroupId) by the month
 * they resolve to. Combo lines (menuGroupId set) use the stricter
 * COMBO_CUTOFF_DAY, individual lines the ITEM_CUTOFF_DAY. Returns one group
 * in the common case; two only when the cart has both line types and they
 * resolved to different months (e.g. placed on the 12th — combos already
 * rolled to next month, individual items haven't).
 */
function partitionLineItemsByCutoff(lineItems, now = new Date()) {
  const comboLines = lineItems.filter((l) => l.menuGroupId);
  const itemLines = lineItems.filter((l) => !l.menuGroupId);

  const comboMonth = comboLines.length ? computeOrderMonth(COMBO_CUTOFF_DAY, now).orderMonth : null;
  const itemMonth = itemLines.length ? computeOrderMonth(ITEM_CUTOFF_DAY, now).orderMonth : null;

  if (comboLines.length && itemLines.length && comboMonth !== itemMonth) {
    return [
      { orderMonth: comboMonth, lines: comboLines },
      { orderMonth: itemMonth, lines: itemLines },
    ];
  }
  return [{ orderMonth: comboMonth || itemMonth, lines: lineItems }];
}

/** Public snapshot of today's cutoff status, for the landing/menu/order
 * pages and the /api/orders/schedule endpoint — computed server-side so the
 * frontend never duplicates this date math. */
function scheduleStatus(now = new Date()) {
  const item = computeOrderMonth(ITEM_CUTOFF_DAY, now);
  const combo = computeOrderMonth(COMBO_CUTOFF_DAY, now);
  return {
    today: monthKey(now) + '-' + String(now.getDate()).padStart(2, '0'),
    itemCutoffDay: ITEM_CUTOFF_DAY,
    comboCutoffDay: COMBO_CUTOFF_DAY,
    itemOrderMonth: item.orderMonth,
    comboOrderMonth: combo.orderMonth,
    itemOrderMonthLabel: monthLabel(item.orderMonth),
    comboOrderMonthLabel: monthLabel(combo.orderMonth),
  };
}

module.exports = {
  ITEM_CUTOFF_DAY,
  COMBO_CUTOFF_DAY,
  monthKey,
  computeOrderMonth,
  monthLabel,
  ordinalDay,
  partitionLineItemsByCutoff,
  scheduleStatus,
};
