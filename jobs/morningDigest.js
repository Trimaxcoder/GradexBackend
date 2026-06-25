const cron = require('node-cron');
const LectureEntry = require('../models/Timetable').LectureEntry;
const FcmToken = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function sendMorningDigests() {
  const today = DAY_NAMES[new Date().getDay()];

  const allTokens = await FcmToken.find({
    $or: [{ enabled: true }, { enabled: { $exists: false } }]
  });

  console.log('Total tokens found:', allTokens.length);

  for (const fcmDoc of allTokens) {
    const { school, faculty, department, level, token } = fcmDoc;

    const lectures = await LectureEntry.find({
      type: 'lecture',
      day: today,
      school, faculty, department, level,
    }).sort({ startTime: 1 });

    if (lectures.length === 0) continue;

    const courseList = lectures
      .map(l => `${l.courseCode} (${l.startTime})`)
      .join(', ');

    await sendToTokens(
      [token],
      `📚 Today's Classes — ${today}`,
      `You have ${lectures.length} class${lectures.length > 1 ? 'es' : ''}: ${courseList}`,
      { type: 'morning_digest' }
    );
  }

  console.log(`Morning digest sent for ${today}`);
}

function startMorningDigestJob() {
  // 5am UTC = 6am WAT (Nigeria)
  cron.schedule('* * * * *', () => {
    sendMorningDigests().catch(err => console.error('Morning digest error:', err));
  });
}

module.exports = { startMorningDigestJob, sendMorningDigests };