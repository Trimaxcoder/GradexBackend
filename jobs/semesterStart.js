// jobs/semesterStart.js
//
// On the start day of a semester (a date the super admin entered), tells the
// class reps of that school to update their class timetable. Only reps whose
// class has no timetable for the new semester yet are told.
//
// Safe to run every day: each semester's notice goes out at most once, and
// only within a week of its start day.

const AcademicCalendar = require('../models/AcademicCalendar');
const User = require('../models/User');
const FcmToken = require('../models/FcmToken');
const { LectureEntry } = require('../models/Timetable');
const { sendToTokens } = require('../config/firebase');
const { termId } = require('../utils/academicTerm');
const { adoptLegacyEntries } = require('../utils/timetableTerm');

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const classKey = (school, faculty, department, level) =>
  [school, faculty, department, level].map(norm).join('|');

async function runSemesterStartNotices(now = new Date()) {
  const t = now.getTime();
  const since = new Date(t - WINDOW_DAYS * DAY);

  const calendars = await AcademicCalendar.find({
    semesters: { $elemMatch: { startDate: { $lte: now, $gte: since } } },
  });

  for (const cal of calendars) {
    for (const s of cal.semesters) {
      const start = s.startDate.getTime();
      if (start > t || start < t - WINDOW_DAYS * DAY) continue;
      if ((cal.startNotified || []).includes(s.number)) continue;

      // Claim this semester's notice first, so it can never go out twice.
      const claim = await AcademicCalendar.updateOne(
        { _id: cal._id, startNotified: { $ne: s.number } },
        { $addToSet: { startNotified: s.number } },
      );
      if (!claim || claim.modifiedCount === 0) continue;

      try {
        await notifyReps(cal, s);
      } catch (err) {
        console.error(
          `Semester start notice failed for ${cal.school} ${cal.session}-${s.number}:`,
          err,
        );
      }
    }
  }
}

async function notifyReps(cal, s) {
  const term = termId(cal.session, s.number);

  const allSchools = await User.distinct('adminScope.school');
  const schools = allSchools.filter(
    (x) => x && AcademicCalendar.normalizeSchool(x) === cal.schoolKey,
  );
  if (schools.length === 0) return;

  for (const school of schools) await adoptLegacyEntries(school);

  const reps = await User.find({
    isAdmin: true,
    'adminScope.school': { $in: schools },
  })
    .select('adminScope')
    .lean();
  if (reps.length === 0) return;

  // Classes that already have a timetable for this semester
  const done = await LectureEntry.aggregate([
    { $match: { type: 'lecture', term, school: { $in: schools } } },
    {
      $group: {
        _id: { s: '$school', f: '$faculty', d: '$department', l: '$level' },
      },
    },
  ]);
  const hasTimetable = new Set(
    done.map((r) => classKey(r._id.s, r._id.f, r._id.d, r._id.l)),
  );

  const needing = reps.filter((r) => {
    const sc = r.adminScope || {};
    return !hasTimetable.has(classKey(sc.school, sc.faculty, sc.department, sc.level));
  });
  if (needing.length === 0) return;

  const docs = await FcmToken.find({
    user: { $in: needing.map((r) => r._id) },
    $or: [{ enabled: true }, { enabled: { $exists: false } }],
  })
    .select('token')
    .lean();
  const tokens = [...new Set(docs.map((d) => d.token).filter(Boolean))];
  if (tokens.length === 0) return;

  const body =
    s.number === 1
      ? `A new session (${cal.session}) has started. Set up your class timetable for Semester 1.`
      : `Semester ${s.number} has started. Update your class timetable.`;

  await sendToTokens(tokens, '📅 Update your classes', body, {
    type: 'semester_start',
    term,
  });
  console.log(
    `Semester start notice: ${tokens.length} reps told for ${cal.school} ${term}`,
  );
}

module.exports = { runSemesterStartNotices };
