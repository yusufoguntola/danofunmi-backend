jest.mock('../../src/lib/push', () => ({ sendPushToPhone: jest.fn() }));
jest.mock('../../src/lib/email', () => ({ sendOrderStatusEmail: jest.fn(), sendAdminReceiptNotificationEmail: jest.fn() }));

const { sendPushToPhone } = require('../../src/lib/push');
const { sendOrderStatusEmail, sendAdminReceiptNotificationEmail } = require('../../src/lib/email');
const { notifyOrderStatusChange, notifyAdminOfPayment } = require('../../src/lib/orderNotifications');

const ORDER = {
  id: 'order1',
  narration: 'DFM-AB12CD',
  status: 'PACKED',
  customer: { phone: '08012345678' },
};

describe('notifyOrderStatusChange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends push and email in parallel, with default copy derived from the order', async () => {
    sendPushToPhone.mockResolvedValue();
    sendOrderStatusEmail.mockResolvedValue();

    await notifyOrderStatusChange(ORDER);

    expect(sendPushToPhone).toHaveBeenCalledWith('08012345678', {
      title: 'Order DFM-AB12CD',
      body: 'Now PACKED',
      url: '/order/order1',
    });
    expect(sendOrderStatusEmail).toHaveBeenCalledWith(ORDER);
  });

  test('replaces underscores with spaces in the default body', async () => {
    sendPushToPhone.mockResolvedValue();
    sendOrderStatusEmail.mockResolvedValue();
    await notifyOrderStatusChange({ ...ORDER, status: 'OUT_FOR_DELIVERY' });
    expect(sendPushToPhone).toHaveBeenCalledWith(
      '08012345678',
      expect.objectContaining({ body: 'Now OUT FOR DELIVERY' })
    );
  });

  test('an explicit title/body overrides the derived copy', async () => {
    sendPushToPhone.mockResolvedValue();
    sendOrderStatusEmail.mockResolvedValue();
    await notifyOrderStatusChange(ORDER, { title: 'Custom title', body: 'Custom body' });
    expect(sendPushToPhone).toHaveBeenCalledWith(
      '08012345678',
      expect.objectContaining({ title: 'Custom title', body: 'Custom body' })
    );
  });

  test('resolves even if the push send fails (best-effort, logged not thrown)', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    sendPushToPhone.mockRejectedValue(new Error('push failed'));
    sendOrderStatusEmail.mockResolvedValue();

    await expect(notifyOrderStatusChange(ORDER)).resolves.toBeDefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('sendPushToPhone failed:', expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  test('resolves even if the email send fails (best-effort, logged not thrown)', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    sendPushToPhone.mockResolvedValue();
    sendOrderStatusEmail.mockRejectedValue(new Error('email failed'));

    await expect(notifyOrderStatusChange(ORDER)).resolves.toBeDefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('sendOrderStatusEmail failed:', expect.any(Error));
    consoleErrorSpy.mockRestore();
  });
});

describe('notifyAdminOfPayment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('delegates to sendAdminReceiptNotificationEmail', async () => {
    sendAdminReceiptNotificationEmail.mockResolvedValue();
    await notifyAdminOfPayment(ORDER);
    expect(sendAdminReceiptNotificationEmail).toHaveBeenCalledWith(ORDER);
  });

  test('swallows a failure rather than throwing', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    sendAdminReceiptNotificationEmail.mockRejectedValue(new Error('boom'));
    await expect(notifyAdminOfPayment(ORDER)).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('sendAdminReceiptNotificationEmail failed:', expect.any(Error));
    consoleErrorSpy.mockRestore();
  });
});
