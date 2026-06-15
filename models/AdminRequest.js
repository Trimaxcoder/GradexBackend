const mongoose = require('mongoose');

const adminRequestSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  school:     { type: String, required: true },
  faculty:    { type: String, required: true },
  department: { type: String, required: true },
  level:      { type: String, required: true },
  reason:     { type: String, required: true },
  // e.g. student ID card, course rep appointment letter
  proofUrl:   { type: String, default: '' },
  status:     { type: String, enum: ['pending', 'approved', 'rejected', 'resigned', 'revoked'], default: 'pending' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewNote: { type: String, default: '' },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
});

module.exports = mongoose.model('AdminRequest', adminRequestSchema);