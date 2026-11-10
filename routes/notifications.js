const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');
const FcmToken = require('../models/FcmToken');

// ── Save / update FCM token for logged-in user ───────────────────────────
// POST /notifications/token
// The class (school / faculty / department / level) comes from the user's
// profile on the server, so pushes always match what the server knows and
// stay correct after a level change or promotion. The values in the request
// are only used when the profile has none yet.
router.post('/token', auth, async (req, res, next) => {
  try {
    const { token, school, faculty, department, level } = req.body;
    if (!token) return res.status(400).json({ message: 'Token required' });

    const p = req.user.profile || {};

    // A phone belongs to whoever is signed in on it now. If this token was
    // saved for another account (a previous user of this phone), remove that
    // link so the previous user's pushes stop arriving here.
    await FcmToken.deleteMany({ token, user: { $ne: req.user._id } });

    await FcmToken.findOneAndUpdate(
      { user: req.user._id },
      {
        token,
        school: p.school || school || '',
        faculty: p.faculty || faculty || '',
        department: p.department || department || '',
        level: p.graduated ? '' : p.level || level || '',
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json({ message: 'Token saved' });
  } catch (err) {
    next(err);
  }
});


// PATCH /notifications/toggle
router.patch('/toggle', auth, async (req, res, next) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: '`enabled` must be a boolean' });
    }
    const doc = await FcmToken.findOneAndUpdate(
      { user: req.user._id },
      { enabled, updatedAt: new Date() },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'No FCM token found' });
    res.json({ message: `Notifications ${enabled ? 'enabled' : 'disabled'}`, enabled });
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
