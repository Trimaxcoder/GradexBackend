// utils/academicTerm.js
//
// Works out where a school is in its academic calendar *right now*.
// Nothing is stored or flipped by a cron job: the answer comes straight
// from the semester dates, so it can never get out of date.
//
//   status 'active'       a semester is running
//   status 'break'        between semesters, or the session has ended
//   status 'unconfigured' the super admin hasn't entered a calendar for this
//                         school yet. Gating is OFF, so nothing changes for
//                         schools you haven't set up.

const AcademicCalendar = require('../models/AcademicCalendar');

const CACHE_MS = 60 * 1000; // a calendar changes rarely; 1 minute is plenty
const cache = new Map(); // schoolKey -> { at, terms }

// Nigeria is UTC+1 all year.
const WAT = '+01:00';

/** "2025-10-06" -> Date at 00:00 (or 23:59:59.999) Nigerian time, or null. */
function parseDay(str, endOfDay = false) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
  const d = new Date(`${str}T${time}${WAT}`);
  return Number.isNaN(d.getTime()) ? null : d; // rejects things like 2025-02-30
}

/** "2025/2026" + 1 -> "2025/2026-1". Stamped on timetable entries in step 5. */
const termId = (session, number) => `${session}-${number}`;

async function loadTerms(school) {
  const key = AcademicCalendar.normalizeSchool(school);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.terms;

  const calendars = await AcademicCalendar.find({ schoolKey: key }).lean();

  const terms = [];
  for (const cal of calendars) {
    for (const s of cal.semesters) {
      terms.push({
        term: termId(cal.session, s.number),
        session: cal.session,
        semester: s.number,
        startDate: s.startDate,
        endDate: s.endDate,
      });
    }
  }
  terms.sort((a, b) => a.startDate - b.startDate);

  cache.set(key, { at: Date.now(), terms });
  return terms;
}

/** Call after the super admin changes a calendar so the change shows at once. */
function clearTermCache(school) {
  cache.delete(AcademicCalendar.normalizeSchool(school));
}

async function getTermState(school, now = new Date()) {
  const terms = await loadTerms(school);

  if (terms.length === 0) {
    return {
      status: 'unconfigured',
      current: null,
      upcoming: null,
      previous: null,
      targetTerm: null,
    };
  }

  const t = now.getTime();
  const current =
    terms.find((x) => x.startDate.getTime() <= t && t <= x.endDate.getTime()) ||
    null;
  const upcoming = terms.find((x) => x.startDate.getTime() > t) || null;
  const previous =
    [...terms].reverse().find((x) => x.endDate.getTime() < t) || null;

  return {
    status: current ? 'active' : 'break',
    current,
    upcoming,
    previous,
    // Where a course rep's new timetable entries belong: the running
    // semester, or the next one if they are setting up ahead of time.
    targetTerm: (current || upcoming)?.term || null,
  };
}

/** True when class updates and notifications should be going out. */
const isClassTimeActive = (state) =>
  state.status === 'active' || state.status === 'unconfigured';

/** Shape sent to the app. */
function describeTerm(state) {
  const fmt = (x) =>
    x
      ? {
          term: x.term,
          session: x.session,
          semester: x.semester,
          startDate: x.startDate,
          endDate: x.endDate,
        }
      : null;

  return {
    status: state.status,
    current: fmt(state.current),
    upcoming: fmt(state.upcoming),
    previous: fmt(state.previous),
    targetTerm: state.targetTerm || null,
  };
}

/** Every semester of a school, oldest first. */
const listTerms = (school) => loadTerms(school);

module.exports = {
  listTerms,
  parseDay,
  termId,
  getTermState,
  isClassTimeActive,
  describeTerm,
  clearTermCache,
};