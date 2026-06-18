const mongoose = require('mongoose');

const classReminderSchema = new mongoose.Schema({
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lecture:        { type: mongoose.Schema.Types.ObjectId, ref: 'LectureEntry', required: true },
  enabled:        { type: Boolean, default: false },
  minutesBefore:  { type: Number, default: 10 },
  lastFiredDate:  { type: String, default: '' }, // e.g. "2026-06-22" to prevent duplicate fires same day
}, { timestamps: true });

// One reminder setting per user per lecture
classReminderSchema.index({ user: 1, lecture: 1 }, { unique: true });

module.exports = mongoose.model('ClassReminder', classReminderSchema);