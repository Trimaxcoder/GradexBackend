// models/Carryover.js
//
// A course a student is carrying over from a lower level of their own
// department. It gives them that course's classes, alerts and exam notices
// without changing their own level.

const mongoose = require('mongoose');

const CarryoverSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // The class the course belongs to (exactly as on its timetable)
    school:     { type: String, required: true },
    faculty:    { type: String, required: true },
    department: { type: String, required: true },
    level:      { type: String, required: true },

    courseKey:   { type: String, required: true }, // "CSC201" (upper case, no spaces)
    courseCode:  { type: String, required: true }, // as written on the timetable
    courseTitle: { type: String, default: '' },
  },
  { timestamps: true },
);

// A student can add each course once
CarryoverSchema.index(
  { user: 1, school: 1, faculty: 1, department: 1, level: 1, courseKey: 1 },
  { unique: true },
);
// Finds everyone carrying a course (for notifications)
CarryoverSchema.index({ school: 1, faculty: 1, department: 1, level: 1, courseKey: 1 });

module.exports = mongoose.model('Carryover', CarryoverSchema);