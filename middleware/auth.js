const jwt  = require('jsonwebtoken');
const User = require('../models/User');

// ── Verify Access Token ───────────────────────────────────────────────────────
const protect = async (req, res, next) => {
  try {
    // 1. Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Access denied.',
      });
    }

    const token = authHeader.split(' ')[1];

    // 2. Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      const msg =
        err.name === 'TokenExpiredError'
          ? 'Token expired. Please log in again.'
          : 'Invalid token. Access denied.';
      return res.status(401).json({ success: false, message: msg });
    }

    // 3. Confirm user still exists (handles deleted-account edge case)
    const user = await User.findById(decoded.id).select('-password -refreshToken');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User no longer exists.',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ success: false, message: 'Server error during authentication.' });
  }
};

// ── Generate Access Token (short-lived) ──────────────────────────────────────
const generateAccessToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

// ── Generate Refresh Token (long-lived) ──────────────────────────────────────
const generateRefreshToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });

module.exports = { protect, generateAccessToken, generateRefreshToken };
