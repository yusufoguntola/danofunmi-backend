jest.mock('../../src/db', () => ({ orderTimeline: { findUnique: jest.fn(), upsert: jest.fn() } }));

const prisma = require('../../src/db');
const {
  getOrderTimeline,
  validateOrderTimeline,
  saveOrderTimeline,
  formatTimelineDate,
  formatDeliveryRange,
  orderMonthFor,
  scheduleStatus,
} = require('../../src/lib/orderTimeline');

const VALID = {
  opensOn: '2026-10-25',
  closesOn: '2026-11-13',
  deliveryStartsOn: '2026-11-16',
  deliveryEndsOn: '2026-11-18',
};

const ROW = {
  id: 'singleton',
  opensOn: new Date('2026-10-25T00:00:00Z'),
  closesOn: new Date('2026-11-13T00:00:00Z'),
  deliveryStartsOn: new Date('2026-11-16T00:00:00Z'),
  deliveryEndsOn: new Date('2026-11-18T00:00:00Z'),
  updatedAt: new Date('2026-10-26T09:00:00Z'),
};

beforeEach(() => jest.clearAllMocks());

describe('getOrderTimeline', () => {
  test('serializes the stored dates as YYYY-MM-DD', async () => {
    prisma.orderTimeline.findUnique.mockResolvedValue(ROW);
    expect(await getOrderTimeline()).toEqual({ ...VALID, updatedAt: ROW.updatedAt });
  });

  test('null when no timeline is set', async () => {
    prisma.orderTimeline.findUnique.mockResolvedValue(null);
    expect(await getOrderTimeline()).toBeNull();
  });
});

describe('validateOrderTimeline', () => {
  test('accepts a valid timeline as UTC-midnight dates', () => {
    const { data, error } = validateOrderTimeline(VALID);
    expect(error).toBeUndefined();
    expect(data.closesOn).toEqual(new Date('2026-11-13T00:00:00Z'));
  });

  test.each([
    ['a missing date', { ...VALID, opensOn: undefined }, /opensOn must be a valid date/],
    ['a non-existent day', { ...VALID, closesOn: '2026-02-30' }, /closesOn must be a valid date/],
    ['a malformed date', { ...VALID, deliveryEndsOn: '18/11/2026' }, /deliveryEndsOn must be a valid date/],
    ['closing before opening', { ...VALID, closesOn: '2026-10-24' }, /close on or after/],
    ['delivery starting on or before closing', { ...VALID, deliveryStartsOn: '2026-11-13' }, /start after ordering closes/],
    ['delivery ending before it starts', { ...VALID, deliveryEndsOn: '2026-11-15' }, /end on or after/],
  ])('rejects %s', (_label, body, message) => {
    expect(validateOrderTimeline(body).error).toMatch(message);
  });
});

describe('saveOrderTimeline', () => {
  test('upserts the singleton row and returns it serialized', async () => {
    prisma.orderTimeline.upsert.mockResolvedValue(ROW);
    const { data } = validateOrderTimeline(VALID);
    expect(await saveOrderTimeline(data)).toEqual({ ...VALID, updatedAt: ROW.updatedAt });
    expect(prisma.orderTimeline.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      update: data,
      create: { id: 'singleton', ...data },
    });
  });
});

describe('formatting', () => {
  test('formatTimelineDate', () => {
    expect(formatTimelineDate('2026-10-25')).toBe('25th of October');
    expect(formatTimelineDate('2026-11-01')).toBe('1st of November');
    expect(formatTimelineDate('2026-11-13')).toBe('13th of November');
  });

  test('formatDeliveryRange within one month', () => {
    expect(formatDeliveryRange(VALID)).toBe('16th – 18th of November');
  });

  test('formatDeliveryRange across two months', () => {
    expect(formatDeliveryRange({ deliveryStartsOn: '2026-11-30', deliveryEndsOn: '2026-12-02' })).toBe(
      '30th of November – 2nd of December'
    );
  });

  test('formatDeliveryRange for a single day', () => {
    expect(formatDeliveryRange({ deliveryStartsOn: '2026-11-16', deliveryEndsOn: '2026-11-16' })).toBe(
      '16th of November'
    );
  });
});

describe('orderMonthFor', () => {
  test('on or before the closing day: the run being delivered', () => {
    expect(orderMonthFor(VALID, new Date(2026, 9, 25, 9))).toBe('2026-11');
    expect(orderMonthFor(VALID, new Date(2026, 10, 13, 23, 59))).toBe('2026-11');
  });

  test('after the closing day: the next month\'s run', () => {
    expect(orderMonthFor(VALID, new Date(2026, 10, 14, 0, 1))).toBe('2026-12');
  });

  test('a stale timeline never assigns an order to a month already past', () => {
    expect(orderMonthFor(VALID, new Date(2027, 2, 20))).toBe('2027-04');
  });

  test('a December run rolls over into January', () => {
    const dec = { ...VALID, closesOn: '2026-12-11', deliveryStartsOn: '2026-12-14', deliveryEndsOn: '2026-12-16' };
    expect(orderMonthFor(dec, new Date(2026, 11, 12))).toBe('2027-01');
  });

  test('no timeline: the fixed 15th fallback', () => {
    expect(orderMonthFor(null, new Date(2026, 9, 15))).toBe('2026-10');
    expect(orderMonthFor(null, new Date(2026, 9, 16))).toBe('2026-11');
  });
});

describe('scheduleStatus', () => {
  test('reports the closing day and the month an order placed now lands in', async () => {
    prisma.orderTimeline.findUnique.mockResolvedValue(ROW);
    expect(await scheduleStatus(new Date(2026, 9, 26))).toEqual({
      today: '2026-10-26',
      closesOn: '2026-11-13',
      orderMonth: '2026-11',
      orderMonthLabel: 'November 2026',
    });
  });
});
