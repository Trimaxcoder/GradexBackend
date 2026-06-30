// models/Announcement.js
const mongoose = require('mongoose');

const AnnouncementSchema = new mongoose.Schema(
  {
    admin: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    adminName:  { type: String, default: '' },
    school:     { type: String, required: true },
    faculty:    { type: String, required: true },
    department: { type: String, required: true },
    // "all" = every level in this dept; otherwise "100", "200", etc.
    level:      { type: String, required: true, default: 'all' },
    title:      { type: String, required: true, trim: true },
    message:    { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

// Index for fast scoped queries
AnnouncementSchema.index({ school: 1, faculty: 1, department: 1, level: 1, createdAt: -1 });

module.exports = mongoose.model('Announcement', AnnouncementSchema);