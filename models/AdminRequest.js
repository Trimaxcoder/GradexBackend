// models/AdminRequest.js
const mongoose = require('mongoose');

const AdminRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // The class the student asks to manage (taken from their profile)
    school:     { type: String, default: '' },
    faculty:    { type: String, default: '' },
    department: { type: String, default: '' },
    level:      { type: String, default: '' },

    // What the student confirmed on the request screen
    fullName:     { type: String, default: '' },
    matricNumber: { type: String, default: '' },
    semester:     { type: Number, enum: [1, 2], default: null },
    finalLevel:   { type: String, default: '' }, // last level before graduation

    reason:   { type: String, default: '' }, // optional now
    proofUrl: { type: String, default: '' },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'resigned', 'revoked'],
      default: 'pending',
    },
    reviewNote: { type: String, default: '' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedAt:  { type: Date, default: Date.now },
  },
  { timestamps: true },
);

AdminRequestSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('AdminRequest', AdminRequestSchema);
