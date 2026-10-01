// The Express app itself, separate from index.js's `app.listen(...)` — so
// tests can require this and drive it with supertest without binding a real
// port (see app.test.js).
require('dotenv').config();
const path = require('path');
const express = require('express');
// Patches Express's routing so a rejected promise from an async route
// handler (anywhere — not just routes written to expect it) is forwarded to
// next(err)/the error-handling middleware below, same as Express 5 does
// natively. Without this, Express 4 leaves that rejection unhandled and the
// request just hangs forever instead of getting a response. Must be
// required after `express` and before any router/route is registered.
require('express-async-errors');
const cors = require('cors');

const menuRoutes = require('./routes/menu');
const locationRoutes = require('./routes/locations');
const orderRoutes = require('./routes/orders');
const authRoutes = require('./routes/auth');
const costRoutes = require('./routes/costs');
const reportRoutes = require('./routes/reports');
const internalRoutes = require('./routes/internal');
const chatRoutes = require('./routes/chat');
const feedbackRoutes = require('./routes/feedback');
const publicFeedbackRoutes = require('./routes/publicFeedback');
const requestRoutes = require('./routes/requests');
const { publicRouter: interestRoutes, adminRouter: adminInterestRoutes } = require('./routes/interest');
const pushRoutes = require('./routes/push');
const customerRoutes = require('./routes/customer');
const adminCustomerRoutes = require('./routes/adminCustomers');
const broadcastRoutes = require('./routes/broadcast');
const adminErrorLogRoutes = require('./routes/adminErrorLogs');
const {apiRateLimit} = require('./middleware/security');
const {decryptRequest, encryptResponse} = require('./middleware/encryption');
const {getFrontendOrigins} = require('./lib/frontendOrigins');
const {RECEIPT_MAX_FILE_SIZE_KB} = require('./lib/uploads');
const {logError} = require('./lib/errorLog');
const {sendAdminAlertEmail} = require('./lib/email');

const app = express();

// Deployed behind nginx (see deploy.sh) — without this, req.ip resolves to
// nginx's own address for every request, so express-rate-limit would rate
// limit all real users as a single client instead of per-IP.
app.set('trust proxy', 1);

const allowedOrigins = getFrontendOrigins();
// app.use(cors({ origin: frontendOrigins.length ? frontendOrigins : '*' }));

// Single, robust CORS configuration
const corsOptions = {
    origin: (origin, callback) => {
        // 1. Allow server-to-server, Postman, healthchecks, or missing origin header
        if (!origin || allowedOrigins.length === 0) {
            return callback(null, true);
        }

        // 2. Strict matching against allowed array
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // 3. Reject safely without throwing a server error
        return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Origin',
        'X-Encrypted'
    ],
    exposedHeaders: ['X-Encrypted'],
    optionsSuccessStatus: 200 // Fixes 204 issue on proxies/older clients
};


app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json());
// Unwrap opted-in request bodies and wrap their responses (no-op unless
// PAYLOAD_OBFUSCATION_ENABLED). Must sit after express.json() (the envelope is
// JSON) and before any route reads req.body or calls res.json.
app.use(decryptRequest);
app.use(encryptResponse);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/api', apiRateLimit);

app.get('/health', (req, res) => res.json({ok: true}));

app.get('/api/payment-info', (req, res) => {
    res.json({
        bankName: process.env.BANK_NAME,
        accountName: process.env.BANK_ACCOUNT_NAME,
        accountNumber: process.env.BANK_ACCOUNT_NUMBER,
        maxReceiptFileSizeKB: RECEIPT_MAX_FILE_SIZE_KB,
    });
});

// Public + mixed (admin sub-paths, e.g. /api/menu/admin/all, are guarded
// per-route with requireAdmin inside each router).
app.use('/api/menu', menuRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/feedback', publicFeedbackRoutes);
app.use('/api/interest', interestRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', authRoutes);
app.use('/api/admin/costs', costRoutes);
app.use('/api/admin/reports', reportRoutes);
app.use('/api/admin/feedback', feedbackRoutes);
app.use('/api/admin/requests', requestRoutes);
app.use('/api/admin/interest', adminInterestRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/admin/customers', adminCustomerRoutes);
app.use('/api/admin/broadcast', broadcastRoutes);
app.use('/api/admin/error-logs', adminErrorLogRoutes);
app.use('/api/push', pushRoutes);

// Internal-only, used by the whatsapp-bot service
app.use('/api/internal', internalRoutes);

app.use((req, res) => res.status(404).json({error: 'Not found'}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || 500;

    // Logged for admin to review (item: "log such issues for the admin to
    // see and review") regardless of severity — fire-and-forget, never
    // blocks or delays the actual error response below.
    logError({
        source: 'http',
        message: err.message,
        stack: err.stack,
        context: {method: req.method, path: req.path, status},
    }).catch(() => {});

    // Only the genuinely unexpected ones (5xx — routes handle their own
    // validation errors as 4xx without reaching this far) are worth an
    // immediate email; those are the "crash" this alert is for.
    if (status >= 500) {
        sendAdminAlertEmail({
            subject: `Server error on ${req.method} ${req.path}`,
            message: err.message || 'Unknown error',
            context: err.stack,
        }).catch((alertErr) => console.error('sendAdminAlertEmail failed:', alertErr));
    }

    res.status(status).json({error: err.message || 'Server error'});
});

module.exports = app;
