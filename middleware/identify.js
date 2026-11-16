// middleware/identify.js
//
// Like `protect`, but also lets in a Gmail GUEST (someone with no SchoolLife
// account who signed in with Google). After it runs, exactly one of these is set:
//
//   req.user   a normal SchoolLife user (same as `protect`)
//   req.guest  { email, name } of a Gmail guest
//
// A guest token can never pass the normal `protect` middleware (it has no user
// id), so guests can only reach routes that use `identify`.

const jwt  = require('jsonwebtoken');
const User = require('../models/User');

const identify = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Sign in to continue.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    } catch (err) {
      const message = err.name === 'TokenExpiredError'
        ? 'Your session expired. Please sign in again.'
        : 'Invalid token. Please sign in again.';
      return res.status(401).json({ success: false, message });
    }

    // A Gmail guest
    if (decoded.type === 'guest' && decoded.email) {
      req.guest = {
        email: String(decoded.email).toLowerCase(),
        name: String(decoded.name || ''),
      };
      return next();
    }

    // A normal SchoolLife user
    const user = await User.findById(decoded.id).select('-password -refreshToken');
    if (!user) {
      return res.status(401).json({ success: false, message: 'User no longer exists.' });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('identify error:', err);
    res.status(500).json({ success: false, message: 'Server error during sign in.' });
  }
};

module.exports = identify;