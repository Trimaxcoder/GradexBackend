const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const FcmToken = require('../models/FcmToken');

// ── Save / update FCM token for logged-in user ───────────────────────────
// POST /notifications/token
router.post('/token', auth, async (req, res, next) => {
  try {
    const { token, school, faculty, department, level } = req.body;
    if (!token) return res.status(400).json({ message: 'Token required' });

    await FcmToken.findOneAndUpdate(
      { user: req.user._id },
      { token, school, faculty, department, level, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ message: 'Token saved' });
  } catch (err) {
    next(err);
  }
});

// ── Delete token on logout ───────────────────────────────────────────────
// DELETE /notifications/token
router.delete('/token', auth, async (req, res, next) => {
  try {
    await FcmToken.findOneAndDelete({ user: req.user._id });
    res.json({ message: 'Token removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;