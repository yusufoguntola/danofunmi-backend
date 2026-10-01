const mockSendMail = jest.fn();
jest.mock('zeptomail', () => ({
  SendMailClient: jest.fn().mockImplementation(() => ({ sendMail: mockSendMail })),
}));
jest.mock('../../src/db', () => ({ adminUser: { findMany: jest.fn() } }));

const ORIGINAL_ENV = { ...process.env };

function configureZoho() {
  process.env.ZOHO_BASE_URL = 'https://api.zeptomail.com/';
  process.env.ZOHO_API_KEY = 'zoho-key';
}

function clearZoho() {
  delete process.env.ZOHO_BASE_URL;
  delete process.env.ZOHO_API_KEY;
}

// getClient() caches its SendMailClient instance at module scope — fresh
// module graph per test keeps that cache (and ADMIN_EMAILS parsing) isolated.
function load() {
  jest.resetModules();
  jest.clearAllMocks();
  const email = require('../../src/lib/email');
  return { ...email, prisma: require('../../src/db'), SendMailClient: require('zeptomail').SendMailClient };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isConfigured', () => {
  test('true only when both ZOHO_BASE_URL and ZOHO_API_KEY are set', () => {
    configureZoho();
    expect(load().isConfigured()).toBe(true);

    clearZoho();
    expect(load().isConfigured()).toBe(false);

    process.env.ZOHO_BASE_URL = 'https://x';
    expect(load().isConfigured()).toBe(false);
  });
});

describe('sendFirstTasteConfirmationEmail', () => {
  test('a no-op (console log) when not configured', async () => {
    clearZoho();
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { sendFirstTasteConfirmationEmail } = load();

    await sendFirstTasteConfirmationEmail({ to: 'a@b.com', name: 'Ada' });

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('skipping receipt email'));
    consoleLogSpy.mockRestore();
  });

  test('sends with the receipt subject/html, addressed to the given name/email', async () => {
    configureZoho();
    const { sendFirstTasteConfirmationEmail, SendMailClient } = load();
    mockSendMail.mockResolvedValue({});

    await sendFirstTasteConfirmationEmail({ to: 'a@b.com', name: 'Ada', claimedSlot: true, landmark: 'Shoprite' });

    expect(SendMailClient).toHaveBeenCalledWith({ url: 'https://api.zeptomail.com/', token: 'zoho-key' });
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toEqual([{ email_address: { address: 'a@b.com', name: 'Ada' } }]);
    expect(call.subject).toBe("We've received your dánọ́fúnmi interest request");
    expect(call.htmlbody).toContain('first taste');
    expect(call.htmlbody).toContain('Shoprite');
  });

  test('a waitlisted (non-slot) registration gets the waitlist copy, no landmark row', async () => {
    configureZoho();
    const { sendFirstTasteConfirmationEmail } = load();
    mockSendMail.mockResolvedValue({});

    await sendFirstTasteConfirmationEmail({ to: 'a@b.com', name: 'Ada', claimedSlot: false });

    const html = mockSendMail.mock.calls[0][0].htmlbody;
    expect(html).toContain('added you to our waitlist');
    expect(html).not.toContain('Popular landmark near you');
  });

  test('falls back to "friend" when no name is given', async () => {
    configureZoho();
    const { sendFirstTasteConfirmationEmail } = load();
    mockSendMail.mockResolvedValue({});
    await sendFirstTasteConfirmationEmail({ to: 'a@b.com' });
    expect(mockSendMail.mock.calls[0][0].htmlbody).toContain('Thanks, friend');
  });
});

describe('sendShortlistConfirmationEmail', () => {
  test('a no-op when not configured', async () => {
    clearZoho();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { sendShortlistConfirmationEmail } = load();
    await sendShortlistConfirmationEmail({ to: 'a@b.com', name: 'Ada' });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('sends the "you made the list" email', async () => {
    configureZoho();
    const { sendShortlistConfirmationEmail } = load();
    mockSendMail.mockResolvedValue({});
    await sendShortlistConfirmationEmail({ to: 'a@b.com', name: 'Ada' });

    const call = mockSendMail.mock.calls[0][0];
    expect(call.subject).toContain('You made the dánọ́fúnmi first-taste list');
    expect(call.htmlbody).toContain('You made the list');
  });
});

const BASE_ORDER = {
  narration: 'DFM-AB12CD',
  status: 'PACKED',
  total: 25000,
  customer: { email: 'cust@b.com', name: 'Customer Name' },
  items: [{ itemName: 'Jollof', size: '5L', quantity: 1, lineTotal: 25000 }],
};

describe('sendOrderStatusEmail', () => {
  test('a no-op when the order has no customer email on file', async () => {
    configureZoho();
    const { sendOrderStatusEmail } = load();
    await sendOrderStatusEmail({ ...BASE_ORDER, customer: {} });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('a no-op (console log) when not configured, even with an email on file', async () => {
    clearZoho();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { sendOrderStatusEmail } = load();
    await sendOrderStatusEmail(BASE_ORDER);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('sends with a status-specific subject/heading and a track-order CTA', async () => {
    configureZoho();
    process.env.FRONTEND_ORIGIN = 'https://danofunmi.com';
    const { sendOrderStatusEmail } = load();
    mockSendMail.mockResolvedValue({});

    await sendOrderStatusEmail(BASE_ORDER);

    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toEqual([{ email_address: { address: 'cust@b.com', name: 'Customer Name' } }]);
    expect(call.subject).toBe('Order DFM-AB12CD — Packed');
    expect(call.htmlbody).toContain('packed and is ready to go out');
    expect(call.htmlbody).toContain('https://danofunmi.com/order/');
    expect(call.htmlbody).not.toContain('Leave feedback');
  });

  test('switches the CTA to "Leave feedback" once DELIVERED', async () => {
    configureZoho();
    process.env.FRONTEND_ORIGIN = 'https://danofunmi.com';
    const { sendOrderStatusEmail } = load();
    mockSendMail.mockResolvedValue({});

    await sendOrderStatusEmail({ ...BASE_ORDER, status: 'DELIVERED' });

    const html = mockSendMail.mock.calls[0][0].htmlbody;
    expect(html).toContain('Leave feedback');
    expect(html).toContain('/feedback/');
  });

  test('omits the CTA entirely when FRONTEND_ORIGIN is not set', async () => {
    configureZoho();
    delete process.env.FRONTEND_ORIGIN;
    const { sendOrderStatusEmail } = load();
    mockSendMail.mockResolvedValue({});

    await sendOrderStatusEmail(BASE_ORDER);
    const html = mockSendMail.mock.calls[0][0].htmlbody;
    expect(html).not.toContain('Track your order');
    expect(html).not.toContain('Leave feedback');
  });

  test('escapes item names in the line-item table', async () => {
    configureZoho();
    const { sendOrderStatusEmail } = load();
    mockSendMail.mockResolvedValue({});
    await sendOrderStatusEmail({
      ...BASE_ORDER,
      items: [{ itemName: '<b>Evil</b>', size: '1L', quantity: 1, lineTotal: 1000 }],
    });
    const html = mockSendMail.mock.calls[0][0].htmlbody;
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });

  test('falls back to the raw status as the label when it is unrecognized', async () => {
    configureZoho();
    const { sendOrderStatusEmail } = load();
    mockSendMail.mockResolvedValue({});
    await sendOrderStatusEmail({ ...BASE_ORDER, status: 'SOME_NEW_STATUS' });
    expect(mockSendMail.mock.calls[0][0].subject).toContain('SOME_NEW_STATUS');
  });
});

describe('sendAdminReceiptNotificationEmail', () => {
  test('a no-op (console log) when not configured — never even queries admins', async () => {
    clearZoho();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { sendAdminReceiptNotificationEmail, prisma: p } = load();
    await sendAdminReceiptNotificationEmail(BASE_ORDER);
    expect(p.adminUser.findMany).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('a no-op when there are no admin accounts', async () => {
    configureZoho();
    const { sendAdminReceiptNotificationEmail, prisma: p } = load();
    p.adminUser.findMany.mockResolvedValue([]);
    await sendAdminReceiptNotificationEmail(BASE_ORDER);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('emails every admin account', async () => {
    configureZoho();
    const { sendAdminReceiptNotificationEmail, prisma: p } = load();
    p.adminUser.findMany.mockResolvedValue([
      { email: 'admin1@b.com', name: 'Admin One' },
      { email: 'admin2@b.com', name: null },
    ]);
    mockSendMail.mockResolvedValue({});

    await sendAdminReceiptNotificationEmail({ ...BASE_ORDER, customer: { name: 'Buyer', phone: '08011111111' } });

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockSendMail.mock.calls[0][0].to).toEqual([{ email_address: { address: 'admin1@b.com', name: 'Admin One' } }]);
    expect(mockSendMail.mock.calls[0][0].subject).toContain('DFM-AB12CD');
    expect(mockSendMail.mock.calls[0][0].htmlbody).toContain('Buyer');
  });
});

describe('sendAdminAlertEmail', () => {
  test('a no-op when ADMIN_EMAILS is not set, even if Zoho is configured', async () => {
    configureZoho();
    delete process.env.ADMIN_EMAILS;
    const { sendAdminAlertEmail } = load();
    await sendAdminAlertEmail({ subject: 'Crash', message: 'boom' });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('a no-op (console log) when ADMIN_EMAILS is set but Zoho is not configured', async () => {
    clearZoho();
    process.env.ADMIN_EMAILS = 'owner@b.com';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { sendAdminAlertEmail } = load();
    await sendAdminAlertEmail({ subject: 'Crash', message: 'boom' });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('emails every comma-separated ADMIN_EMAILS address, trimmed', async () => {
    configureZoho();
    process.env.ADMIN_EMAILS = ' owner@b.com, dev@b.com ';
    const { sendAdminAlertEmail } = load();
    mockSendMail.mockResolvedValue({});

    await sendAdminAlertEmail({ subject: 'Server error', message: 'Something broke', context: 'stack trace here' });

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockSendMail.mock.calls[0][0].to).toEqual([{ email_address: { address: 'owner@b.com' } }]);
    expect(mockSendMail.mock.calls[0][0].subject).toBe('[dánọ́fúnmi alert] Server error');
    expect(mockSendMail.mock.calls[0][0].htmlbody).toContain('Something broke');
    expect(mockSendMail.mock.calls[0][0].htmlbody).toContain('stack trace here');
  });

  test('omits the context block when none is given', async () => {
    configureZoho();
    process.env.ADMIN_EMAILS = 'owner@b.com';
    const { sendAdminAlertEmail } = load();
    mockSendMail.mockResolvedValue({});
    await sendAdminAlertEmail({ subject: 'Crash', message: 'boom' });
    expect(mockSendMail.mock.calls[0][0].htmlbody).not.toContain('<pre');
  });
});

describe('sendBroadcastEmail', () => {
  test('a no-op when not configured', async () => {
    clearZoho();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { sendBroadcastEmail } = load();
    await sendBroadcastEmail({ to: 'a@b.com', title: 'New menu!', body: 'Check it out' });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('sends the admin-authored title/body, preserving line breaks and escaping HTML', async () => {
    configureZoho();
    const { sendBroadcastEmail } = load();
    mockSendMail.mockResolvedValue({});

    await sendBroadcastEmail({ to: 'a@b.com', name: 'Ada', title: 'New menu!', body: 'Line one\n<script>bad</script>' });

    const call = mockSendMail.mock.calls[0][0];
    expect(call.subject).toBe('New menu!');
    expect(call.htmlbody).toContain('white-space:pre-wrap');
    expect(call.htmlbody).toContain('&lt;script&gt;bad&lt;/script&gt;');
  });
});
