const express    = require('express');
const router     = express.Router();
const  { protect: auth }      = require('../middleware/auth');
const { LectureEntry, PersonalEntry } = require('../models/Timetable');
const FcmToken   = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

// ════════════════════════════════════════════════════════════
//  LECTURE TIMETABLE (admin only for write)
// ════════════════════════════════════════════════════════════

// GET /timetable/lecture — fetch timetable for user's dept/level
router.get('/lecture', auth, async (req, res, next) => {
  try {
    const { school, faculty, department, level } = req.user.profile || {};
    const entries = await LectureEntry.find({
      type: 'lecture',
      school, faculty, department, level,
    }).sort({ day: 1, startTime: 1 });
    res.json({ entries });
  } catch (err) { next(err); }
});

// POST /timetable/lecture — admin adds lecture entry
router.post('/lecture', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admins only' });
    }
    const {
      courseCode, courseTitle, day, startTime, endTime,
      venue, classType, note, isImportant,
      school, faculty, department, level,
    } = req.body;

    const entry = await LectureEntry.create({
      type: 'lecture',
      courseCode, courseTitle, day, startTime, endTime,
      venue, classType: classType || 'normal',
      note, isImportant: isImportant || false,
      school, faculty, department, level,
      createdBy: req.user._id,
    });

    // Send push notification for important classes
    if (isImportant) {
      const tokens = await FcmToken.find({ school, faculty, department, level });
      const tokenList = tokens.map(t => t.token).filter(Boolean);
      if (tokenList.length > 0) {
        const typeLabel = classType === 'test' ? '📝 Test Alert'
          : classType === 'impromptu' ? '⚡ Impromptu Class'
          : classType === 'meeting'   ? '📢 Meeting'
          : '📌 Important Class';
        await sendToTokens(
          tokenList,
          typeLabel,
          `${courseCode}: ${day} ${startTime}–${endTime}${venue ? ' @ ' + venue : ''}`,
          { type: 'important_class', entryId: String(entry._id) }
        );
      }
    }

    res.status(201).json({ message: 'Entry added', entry });
  } catch (err) { next(err); }
});

// PUT /timetable/lecture/:id — admin edits
router.put('/lecture/:id', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admins only' });
    }
    const entry = await LectureEntry.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );
    if (!entry) return res.status(404).json({ message: 'Not found' });
    res.json({ entry });
  } catch (err) { next(err); }
});

// PUT /timetable/lecture/:id/emergency — admin toggles emergency status, notifies all students
router.put('/lecture/:id/emergency', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admins only' });
    }
    const entry = await LectureEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Not found' });

    entry.isEmergency = !entry.isEmergency;
    entry.updatedAt = new Date();
    await entry.save();

    // Notify all students in this dept/level
    const { school, faculty, department, level } = entry;
    const tokens = await FcmToken.find({ school, faculty, department, level });
    const tokenList = tokens.map(t => t.token).filter(Boolean);
    if (tokenList.length > 0) {
      await sendToTokens(
        tokenList,
        entry.isEmergency ? '🚨 Emergency Class Alert' : 'Emergency Status Removed',
        entry.isEmergency
          ? `${entry.courseCode}: ${entry.day} ${entry.startTime}–${entry.endTime}${entry.venue ? ' @ ' + entry.venue : ''} is now marked as an emergency class!`
          : `${entry.courseCode} is no longer marked as emergency.`,
        { type: 'emergency_toggle', entryId: String(entry._id) }
      );
    }

    res.json({ entry });
  } catch (err) { next(err); }
});


// Generic toggle handler for alert flags
const ALERT_CONFIG = {
  test: {
    field: 'isTest',
    onTitle: '📝 Test Alert',
    onBody: (e) => `${e.courseCode}: A test has been scheduled for ${e.day} ${e.startTime}–${e.endTime}${e.venue ? ' @ ' + e.venue : ''}`,
    offTitle: 'Test Alert Removed',
    offBody: (e) => `${e.courseCode} test alert has been removed.`,
  },
  attendance: {
    field: 'isAttendance',
    onTitle: '✅ Compulsory Attendance',
    onBody: (e) => `${e.courseCode}: Attendance is now compulsory for ${e.day} ${e.startTime}–${e.endTime}${e.venue ? ' @ ' + e.venue : ''}`,
    offTitle: 'Attendance Alert Removed',
    offBody: (e) => `${e.courseCode} is no longer marked as compulsory attendance.`,
  },
  cancelled: {
    field: 'isCancelled',
    onTitle: '🚫 Class Cancelled',
    onBody: (e) => `${e.courseCode}: Class on ${e.day} ${e.startTime}–${e.endTime} has been cancelled.`,
    offTitle: 'Class Reinstated',
    offBody: (e) => `${e.courseCode} class on ${e.day} has been reinstated.`,
  },
};

// PUT /timetable/lecture/:id/alert/:type — toggle test/attendance/cancelled, notify students
router.put('/lecture/:id/alert/:type', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admins only' });
    }

    const config = ALERT_CONFIG[req.params.type];
    if (!config) {
      return res.status(400).json({ message: 'Invalid alert type' });
    }

    const entry = await LectureEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Not found' });

    entry[config.field] = !entry[config.field];
    entry.updatedAt = new Date();
    await entry.save();

    const { school, faculty, department, level } = entry;
    const tokens = await FcmToken.find({ school, faculty, department, level });
    const tokenList = tokens.map(t => t.token).filter(Boolean);
    if (tokenList.length > 0) {
      await sendToTokens(
        tokenList,
        entry[config.field] ? config.onTitle : config.offTitle,
        entry[config.field] ? config.onBody(entry) : config.offBody(entry),
        { type: `${req.params.type}_toggle`, entryId: String(entry._id) }
      );
    }

    res.json({ entry });
  } catch (err) { next(err); }
});

// DELETE /timetable/lecture/:id — admin deletes
router.delete('/lecture/:id', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admins only' });
    }
    await LectureEntry.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
//  EXAM TIMETABLE (admin only for write)
// ════════════════════════════════════════════════════════════

// GET /timetable/exam
router.get('/exam', auth, async (req, res, next) => {
  try {
    const { school, faculty, department, level } = req.user.profile || {};
    const entries = await LectureEntry.find({
      type: 'exam',
      school, faculty, department, level,
    }).sort({ date: 1, startTime: 1 });
    res.json({ entries });
  } catch (err) { next(err); }
});

// POST /timetable/exam — admin adds exam
router.post('/exam', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admins only' });
    }
    const {
      courseCode, courseTitle, date, startTime, endTime,
      venue, note, school, faculty, department, level,
    } = req.body;

    const entry = await LectureEntry.create({
      type: 'exam',
      courseCode, courseTitle,
      day: new Date(date).toLocaleDateString('en-US', { weekday: 'long' }),
      date, startTime, endTime,
      venue, note, isImportant: true,
      school, faculty, department, level,
      createdBy: req.user._id,
    });

    // Always notify for exams
    const tokens = await FcmToken.find({ school, faculty, department, level });
    const tokenList = tokens.map(t => t.token).filter(Boolean);
    if (tokenList.length > 0) {
      await sendToTokens(
        tokenList,
        '📅 Exam Scheduled',
        `${courseCode} exam on ${new Date(date).toDateString()} at ${startTime}${venue ? ' @ ' + venue : ''}`,
        { type: 'exam_added', entryId: String(entry._id) }
      );
    }

    res.status(201).json({ message: 'Exam added', entry });
  } catch (err) { next(err); }
});

// PUT /timetable/exam/:id
router.put('/exam/:id', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admins only' });
    }
    const entry = await LectureEntry.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );
    if (!entry) return res.status(404).json({ message: 'Not found' });
    res.json({ entry });
  } catch (err) { next(err); }
});

// DELETE /timetable/exam/:id
router.delete('/exam/:id', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admins only' });
    }
    await LectureEntry.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
//  PERSONAL TIMETABLE (user managed)
// ════════════════════════════════════════════════════════════

// GET /timetable/personal
router.get('/personal', auth, async (req, res, next) => {
  try {
    const entries = await PersonalEntry.find({ user: req.user._id })
      .sort({ day: 1, startTime: 1 });
    res.json({ entries });
  } catch (err) { next(err); }
});

// POST /timetable/personal
router.post('/personal', auth, async (req, res, next) => {
  try {
    const { title, day, startTime, endTime, color, note, reminderMinutes } = req.body;
    const entry = await PersonalEntry.create({
      user: req.user._id,
      title, day, startTime, endTime,
      color: color || '#4F46E5',
      note, reminderMinutes: reminderMinutes || 0,
    });
    res.status(201).json({ entry });
  } catch (err) { next(err); }
});

// PUT /timetable/personal/:id
router.put('/personal/:id', auth, async (req, res, next) => {
  try {
    const entry = await PersonalEntry.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );
    if (!entry) return res.status(404).json({ message: 'Not found' });
    res.json({ entry });
  } catch (err) { next(err); }
});

// DELETE /timetable/personal/:id
router.delete('/personal/:id', auth, async (req, res, next) => {
  try {
    await PersonalEntry.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

// PUT /timetable/personal/:id/bookmark — toggle bookmark
router.put('/personal/:id/bookmark', auth, async (req, res, next) => {
  try {
    const entry = await PersonalEntry.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!entry) return res.status(404).json({ message: 'Not found' });
    entry.isBookmarked = !entry.isBookmarked;
    await entry.save();
    res.json({ entry });
  } catch (err) { next(err); }
});

module.exports = router;