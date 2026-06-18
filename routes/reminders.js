const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');
const ClassReminder = require('../models/ClassReminder');

// GET /api/reminders — get all reminder settings for the logged-in user
router.get('/', auth, async (req, res, next) => {
  try {
    const reminders = await ClassReminder.find({ user: req.user._id });
    res.json({ reminders });
  } catch (err) { next(err); }
});

// PUT /api/reminders/:lectureId — set/update reminder for a specific lecture
router.put('/:lectureId', auth, async (req, res, next) => {
  try {
    const { enabled, minutesBefore } = req.body;

    const reminder = await ClassReminder.findOneAndUpdate(
      { user: req.user._id, lecture: req.params.lectureId },
      {
        enabled: enabled ?? false,
        minutesBefore: minutesBefore ?? 10,
      },
      { upsert: true, new: true }
    );

    res.json({ reminder });
  } catch (err) { next(err); }
});

module.exports = router;