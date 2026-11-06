// models/Call.js
//
// One document per voice or video call between two friends. Used to ring the
// other person, to stop a second call at the same time, and to add up how many
// call minutes each student used today (so nobody can use up the free monthly
// allowance).

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const CallSchema = new mongoose.Schema(
  {
    class:  { type: ObjectId, ref: 'Class', required: true },
    caller: { type: ObjectId, ref: 'User', required: true },
    callee: { type: ObjectId, ref: 'User', required: true },
    kind:   { type: String, enum: ['voice', 'video'], default: 'voice' },

    // ringing -> active -> ended, or ringing -> missed / declined / cancelled
    status: {
      type: String,
      enum: ['ringing', 'active', 'ended', 'missed', 'declined', 'cancelled'],
      default: 'ringing',
    },

    channel:    { type: String, required: true },
    answeredAt: { type: Date, default: null },
    endedAt:    { type: Date, default: null },

    // Real seconds spoken, and the same counted for the daily limit
    // (video counts more because it costs more).
    durationSec:     { type: Number, default: 0 },
    weightedSeconds: { type: Number, default: 0 },
  },
  { timestamps: true }
);

CallSchema.index({ caller: 1, status: 1 });
CallSchema.index({ callee: 1, status: 1 });
CallSchema.index({ answeredAt: 1 });

module.exports = mongoose.model('Call', CallSchema);