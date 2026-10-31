// utils/timetableTerm.js
//
// The rules that connect timetable entries to semesters and to a course
// rep's class. Used by the timetable routes and the morning digest.

const { LectureEntry } = require('../models/Timetable');
const FcmToken = require('../models/FcmToken');
const { getTermState } = require('./academicTerm');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Entries created before terms existed have '' or no `term` field at all.
const unstamped = { $or: [{ term: '' }, { term: { $exists: false } }] };

/**
 * Gives old, unstamped entries of a school to the semester they most likely
 * belong to: the running one, else the one that just ended, else the next.
 * Does nothing for schools without a calendar. Safe to call repeatedly.
 */
async function adoptLegacyEntries(school) {
  if (!school) return;
  const state = await getTermState(school);
  if (state.status === 'unconfigured') return;

  const term = (state.current || state.previous || state.upcoming)?.term;
  if (!term) return;

  await LectureEntry.updateMany(
    { school, ...unstamped },
    { $set: { term } },
    { timestamps: false },
  );
}

/** Does this entry belong to the rep's verified class? (Lenient on spelling.) */
function entryInScope(entry, scope) {
  return (
    norm(entry.school) === norm(scope.school) &&
    norm(entry.faculty) === norm(scope.faculty) &&
    norm(entry.department) === norm(scope.department) &&
    norm(entry.level) === norm(scope.level)
  );
}

/**
 * Which semester should a rep's NEW entry go into?
 * The running semester, or the next one when they are setting up ahead of time.
 */
function termForNewEntry(state) {
  if (state.status === 'unconfigured') return { ok: true, term: '' };
  if (!state.targetTerm) {
    return {
      ok: false,
      message:
        'Waiting for the new session calendar. The super admin needs to add it before you can set up the timetable.',
    };
  }
  return { ok: true, term: state.targetTerm };
}

/** Class updates and pushes only go out for a semester that is running. */
function canNotify(entryTerm, state) {
  if (state.status === 'unconfigured') return true;
  return state.status === 'active' && entryTerm === state.current.term;
}

/** Entries of a finished semester are read-only. */
function isEditable(entry, state) {
  if (state.status === 'unconfigured') return true;
  return !!state.targetTerm && entry.term === state.targetTerm;
}

/** Everyone in a class who has notifications on (missing flag counts as on). */
async function classTokens({ school, faculty, department, level }) {
  const docs = await FcmToken.find({
    school,
    faculty,
    department,
    level,
    $or: [{ enabled: true }, { enabled: { $exists: false } }],
  }).select('token');
  return [...new Set(docs.map((d) => d.token).filter(Boolean))];
}

module.exports = {
  adoptLegacyEntries,
  entryInScope,
  termForNewEntry,
  canNotify,
  isEditable,
  classTokens,
};