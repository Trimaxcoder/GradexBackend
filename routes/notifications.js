const express = require('express');
const router  = express.Router();
const  { protect: auth }    = require('../middleware/auth');
const FcmToken = require('../models/FcmToken');
// const { sendMorningDigests } = require('../jobs/morningDigest');

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

// ── Temporary: manually trigger morning digest ───────────────────────────
// GET /notifications/test-digest
// router.get('/test-digest', async (req, res, next) => {
//   try {
//     await sendMorningDigests();
//     res.json({ message: 'Morning digest triggered' });
//   } catch (err) {
//     next(err);
//   }
// });

module.exports = router;