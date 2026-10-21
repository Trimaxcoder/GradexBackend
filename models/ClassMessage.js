const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const MessageSchema = new mongoose.Schema(
  {
    class:   { type: ObjectId, ref: 'Class', required: true },
    sender:  { type: ObjectId, ref: 'User', required: true },
    text:    { type: String, trim: true, maxlength: 2000, default: '' },
    replyTo: { type: ObjectId, ref: 'ClassMessage', default: null },
    pinned:  { type: Boolean, default: false },
    deleted: { type: Boolean, default: false }, // soft delete, text is wiped
    reportedBy: { type: [ObjectId], default: [], select: false },
  },
  { timestamps: true }
);

MessageSchema.index({ class: 1, _id: -1 });
MessageSchema.index({ class: 1, pinned: 1 });

// Shape sent to the Flutter app. Needs `sender` and `replyTo` populated
// (use ClassMessage.POPULATE) so names can be included.
MessageSchema.methods.toClient = function () {
  const nameOf = (u) => (u && u.profile && u.profile.name) || 'Student';
  const idOf   = (v) => String(v && v._id ? v._id : v);

  let replyTo = null;
  if (this.replyTo && typeof this.replyTo === 'object' && this.replyTo.text !== undefined) {
    replyTo = {
      id:         String(this.replyTo._id),
      text:       this.replyTo.deleted ? '' : String(this.replyTo.text || '').slice(0, 120),
      deleted:    !!this.replyTo.deleted,
      senderName: nameOf(this.replyTo.sender),
    };
  }

  return {
    id:        String(this._id),
    classId:   String(this.class),
    sender:    { id: idOf(this.sender), name: nameOf(this.sender) },
    text:      this.deleted ? '' : this.text,
    deleted:   !!this.deleted,
    pinned:    !!this.pinned,
    replyTo,
    createdAt: this.createdAt,
  };
};

const ClassMessage = mongoose.model('ClassMessage', MessageSchema);

ClassMessage.POPULATE = [
  { path: 'sender', select: 'profile.name' },
  {
    path:     'replyTo',
    select:   'text deleted sender',
    populate: { path: 'sender', select: 'profile.name' },
  },
];

module.exports = ClassMessage;