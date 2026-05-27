const express  = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const User      = require('../models/User');
const {
  protect,
  generateAccessToken,
  generateRefreshToken,
} = require('../middleware/auth');

const router = express.Router();

// ── Stricter rate limit for auth endpoints ────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,                              // 15 minutes
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message:  { success: false, message: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ── Helper ────────────────────────────────────────────────────────────────────
const sendTokens = async (user, statusCode, res) => {
  const accessToken  = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);

  // Persist hashed refresh token
  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  res.status(statusCode).json({
    success:      true,
    accessToken,
    refreshToken,
    user: {
      id:      user._id,
      email:   user.email,
      profile: user.profile,
      grading: user.grading,
    },
  });
};

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post(
  '/register',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('profile.name').notEmpty().withMessage('Full name is required'),
    body('profile.matricNumber').notEmpty().withMessage('Matric number is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, password, profile, grading } = req.body;

      // Check duplicate
      const exists = await User.findOne({ email: email.toLowerCase() });
      if (exists) {
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists.',
        });
      }

      const user = await User.create({
        email,
        password,
        profile:  profile  || {},
        grading:  grading  || { rules: [] },
      });

      await sendTokens(user, 201, res);
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, password } = req.body;

      // Fetch with password (select:false by default)
      const user = await User.findOne({ email }).select('+password +refreshToken');
      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password.',
        });
      }

      await sendTokens(user, 200, res);
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
// Flutter calls this when the access token expires
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token required.' });
    }

    // Verify token validity
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token.' });
    }

    // Confirm token matches what's stored
    const user = await User.findById(decoded.id).select('+refreshToken');
    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token mismatch.' });
    }

    const newAccessToken  = generateAccessToken(user._id);
    const newRefreshToken = generateRefreshToken(user._id);
    user.refreshToken     = newRefreshToken;
    await user.save({ validateBeforeSave: false });

    res.json({
      success:      true,
      accessToken:  newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', protect, async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { refreshToken: null });
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
