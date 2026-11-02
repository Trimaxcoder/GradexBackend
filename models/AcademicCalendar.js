// models/AcademicCalendar.js
//
// One document per school per academic session, e.g. "2025/2026", holding
// the start and end dates of its semesters. Only the super admin writes these.
// Everything else (is a semester running? is the class timetable current?)
// is worked out from these dates, so no cron job has to "flip" a status.

const mongoose = require('mongoose');

// "University of Lagos " and "university  of lagos" are the same school.
const normalizeSchool = (s) =>
  String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const HOUR = 60 * 60 * 1000;

// Nigeria is UTC+1 all year (no daylight saving), so a date typed by the
// super admin is stored as that day in Nigerian time, then shown back the same way.
const toDay = (d) => new Date(d.getTime() + HOUR).toISOString().slice(0, 10);

const SemesterSchema = new mongoose.Schema(
  {
    number:    { type: Number, enum: [1, 2], required: true },
    startDate: { type: Date, required: true }, // 00:00 on the first day
    endDate:   { type: Date, required: true }, // 23:59 on the last day (last exam)
  },
  { _id: false },
);

// Per-department exceptions to the school's final-year level
// (e.g. Engineering ends at 500 while most programs end at 400).
const FinalLevelOverrideSchema = new mongoose.Schema(
  {
    faculty:    { type: String, default: '', trim: true },
    department: { type: String, required: true, trim: true },
    finalLevel: { type: String, enum: ['300', '400', '500', '600', '700'], required: true },
  },
  { _id: false },
);

const AcademicCalendarSchema = new mongoose.Schema(
  {
    school:    { type: String, required: true, trim: true },
    schoolKey: { type: String, required: true }, // normalized school, for matching
    session: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{4}\/\d{4}$/, 'Session must look like 2025/2026'],
    },
    semesters: { type: [SemesterSchema], default: [] },

    // Set by the level-promotion job (step 6) once students have been moved up.
    // A promoted session is locked: it can no longer be edited or deleted.
    promotedAt: { type: Date, default: null },

    // Move students up a level automatically after this session ends.
    // Off unless the super admin turns it on for the session.
    autoPromote: { type: Boolean, default: false },

    // The last level of most programs at this school. A department that has
    // students or timetables above it is never graduated early.
    finalLevel: {
      type: String,
      enum: ['300', '400', '500', '600', '700'],
      default: '400',
    },
    finalLevelOverrides: { type: [FinalLevelOverrideSchema], default: [] },

    // Held while a promotion runs so two runs can't overlap.
    promotionLock: { type: Date, default: null },

    // Semesters whose "update your classes" notice to reps has been sent.
    startNotified: { type: [Number], default: [] },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

AcademicCalendarSchema.index({ schoolKey: 1, session: 1 }, { unique: true });

function fail(message) {
  const err = new Error(message);
  err.name = 'ValidationError';
  return err;
}

// Written without a `next` callback (it throws instead), which works on every
// Mongoose version.
AcademicCalendarSchema.pre('validate', function () {
  if (!this.school || !this.session) return; // "required" will report it
  this.schoolKey = normalizeSchool(this.school);

  if (!/^\d{4}\/\d{4}$/.test(this.session)) {
    throw fail('Session must look like 2025/2026');
  }
  const [from, to] = this.session.split('/').map(Number);
  if (to !== from + 1) {
    throw fail('Session years must be consecutive, e.g. 2025/2026');
  }

  const sems = [...this.semesters].sort((a, b) => a.number - b.number);
  if (sems.length < 1 || sems.length > 2) {
    throw fail('A session needs one or two semesters');
  }
  if (new Set(sems.map((s) => s.number)).size !== sems.length) {
    throw fail('Each semester number can only be used once');
  }
  for (const s of sems) {
    if (!(s.endDate > s.startDate)) {
      throw fail(`Semester ${s.number} must end after it starts`);
    }
  }
  if (sems.length === 2 && !(sems[1].startDate > sems[0].endDate)) {
    throw fail('Semester 2 must start after semester 1 ends');
  }
});

AcademicCalendarSchema.statics.normalizeSchool = normalizeSchool;

// Shape sent to the app: plain "YYYY-MM-DD" days, easy to show and edit.
AcademicCalendarSchema.methods.toClient = function () {
  return {
    id: this._id,
    school: this.school,
    session: this.session,
    semesters: [...this.semesters]
      .sort((a, b) => a.number - b.number)
      .map((s) => ({
        number: s.number,
        startDay: toDay(s.startDate),
        endDay: toDay(s.endDate),
      })),
    promotedAt: this.promotedAt,
    autoPromote: this.autoPromote,
    finalLevel: this.finalLevel,
    finalLevelOverrides: (this.finalLevelOverrides || []).map((o) => ({
      faculty: o.faculty,
      department: o.department,
      finalLevel: o.finalLevel,
    })),
  };
};

module.exports = mongoose.model('AcademicCalendar', AcademicCalendarSchema);
