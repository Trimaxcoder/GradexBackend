const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const AnonSessionSchema = new mongoose.Schema(
  {
    class:     { type: ObjectId, ref: 'Class', required: true },
    prompt:    { type: String, trim: true, maxlength: 300, default: '' },
    status:    { type: String, enum: ['open', 'closed'], default: 'open' },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    closedAt:  { type: Date, default: null },
    postCount: { type: Number, default: 0 },

    // Hashed per-session tokens the admin has blocked. Never returned by the API.
    // These are one-way HMACs, so blocking never reveals who the student is.
    blockedTokens: { type: [String], default: [], select: false },
  },
  { timestamps: true }
);

AnonSessionSchema.index({ class: 1, createdAt: -1 });

// At most ONE open session per class, enforced by MongoDB itself
AnonSessionSchema.index(
  { class: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);

AnonSessionSchema.methods.toClient = function () {
  return {
    id:        String(this._id),
    classId:   String(this.class),
    prompt:    this.prompt,
    status:    this.status,
    postCount: this.postCount,
    createdAt: this.createdAt,
    closedAt:  this.closedAt,
  };
};

module.exports = mongoose.model('AnonSession', AnonSessionSchema);