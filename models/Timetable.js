const mongoose = require('mongoose');

// ── Lecture / Exam Entry (shared collection, differentiated by `type`) ────────
const lectureSchema = new mongoose.Schema({
  type:        { type: String, enum: ['lecture', 'exam'], default: 'lecture' },
  courseCode:  { type: String, required: true },
  courseTitle: { type: String, default: '' },
  day:         { type: String, default: '' },
  date:        { type: Date },
  startTime:   { type: String, required: true },
  endTime:     { type: String, required: true },
  venue:       { type: String, default: '' },
  classType:   { type: String, default: 'normal' },
  isImportant: { type: Boolean, default: false },
  note:        { type: String, default: '' },
  school:      { type: String, default: '' },
  faculty:     { type: String, default: '' },
  department:  { type: String, default: '' },
  level:       { type: String, default: '' },

  // The semester this entry belongs to, e.g. "2025/2026-1".
  // Empty means "not stamped yet" (old entries, or a school with no academic
  // calendar). Entries from a finished semester simply stop matching the
  // current term, so they go quiet by themselves and nothing is deleted.
  term:        { type: String, default: '' },

  isEmergency: { type: Boolean, default: false },
  isTest:      { type: Boolean, default: false },
  isAttendance:  { type: Boolean, default: false },
  isCancelled:   { type: Boolean, default: false },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt:   { type: Date, default: Date.now },
}, { timestamps: true });

lectureSchema.index({ school: 1, faculty: 1, department: 1, level: 1, type: 1, term: 1 });

// ── Personal Entry ────────────────────────────────────────────────────────────
const personalSchema = new mongoose.Schema({
  user:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:           { type: String, required: true },
  day:             { type: String, required: true },
  startTime:       { type: String, required: true },
  endTime:         { type: String, required: true },
  color:           { type: String, default: '#4F46E5' },
  note:            { type: String, default: '' },
  isBookmarked:    { type: Boolean, default: false },
  reminderMinutes: { type: Number, default: 0 },
  updatedAt:       { type: Date, default: Date.now },
}, { timestamps: true });

const LectureEntry = mongoose.model('LectureEntry', lectureSchema);
const PersonalEntry = mongoose.model('PersonalEntry', personalSchema);

module.exports = { LectureEntry, PersonalEntry };