// models/Announcement.js
const mongoose = require('mongoose');

// Class announcements must carry a full target; global ones carry none.
const requiredForClass = function () {
  return this.scope === 'class';
};

const AnnouncementSchema = new mongoose.Schema(
  {
    // 'global' = whole app, superadmin only
    // 'class'  = one school/faculty/department/level, posted by that class's rep
    // Old documents have no scope; Mongoose defaults them to 'class'.
    scope: {
      type:     String,
      enum:     ['global', 'class'],
      default:  'class',
      required: true,
    },

    admin: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    adminName: { type: String, default: '' },

    school:     { type: String, required: requiredForClass, default: '' },
    faculty:    { type: String, required: requiredForClass, default: '' },
    department: { type: String, required: requiredForClass, default: '' },
    level:      { type: String, required: requiredForClass, default: '' },

    title:    { type: String, required: true, trim: true },
    message:  { type: String, required: true, trim: true },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// New class announcements can never be department-wide ('all').
// Only checked on creation so legacy 'all' documents can still be edited.
AnnouncementSchema.pre('validate', function (next) {
  if (
    this.isNew &&
    this.scope === 'class' &&
    String(this.level).trim().toLowerCase() === 'all'
  ) {
    return next(new Error('Class announcements must target a specific level'));
  }
  next();
});

AnnouncementSchema.index({ scope: 1, createdAt: -1 });
AnnouncementSchema.index({
  school: 1, faculty: 1, department: 1, level: 1, createdAt: -1,
});
AnnouncementSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model('Announcement', AnnouncementSchema);