require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const connectDB  = require('./config/db');
const authRoutes    = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const courseRoutes  = require('./routes/courses');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const notificationRoutes = require('./routes/notifications');
const adminRoutes  = require('./routes/admin');
const timetableRoutes  = require('./routes/timetable');
const reminderRoutes = require('./routes/reminders');
const { startReminderCron } = require('./jobs/reminderCron');
const { startMorningDigestJob } = require('./jobs/morningDigest');

// ── Connect to MongoDB ────────────────────────────────────────────────────────
connectDB();
startReminderCron();
startMorningDigestJob();

const app = express();
app.set('trust proxy', 1);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());

app.use(
  cors({
    // In production replace '*' with your Flutter app's actual origin or
    // set CORS_ORIGIN in .env
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ── General rate limiter ──────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max:      parseInt(process.env.RATE_LIMIT_MAX)        || 100,
    message:  { success: false, message: 'Too many requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders:   false,
  })
);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({
    success: true,
    status:  'OK',
    time:    new Date().toISOString(),
    env:     process.env.NODE_ENV,
  })
);

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/timetable', timetableRoutes);
app.use('/api/reminders', reminderRoutes);

// ── 404 & Error Handlers ──────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 5000;
app.listen(PORT, '0.0.0.0',  () => {
  console.log(`🚀  Server running on port ${PORT} [${process.env.NODE_ENV}]`);
  console.log(`   Health check → http://localhost:${PORT}/health`);
});

module.exports = app;
