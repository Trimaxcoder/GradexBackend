const cron = require('node-cron');
const ClassReminder = require('../models/ClassReminder');
const { LectureEntry } = require('../models/Timetable');
const FcmToken = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function startReminderCron() {
  // Runs every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const todayName = DAY_NAMES[now.getDay()];
      const todayDateStr = now.toISOString().split('T')[0]; // "2026-06-22"
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      const reminders = await ClassReminder.find({ enabled: true })
        .populate('lecture')
        .populate('user');

      for (const reminder of reminders) {
        const lecture = reminder.lecture;
        if (!lecture || lecture.day !== todayName) continue;
        if (reminder.lastFiredDate === todayDateStr) continue; // already fired today

        const [h, m] = lecture.startTime.split(':').map(Number);
        const classMinutes = h * 60 + m;
        const fireAtMinutes = classMinutes - reminder.minutesBefore;

        if (nowMinutes === fireAtMinutes) {
          const fcmDoc = await FcmToken.findOne({ user: reminder.user._id });
          if (fcmDoc?.token) {
            await sendToTokens(
              [fcmDoc.token],
              '⏰ Class Reminder',
              `${lecture.courseCode} starts in ${reminder.minutesBefore} min${reminder.venue ? ' @ ' + lecture.venue : ''}`,
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

  console.log('⏰ Reminder cron job started');
}

module.exports = { startReminderCron };