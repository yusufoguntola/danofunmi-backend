require('dotenv').config();
const path = require('path');
const express = require('express');
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
const pushRoutes = require('./routes/push');
const customerRoutes = require('./routes/customer');
const { apiRateLimit } = require('./middleware/security');
const { getFrontendOrigins } = require('./lib/frontendOrigins');

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
    // 1. Allow non-browser requests (Postman, curl, server-to-server, healthchecks)
    // OR if no origins are configured in ENV
    if (!origin || allowedOrigins.length === 0) {
      return callback(null, true);
    }

    // 2. Strict origin check against your environment array
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // 3. Reject untrusted browser origins
    return callback(new Error('CORS policy: This origin is not allowed.'));
  },
  // credentials: true, // Set to true if using cookies/Authorization headers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};


app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/api', apiRateLimit);

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/payment-info', (req, res) => {
  res.json({
    bankName: process.env.BANK_NAME,
    accountName: process.env.BANK_ACCOUNT_NAME,
    accountNumber: process.env.BANK_ACCOUNT_NUMBER,
  });
});

// Public + mixed (admin sub-paths, e.g. /api/menu/admin/all, are guarded
// per-route with requireAdmin inside each router).
app.use('/api/menu', menuRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', authRoutes);
app.use('/api/admin/costs', costRoutes);
app.use('/api/admin/reports', reportRoutes);
app.use('/api/admin/feedback', feedbackRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/push', pushRoutes);

// Internal-only, used by the whatsapp-bot service
app.use('/api/internal', internalRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`danofunmi backend listening on :${port}`));
