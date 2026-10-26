const {
  ITEM_CUTOFF_DAY,
  COMBO_CUTOFF_DAY,
  monthKey,
  computeOrderMonth,
  monthLabel,
  ordinalDay,
} = require('../../src/lib/orderSchedule');

describe('monthKey', () => {
  test('formats as YYYY-MM', () => {
    expect(monthKey(new Date(2026, 9, 5))).toBe('2026-10'); // month is 0-indexed -> October
  });
});

describe('computeOrderMonth', () => {
  test('stays in the current month on/before the cutoff', () => {
    expect(computeOrderMonth(ITEM_CUTOFF_DAY, new Date(2026, 9, 15))).toEqual({ orderMonth: '2026-10', afterCutoff: false });
  });

  test('rolls into next month once past the cutoff', () => {
    expect(computeOrderMonth(ITEM_CUTOFF_DAY, new Date(2026, 9, 16))).toEqual({ orderMonth: '2026-11', afterCutoff: true });
  });

  test('rolling over December lands in next January', () => {
    expect(computeOrderMonth(ITEM_CUTOFF_DAY, new Date(2026, 11, 20))).toEqual({ orderMonth: '2027-01', afterCutoff: true });
  });

  test('combo cutoff is stricter than the item cutoff', () => {
    const now = new Date(2026, 9, 12); // the 12th: past combo cutoff (10th), not past item cutoff (15th)
    expect(computeOrderMonth(COMBO_CUTOFF_DAY, now).afterCutoff).toBe(true);
    expect(computeOrderMonth(ITEM_CUTOFF_DAY, now).afterCutoff).toBe(false);
  });
});

describe('monthLabel', () => {
  test('formats YYYY-MM as a readable month/year', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
  });
});

describe('ordinalDay', () => {
  test('formats the two real cutoff days', () => {
    expect(ordinalDay(COMBO_CUTOFF_DAY)).toBe('10th');
    expect(ordinalDay(ITEM_CUTOFF_DAY)).toBe('15th');
  });

  test('other suffixes', () => {
    expect(ordinalDay(1)).toBe('1st');
    expect(ordinalDay(2)).toBe('2nd');
    expect(ordinalDay(3)).toBe('3rd');
    expect(ordinalDay(11)).toBe('11th');
  });
});
