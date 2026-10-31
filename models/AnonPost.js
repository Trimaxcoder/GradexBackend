const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const AnonPostSchema = new mongoose.Schema(
  {
    session: { type: ObjectId, ref: 'AnonSession', required: true },
    class:   { type: ObjectId, ref: 'Class', required: true },
    text:    { type: String, required: true, trim: true, maxlength: 1000 },

    // HMAC(session + user). Used only for rate limiting and blocking abusers.
    // It is NEVER returned by the API (select: false) and there is no user field.
    tokenHash: { type: String, required: true, select: false },

    hidden: { type: Boolean, default: false },

    // Set when this post answers another post of the same session
    replyTo:   { type: ObjectId, ref: 'AnonPost', default: null },
    // The start of the post it answers. Cleared when that post is hidden.
    replyText: { type: String, default: '', maxlength: 200 },

    // The class this post was shared from ('' = written in this class).
    // Like every other field, it says nothing about WHO shared it.
    sharedFrom: { type: String, default: '', maxlength: 120 },
  },
  { timestamps: true }
);

AnonPostSchema.index({ session: 1, _id: -1 });
AnonPostSchema.index({ session: 1, tokenHash: 1, createdAt: -1 });
// Finds the replies of a post that is being hidden
AnonPostSchema.index({ replyTo: 1 }, { sparse: true });

// Timestamps are rounded down to the minute so exact send times can't be
// matched against who was online at that moment.
AnonPostSchema.methods.toClient = function () {
  const t = this.createdAt ? this.createdAt.getTime() : Date.now();
  return {
    id:        String(this._id),
    sessionId: String(this.session),
    classId:   String(this.class),
    text:      this.text,
    createdAt: new Date(Math.floor(t / 60000) * 60000),
    replyTo:   this.replyTo
      ? { id: String(this.replyTo), text: this.replyText || '' }
      : null,
    sharedFrom: this.sharedFrom || '',
  };
};

module.exports = mongoose.model('AnonPost', AnonPostSchema);