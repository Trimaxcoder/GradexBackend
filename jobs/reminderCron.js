const cron = require('node-cron');
const ClassReminder = require('../models/ClassReminder');
const { LectureEntry } = require('../models/Timetable');
const FcmToken = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WAT_OFFSET_HOURS = 1;

function getWATNow() {
  const now = new Date();
  return new Date(now.getTime() + WAT_OFFSET_HOURS * 60 * 60 * 1000);
}

const ALERT_FIELDS = ['isEmergency', 'isTest', 'isAttendance', 'isCancelled'];

function startReminderCron() {
  // ── Existing: class reminders ─────────────────────────────────────────
  cron.schedule('* * * * *', async () => {
    try {
      const watNow = getWATNow();
      const todayName = DAY_NAMES[watNow.getUTCDay()];
      const todayDateStr = watNow.toISOString().split('T')[0];
      const nowMinutes = watNow.getUTCHours() * 60 + watNow.getUTCMinutes();

      const reminders = await ClassReminder.find({ enabled: true })
        .populate('lecture')
        .populate('user');

      for (const reminder of reminders) {
        const lecture = reminder.lecture;
        if (!lecture || lecture.day !== todayName) continue;
        if (reminder.lastFiredDate === todayDateStr) continue;

        const [h, m] = lecture.startTime.split(':').map(Number);
        const classMinutes = h * 60 + m;
        const fireAtMinutes = classMinutes - reminder.minutesBefore;

        if (nowMinutes === fireAtMinutes) {
          const fcmDoc = await FcmToken.findOne({ user: reminder.user._id });
          if (fcmDoc?.token) {
            await sendToTokens(
              [fcmDoc.token],
              '⏰ Class Reminder',
              `${lecture.courseCode} starts in ${reminder.minutesBefore} min${lecture.venue ? ' @ ' + lecture.venue : ''}`,
              { type: 'class_reminder', lectureId: String(lecture._id) }
            );
          }
          reminder.lastFiredDate = todayDateStr;
          await reminder.save();
        }
      }
    } catch (err) {
      console.error('Reminder cron error:', err);
    }
  });

  // ── New: auto-expire alert flags after class endTime ──────────────────
  cron.schedule('* * * * *', async () => {
    try {
      const watNow = getWATNow();
      const todayName = DAY_NAMES[watNow.getUTCDay()];
      const nowMinutes = watNow.getUTCHours() * 60 + watNow.getUTCMinutes();

      // Find lectures today with any alert flag on
      const activeLectures = await LectureEntry.find({
        day: todayName,
        $or: ALERT_FIELDS.map(f => ({ [f]: true })),
      });

      for (const lecture of activeLectures) {
        const [eh, em] = lecture.endTime.split(':').map(Number);
        const endMinutes = eh * 60 + em;

        if (nowMinutes >= endMinutes) {
          // Silently turn off all active flags — no notification
          let changed = false;
          for (const field of ALERT_FIELDS) {
            if (lecture[field]) {
              lecture[field] = false;
              changed = true;
            }
          }
          if (changed) {
            lecture.updatedAt = new Date();
            await lecture.save();
            console.log(`Auto-expired alerts for ${lecture.courseCode} (${lecture._id})`);
          }
        }
      }
    } catch (err) {
      console.error('Alert auto-expire cron error:', err);
    }
  });

  console.log('⏰ Reminder + alert auto-expire cron jobs started (WAT timezone)');
}

module.exports = { startReminderCron };