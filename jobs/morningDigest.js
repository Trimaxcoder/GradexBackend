const cron = require("node-cron");
const LectureEntry = require("../models/Timetable").LectureEntry;
const FcmToken = require("../models/FcmToken");
const { sendToTokens } = require("../config/firebase");

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

async function sendMorningDigests() {
  const today = DAY_NAMES[new Date().getDay()];

  // Group all FCM tokens by their school/faculty/department/level scope
  const allTokens = await FcmToken.find({
    $or: [{ enabled: true }, { enabled: { $exists: false } }],
  });
  console.log("Total tokens found:", allTokens.length);
  console.log(
    "Tokens:",
    JSON.stringify(
      allTokens.map((t) => ({ user: t.user, token: t.token.slice(0, 20) })),
    ),
  );
  const scopeMap = new Map(); // key: "school|faculty|dept|level" -> [tokens]

  for (const t of allTokens) {
    const key = `${t.school}|${t.faculty}|${t.department}|${t.level}`;
    if (!scopeMap.has(key)) scopeMap.set(key, []);
    scopeMap.get(key).push(t.token);
  }

  for (const [key, tokens] of scopeMap.entries()) {
    const [school, faculty, department, level] = key.split("|");

    const lectures = await LectureEntry.find({
      type: "lecture",
      day: today,
      school,
      faculty,
      department,
      level,
    }).sort({ startTime: 1 });

    if (lectures.length === 0) continue;

    const courseList = lectures
      .map((l) => `${l.courseCode} (${l.startTime})`)
      .join(", ");

    await sendToTokens(
      tokens,
      `📚 Today's Classes — ${today}`,
      `You have ${lectures.length} class${lectures.length > 1 ? "es" : ""}: ${courseList}`,
      { type: "morning_digest" },
    );
  }

  console.log(`Morning digest sent for ${today}`);
}

function startMorningDigestJob() {
  // Runs every day at 6:00 AM server time
  cron.schedule('0 5 * * *', () => {
    sendMorningDigests().catch((err) =>
      console.error("Morning digest error:", err),
    );
  });
}

module.exports = { startMorningDigestJob, sendMorningDigests };
