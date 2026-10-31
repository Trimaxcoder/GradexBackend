const cron = require('node-cron');
const { LectureEntry } = require('../models/Timetable');
const FcmToken = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');
const { getTermState, isClassTimeActive } = require('../utils/academicTerm');
const { adoptLegacyEntries } = require('../utils/timetableTerm');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Weekday in Nigerian time (UTC+1), so a late or manual trigger still
// names the right day.
const todayInNigeria = () =>
  DAY_NAMES[new Date(Date.now() + 60 * 60 * 1000).getUTCDay()];

async function sendMorningDigests() {
  const today = todayInNigeria();

  // One entry per class with everyone in it who has notifications on.
  // (A missing `enabled` flag counts as on, like before.)
  const groups = await FcmToken.aggregate([
    {
      $match: {
        $or: [{ enabled: true }, { enabled: { $exists: false } }],
        school: { $nin: ['', null] },
        faculty: { $nin: ['', null] },
        department: { $nin: ['', null] },
        level: { $nin: ['', null] },
      },
    },
    {
      $group: {
        _id: {
          school: '$school',
          faculty: '$faculty',
          department: '$department',
          level: '$level',
        },
        tokens: { $addToSet: '$token' },
      },
    },
  ]);

  console.log(`Morning digest: ${groups.length} classes to check for ${today}`);

  const adopted = new Set();
  let sent = 0;
  let onBreak = 0;

  for (const g of groups) {
    const { school, faculty, department, level } = g._id;
    const tokens = (g.tokens || []).filter(Boolean);
    if (tokens.length === 0) continue;

    // Make sure old timetable entries have been given a semester.
    if (!adopted.has(school)) {
      await adoptLegacyEntries(school);
      adopted.add(school);
    }

    // Between semesters (or after the session ends) there are no class updates.
    const state = await getTermState(school);
    if (!isClassTimeActive(state)) {
      onBreak++;
      continue;
    }

    const query = {
      type: 'lecture',
      day: today,
      school,
      faculty,
      department,
      level,
      isCancelled: { $ne: true }, // a cancelled class is not "today's class"
    };
    if (state.status === 'active') query.term = state.current.term;

    const lectures = await LectureEntry.find(query).sort({ startTime: 1 });
    if (lectures.length === 0) continue;

    const courseList = lectures
      .map((l) => `${l.courseCode} (${l.startTime})`)
      .join(', ');

    try {
      await sendToTokens(
        tokens,
        `📚 Today's Classes — ${today}`,
        `You have ${lectures.length} class${lectures.length > 1 ? 'es' : ''}: ${courseList}`,
        { type: 'morning_digest' },
      );
      sent++;
    } catch (err) {
      console.error(`Morning digest failed for ${school} / ${department} / ${level}:`, err);
    }
  }

  console.log(
    `Morning digest done for ${today}: ${sent} classes notified, ${onBreak} skipped (semester break)`,
  );
}

function startMorningDigestJob() {
  // 5am UTC = 6am WAT (Nigeria)
  cron.schedule('0 5 * * *', () => {
    sendMorningDigests().catch(err => console.error('Morning digest error:', err));
  });
}

module.exports = { startMorningDigestJob, sendMorningDigests };