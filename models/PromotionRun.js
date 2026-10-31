// models/PromotionRun.js
//
// One document per promotion run. It remembers exactly what changed for each
// person, which is what makes a promotion undoable.

const mongoose = require('mongoose');

const ScopeSchema = new mongoose.Schema(
  {
    school:     { type: String, default: '' },
    faculty:    { type: String, default: '' },
    department: { type: String, default: '' },
    level:      { type: String, default: '' },
  },
  { _id: false },
);

const ChangeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // What the person's "last promoted session" was before this run
    prevSession: { type: String, default: '' },

    // Student side
    levelFrom: { type: String, default: '' }, // level before ('' = untouched)
    levelTo:   { type: String, default: '' }, // level after  ('' = unchanged)
    graduated: { type: Boolean, default: false }, // marked as graduated

    // Course rep side
    scopeAction: { type: String, enum: ['', 'promote', 'revoke'], default: '' },
    scopeFrom:   { type: ScopeSchema, default: undefined }, // class before
    scopeTo:     { type: String, default: '' },             // new level if promoted
  },
  { _id: false },
);

const PromotionRunSchema = new mongoose.Schema(
  {
    calendar: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AcademicCalendar',
      required: true,
    },
    school:  { type: String, required: true },
    session: { type: String, required: true },
    mode:    { type: String, enum: ['auto', 'manual'], required: true },
    triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    stats:   { type: mongoose.Schema.Types.Mixed, default: {} },
    changes: { type: [ChangeSchema], default: [] },

    status:   { type: String, enum: ['running', 'done'], default: 'running' },
    undoneAt: { type: Date, default: null },
  },
  { timestamps: true },
);

PromotionRunSchema.index({ school: 1, createdAt: -1 });

module.exports = mongoose.model('PromotionRun', PromotionRunSchema);