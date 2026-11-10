// routes/carryover.js
//
// A student can carry over courses from LOWER levels of their OWN department
// (school, faculty and department come from their profile). They keep their
// own level and get that course's classes, alerts and exam notices.

const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const { protect: auth } = require('../middleware/auth');
const Carryover = require('../models/Carryover');
const { LectureEntry } = require('../models/Timetable');
const { getTermState, describeTerm } = require('../utils/academicTerm');
const { adoptLegacyEntries } = require('../utils/timetableTerm');
const { levelNum } = require('../utils/repRequest');
const { courseKey, courseRegex, semesterOf } = require('../utils/carryover');

const MAX_CARRYOVERS = 20;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: 'Not found' });
  }
  next();
});

/** The student's own class, from their profile (or null if incomplete). */
function myClass(user) {
  const p = user.profile || {};
  const mine = levelNum(p.level);
  if (!p.school || !p.faculty || !p.department || mine === null) return null;
  return {
    school: p.school,
    faculty: p.faculty,
    department: p.department,
    level: p.level,
    levelNum: mine,
  };
}

const NO_CLASS = {
  message:
    'Complete your profile (school, faculty, department and a level from 100 to 700) first.',
};

const bySlotOrder = (a, b) =>
  DAYS.indexOf(a.day) - DAYS.indexOf(b.day) ||
  String(a.startTime).localeCompare(String(b.startTime));

const slotOf = (e) => ({
  day: e.day,
  startTime: e.startTime,
  endTime: e.endTime,
  venue: e.venue || '',
});

// ── GET /api/carryover/levels ────────────────────────────────────────────────
// Lower levels of the student's department that have a timetable.
router.get('/levels', auth, async (req, res, next) => {
  try {
    const c = myClass(req.user);
    if (!c) return res.status(400).json(NO_CLASS);

    const all = await LectureEntry.distinct('level', {
      type: 'lecture',
      school: c.school,
      faculty: c.faculty,
      department: c.department,
    });
    const levels = all
      .filter((l) => {
        const n = levelNum(l);
        return n !== null && n < c.levelNum;
      })
      .sort((a, b) => levelNum(a) - levelNum(b));

    res.json({ levels, currentLevel: c.level });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/carryover/courses?level=200 ─────────────────────────────────────
// Every course known for that lower level, which semester it runs in, when it
// meets this semester, and whether the student already carries it.
router.get('/courses', auth, async (req, res, next) => {
  try {
    const c = myClass(req.user);
    if (!c) return res.status(400).json(NO_CLASS);

    const level = String(req.query.level || '').trim();
    const n = levelNum(level);
    if (n === null || n >= c.levelNum) {
      return res.status(400).json({ message: 'Choose a level below yours.' });
    }

    await adoptLegacyEntries(c.school);
    const state = await getTermState(c.school);
    const currentTerm = state.status === 'active' ? state.current.term : null;

    const entries = await LectureEntry.find({
      type: 'lecture',
      school: c.school,
      faculty: c.faculty,
      department: c.department,
      level,
    })
      .select('courseCode courseTitle term day startTime endTime venue')
      .lean();

    const mine = await Carryover.find({
      user: req.user._id,
      school: c.school,
      faculty: c.faculty,
      department: c.department,
      level,
    }).lean();
    const mineByKey = new Map(mine.map((m) => [m.courseKey, m]));

    const groups = new Map();
    for (const e of entries) {
      const key = courseKey(e.courseCode);
      if (!key) continue;
      const g = groups.get(key) || {
        courseCode: e.courseCode,
        courseTitle: '',
        semesters: new Set(),
        slots: [],
      };
      if (e.courseTitle) g.courseTitle = e.courseTitle;
      const sem = semesterOf(e.term);
      if (sem) g.semesters.add(sem);
      const meetsNow = currentTerm
        ? e.term === currentTerm
        : state.status === 'unconfigured';
      if (meetsNow) g.slots.push(slotOf(e));
      groups.set(key, g);
    }

    const courses = [...groups.entries()]
      .map(([key, g]) => {
        const sub = mineByKey.get(key);
        return {
          courseCode: g.courseCode,
          courseTitle: g.courseTitle,
          semesters: [...g.semesters].sort(),
          activeNow: g.slots.length > 0,
          slots: g.slots.sort(bySlotOrder),
          added: !!sub,
          subscriptionId: sub ? String(sub._id) : null,
        };
      })
      .sort((a, b) => a.courseCode.localeCompare(b.courseCode));

    res.json({ level, term: describeTerm(state), courses });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/carryover ───────────────────────────────────────────────────────
// The student's carry-over courses, with this semester's schedule for each.
router.get('/', auth, async (req, res, next) => {
  try {
    const subs = await Carryover.find({ user: req.user._id })
      .sort({ level: 1, courseKey: 1 })
      .lean();

    // Where is each class in its calendar? (one lookup per school)
    const stateBySchool = new Map();
    for (const s of subs) {
      if (!stateBySchool.has(s.school)) {
        await adoptLegacyEntries(s.school);
        stateBySchool.set(s.school, await getTermState(s.school));
      }
    }

    let entries = [];
    if (subs.length > 0) {
      const seen = new Set();
      const classes = [];
      for (const s of subs) {
        const k = [s.school, s.faculty, s.department, s.level].join('|');
        if (!seen.has(k)) {
          seen.add(k);
          classes.push({
            school: s.school,
            faculty: s.faculty,
            department: s.department,
            level: s.level,
          });
        }
      }
      entries = await LectureEntry.find({ type: 'lecture', $or: classes })
        .select('school faculty department level courseCode courseTitle term day startTime endTime venue')
        .lean();
    }

    const carryovers = subs.map((s) => {
      const state = stateBySchool.get(s.school);
      const currentTerm = state && state.status === 'active' ? state.current.term : null;
      const slots = entries
        .filter(
          (e) =>
            e.school === s.school &&
            e.faculty === s.faculty &&
            e.department === s.department &&
            e.level === s.level &&
            courseKey(e.courseCode) === s.courseKey &&
            (currentTerm
              ? e.term === currentTerm
              : state && state.status === 'unconfigured'),
        )
        .map(slotOf)
        .sort(bySlotOrder);

      return {
        id: String(s._id),
        level: s.level,
        courseCode: s.courseCode,
        courseTitle: s.courseTitle || '',
        activeNow: slots.length > 0,
        slots,
      };
    });

    res.json({ carryovers });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/carryover  { level, courseCode } ───────────────────────────────
router.post('/', auth, async (req, res, next) => {
  try {
    const c = myClass(req.user);
    if (!c) return res.status(400).json(NO_CLASS);

    const level = String(req.body.level || '').trim();
    const n = levelNum(level);
    if (n === null || n >= c.levelNum) {
      return res
        .status(400)
        .json({ message: 'Carry-over courses must be from a level below yours.' });
    }

    const key = courseKey(req.body.courseCode);
    if (!key) return res.status(400).json({ message: 'Choose a course.' });

    const count = await Carryover.countDocuments({ user: req.user._id });
    if (count >= MAX_CARRYOVERS) {
      return res.status(400).json({
        message: `You can carry over up to ${MAX_CARRYOVERS} courses. Remove one first.`,
      });
    }

    // The course must really be on that level's timetable (your department only)
    const entry = await LectureEntry.findOne({
      type: 'lecture',
      school: c.school,
      faculty: c.faculty,
      department: c.department,
      level,
      courseCode: courseRegex(key),
    });
    if (!entry) {
      return res.status(404).json({
        message: `That course is not on the ${level} level timetable of your department.`,
      });
    }

    const existing = await Carryover.findOne({
      user: req.user._id,
      school: c.school,
      faculty: c.faculty,
      department: c.department,
      level,
      courseKey: key,
    });
    if (existing) {
      return res.status(409).json({ message: 'You already carry this course.' });
    }

    try {
      const sub = await Carryover.create({
        user: req.user._id,
        school: c.school,
        faculty: c.faculty,
        department: c.department,
        level,
        courseKey: key,
        courseCode: entry.courseCode,
        courseTitle: entry.courseTitle || '',
      });
      res.status(201).json({
        message: 'Added',
        carryover: { id: String(sub._id), level, courseCode: sub.courseCode },
      });
    } catch (err) {
      // Added twice at the same moment
      if (err && err.code === 11000) {
        return res.status(409).json({ message: 'You already carry this course.' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/carryover/:id ────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const gone = await Carryover.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!gone) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
