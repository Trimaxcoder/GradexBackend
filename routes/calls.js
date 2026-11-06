// routes/calls.js
//
//   GET /api/calls/usage  → how many call minutes I have left today
//   GET /api/calls/:id    → what is going on with one call (used when I tap a
//                           "incoming call" push and the app has just opened)

const express  = require('express');
const mongoose = require('mongoose');

const { protect }     = require('../middleware/auth');
const User            = require('../models/User');
const Call            = require('../models/Call');
const { displayName } = require('../utils/displayName');
const { usedToday, DAILY_LIMIT_SEC } = require('../socket/calls');

const router = express.Router();
router.use(protect);

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

router.get('/usage', wrap(async (req, res) => {
  const used = await usedToday(req.user._id);
  res.json({
    success: true,
    usedMinutes:  Math.ceil(used / 60),
    limitMinutes: Math.floor(DAILY_LIMIT_SEC / 60),
  });
}));

router.get('/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid call id.' });
  }

  const call = await Call.findById(req.params.id);
  const me   = String(req.user._id);
  if (!call || (String(call.caller) !== me && String(call.callee) !== me)) {
    return res.status(404).json({ success: false, message: 'Call not found.' });
  }

  const otherId = String(call.caller) === me ? call.callee : call.caller;
  const other   = await User.findById(otherId).select('profile.name username');

  res.json({
    success: true,
    call: {
      id:       String(call._id),
      classId:  String(call.class),
      kind:     call.kind,
      status:   call.status,
      isCallee: String(call.callee) === me,
      peer:     { id: String(otherId), name: displayName(other, 'Someone') },
    },
  });
}));

module.exports = router;