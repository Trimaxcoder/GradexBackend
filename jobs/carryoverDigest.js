// jobs/carryoverDigest.js
//
// Each morning, tells students about today's classes for the courses they
// carry over from lower levels. (Their own level's classes are in the normal
// morning digest.) Quiet during a semester break, like everything else.

const Carryover = require('../models/Carryover');
const FcmToken = require('../models/FcmToken');
const { LectureEntry } = require('../models/Timetable');
const { sendToTokens } = require('../config/firebase');
const { getTermState, isClassTimeActive } = require('../utils/academicTerm');
const { adoptLegacyEntries } = require('../utils/timetableTerm');
const { courseKey } = require('../utils/carryover');

async function sendCarryoverDigests(today) {
  const subs = await Carryover.find({}).lean();
  if (subs.length === 0) return;

  const classKey = (s) => [s.school, s.faculty, s.department, s.level].join('|');

  // Today's classes for each class that has carry-over students
  const classes = new Map();
  for (const s of subs) if (!classes.has(classKey(s))) classes.set(classKey(s), s);

  const adopted = new Set();
  const todayByClass = new Map(); // class -> Map(courseKey -> entries)
  for (const [k, c] of classes) {
    if (!adopted.has(c.school)) {
      await adoptLegacyEntries(c.school);
      adopted.add(c.school);
    }
    const state = await getTermState(c.school);
    if (!isClassTimeActive(state)) continue;

    const q = {
      type: 'lecture',
      day: today,
      school: c.school,
      faculty: c.faculty,
      department: c.department,
      level: c.level,
      isCancelled: { $ne: true },
    };
    if (state.status === 'active') q.term = state.current.term;

    const entries = await LectureEntry.find(q).sort({ startTime: 1 }).lean();
    const byCourse = new Map();
    for (const e of entries) {
      const key = courseKey(e.courseCode);
      byCourse.set(key, [...(byCourse.get(key) || []), e]);
    }
    todayByClass.set(k, byCourse);
  }

  // What each student has today
  const byUser = new Map();
  for (const s of subs) {
    const list = todayByClass.get(classKey(s))?.get(s.courseKey);
    if (!list) continue;
    const items = byUser.get(String(s.user)) || [];
    for (const e of list) items.push({ code: e.courseCode, start: e.startTime });
    byUser.set(String(s.user), items);
  }
  if (byUser.size === 0) return;

  const tokenDocs = await FcmToken.find({
    user: { $in: [...byUser.keys()] },
    $or: [{ enabled: true }, { enabled: { $exists: false } }],
  })
    .select('user token')
    .lean();

  let sent = 0;
  for (const t of tokenDocs) {
    const items = byUser.get(String(t.user));
    if (!items || !t.token) continue;
    items.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    try {
      await sendToTokens(
        [t.token],
        '📚 Carry-over classes today',
        items.map((i) => `${i.code} (${i.start})`).join(', '),
        { type: 'morning_digest' },
      );
      sent++;
    } catch (err) {
      console.error('Carry-over digest failed for one student:', err);
    }
  }
  console.log(`Carry-over digest: ${sent} students told`);
}

module.exports = { sendCarryoverDigests };
