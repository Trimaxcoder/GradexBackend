const mongoose = require('mongoose');

const fcmTokenSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token:     { type: String, required: true },
  // For scoped notifications
  school:     { type: String, default: '' },
  faculty:    { type: String, default: '' },
  department: { type: String, default: '' },
  level:      { type: String, default: '' },
  enabled: { type: Boolean, default: true },
  updatedAt:  { type: Date, default: Date.now },
});

// One token doc per user (upsert on save)
fcmTokenSchema.index({ user: 1 }, { unique: true });

module.exports = mongoose.model('FcmToken', fcmTokenSchema);