// routes/academic.js
const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const { protect: auth } = require('../middleware/auth');
const AcademicCalendar = require('../models/AcademicCalendar');
const User = require('../models/User');
const {
  parseDay,
  getTermState,
  describeTerm,
  clearTermCache,
} = require('../utils/academicTerm');

const requireSuperAdmin = (req, res, next) => {
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

function validationMessage(err) {
  const nested = err.errors && Object.values(err.errors)[0];
  return (nested && nested.message) || err.message;
}

// ── GET /api/academic/term  (any logged-in user) ─────────────────────────────
// Where the user's school is in its calendar right now.
router.get('/term', auth, async (req, res, next) => {
  try {
    const school = req.user.profile?.school;
    if (!school) {
      return res.json({ term: describeTerm({ status: 'unconfigured' }) });
    }
    res.json({ term: describeTerm(await getTermState(school)) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/academic/schools  (super admin) ─────────────────────────────────
// Every school students have signed up with, so you can set up its calendar.
router.get('/schools', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rows = await User.aggregate([
      { $match: { 'profile.school': { $type: 'string', $ne: '' } } },
      { $group: { _id: '$profile.school', students: { $sum: 1 } } },
    ]);

    // Merge spelling variants ("UNILAG" vs "unilag ") into one entry.
    const bySchool = new Map();
    for (const r of rows) {
      const key = AcademicCalendar.normalizeSchool(r._id);
      const entry = bySchool.get(key) || {
        school: r._id,
        students: 0,
        top: 0,
      };
      entry.students += r.students;
      if (r.students > entry.top) {
        entry.top = r.students;
        entry.school = r._id; // display the most common spelling
      }
      bySchool.set(key, entry);
    }

    const keys = [...bySchool.keys()];
    const calendars = await AcademicCalendar.find({
      schoolKey: { $in: keys },
    }).select('schoolKey session');

    const schools = await Promise.all(
      [...bySchool.entries()].map(async ([key, e]) => ({
        school: e.school,
        students: e.students,
        sessions: calendars
          .filter((c) => c.schoolKey === key)
          .map((c) => c.session)
          .sort()
          .reverse(),
        status: (await getTermState(e.school)).status,
      })),
    );

    schools.sort((a, b) => b.students - a.students);
    res.json({ schools });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/academic/calendars?school=...  (super admin) ────────────────────
router.get('/calendars', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const filter = {};
    if (typeof req.query.school === 'string' && req.query.school.trim()) {
      filter.schoolKey = AcademicCalendar.normalizeSchool(req.query.school);
    }
    const calendars = await AcademicCalendar.find(filter).sort({
      schoolKey: 1,
      session: -1,
    });
    res.json({ calendars: calendars.map((c) => c.toClient()) });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/academic/calendars  (super admin) ───────────────────────────────
// Create or update one session for one school.
// body: { school, session: "2025/2026",
//         semesters: [{ number: 1, startDay: "2025-10-06", endDay: "2026-02-20" }, ...] }
router.put('/calendars', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { school, session, semesters } = req.body;

    if (typeof school !== 'string' || !school.trim()) {
      return res.status(400).json({ message: 'School is required' });
    }
    if (typeof session !== 'string' || !session.trim()) {
      return res.status(400).json({ message: 'Session is required' });
    }
    if (!Array.isArray(semesters) || semesters.length === 0) {
      return res.status(400).json({ message: 'Add at least one semester' });
    }

    const parsed = [];
    for (const s of semesters) {
      const number = Number(s?.number);
      const startDate = parseDay(s?.startDay, false);
      const endDate = parseDay(s?.endDay, true);
      if (![1, 2].includes(number) || !startDate || !endDate) {
        return res.status(400).json({
          message:
            'Each semester needs a number (1 or 2) and real startDay / endDay dates (YYYY-MM-DD)',
        });
      }
      parsed.push({ number, startDate, endDate });
    }

    const key = AcademicCalendar.normalizeSchool(school);
    const sessionName = session.trim();

    let calendar = await AcademicCalendar.findOne({
      schoolKey: key,
      session: sessionName,
    });

    if (calendar?.promotedAt) {
      return res.status(409).json({
        message:
          'This session has ended and students were already promoted. It can no longer be edited.',
      });
    }

    // Semesters of different sessions must never overlap.
    const others = await AcademicCalendar.find({
      schoolKey: key,
      session: { $ne: sessionName },
    }).lean();
    for (const o of others) {
      for (const os of o.semesters) {
        for (const ns of parsed) {
          if (ns.startDate <= os.endDate && ns.endDate >= os.startDate) {
            return res.status(409).json({
              message: `Semester ${ns.number} overlaps semester ${os.number} of ${o.session}`,
            });
          }
        }
      }
    }

    if (!calendar) {
      calendar = new AcademicCalendar({ school: school.trim(), session: sessionName });
    }
    calendar.semesters = parsed;
    calendar.updatedBy = req.user._id;
    await calendar.save();

    clearTermCache(school);
    res.json({ message: 'Calendar saved', calendar: calendar.toClient() });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: validationMessage(err) });
    }
    next(err);
  }
});

// ── DELETE /api/academic/calendars/:id  (super admin) ────────────────────────
router.delete(
  '/calendars/:id',
  auth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).json({ message: 'Calendar not found' });
      }
      const calendar = await AcademicCalendar.findById(req.params.id);
      if (!calendar) {
        return res.status(404).json({ message: 'Calendar not found' });
      }
      if (calendar.promotedAt) {
        return res.status(409).json({
          message: 'This session has ended and students were already promoted.',
        });
      }
      await calendar.deleteOne();
      clearTermCache(calendar.school);
      res.json({ message: 'Calendar deleted' });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;