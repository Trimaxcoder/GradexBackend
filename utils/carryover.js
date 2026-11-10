// utils/carryover.js
const Carryover = require('../models/Carryover');
const FcmToken = require('../models/FcmToken');
const { LectureEntry } = require('../models/Timetable');

/** "csc 201" / "CSC201" -> "CSC201" */
const courseKey = (code) => String(code ?? '').toUpperCase().replace(/\s+/g, '');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches "CSC201", "csc201", "CSC 201" ... on a timetable entry. */
function courseRegex(code) {
  const key = courseKey(code);
  return new RegExp(
    '^\\s*' + key.split('').map(escapeRe).join('\\s*') + '\\s*$',
    'i',
  );
}

/** "2025/2026-2" -> 2 (null for old, unstamped entries) */
function semesterOf(term) {
  const m = /-([12])$/.exec(String(term || ''));
  return m ? Number(m[1]) : null;
}

const enabledFlag = { $or: [{ enabled: true }, { enabled: { $exists: false } }] };

/** Phones of students carrying this entry's course (notifications on). */
async function carryoverTokens(entry) {
  const key = courseKey(entry.courseCode);
  if (!key) return [];

  const subs = await Carryover.find({
    school: entry.school,
    faculty: entry.faculty,
    department: entry.department,
    level: entry.level,
    courseKey: key,
  })
    .select('user')
    .lean();
  if (subs.length === 0) return [];

  const docs = await FcmToken.find({
    user: { $in: subs.map((s) => s.user) },
    ...enabledFlag,
  })
    .select('token')
    .lean();
  return [...new Set(docs.map((d) => d.token).filter(Boolean))];
}

/**
 * The student's carry-over classes for the semester that is running, shaped
 * like timetable entries (with carryover: true and the level they come from).
 */
async function carryoverEntriesFor(userId, state) {
  if (state.status === 'break') return [];

  const subs = await Carryover.find({ user: userId }).lean();
  if (subs.length === 0) return [];

  const q = {
    type: 'lecture',
    $or: subs.map((s) => ({
      school: s.school,
      faculty: s.faculty,
      department: s.department,
      level: s.level,
    })),
  };
  if (state.status === 'active') q.term = state.current.term;

  const rows = await LectureEntry.find(q).sort({ day: 1, startTime: 1 });
  const wanted = new Set(
    subs.map((s) => [s.school, s.faculty, s.department, s.level, s.courseKey].join('|')),
  );

  return rows
    .filter((e) =>
      wanted.has(
        [e.school, e.faculty, e.department, e.level, courseKey(e.courseCode)].join('|'),
      ),
    )
    .map((e) => ({
      ...(typeof e.toObject === 'function' ? e.toObject() : e),
      carryover: true,
      fromLevel: e.level,
    }));
}

module.exports = {
  courseKey,
  courseRegex,
  semesterOf,
  carryoverTokens,
  carryoverEntriesFor,
};
