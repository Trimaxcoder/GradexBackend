const cron = require('node-cron');
const ClassReminder = require('../models/ClassReminder');
const { LectureEntry } = require('../models/Timetable');
const FcmToken = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WAT_OFFSET_HOURS = 1; // West Africa Time = UTC+1

function getWATNow() {
  const now = new Date();
  // Add 1 hour to convert server UTC time to WAT
  return new Date(now.getTime() + WAT_OFFSET_HOURS * 60 * 60 * 1000);
}

function startReminderCron() {
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

  console.log('⏰ Reminder cron job started (WAT timezone)');
}

module.exports = { startReminderCron };