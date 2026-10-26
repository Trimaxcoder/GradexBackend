const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// A photo, file or voice note. The file itself lives on Cloudinary.
const AttachmentSchema = new mongoose.Schema(
  {
    kind:     { type: String, enum: ['image', 'file', 'audio'], required: true },
    url:      { type: String, required: true },
    name:     { type: String, default: '', maxlength: 120 },
    size:     { type: Number, default: 0 },   // bytes
    mime:     { type: String, default: '', maxlength: 100 },
    duration: { type: Number, default: 0 },   // seconds, voice notes only
  },
  { _id: false }
);

const MessageSchema = new mongoose.Schema(
  {
    class:   { type: ObjectId, ref: 'Class', required: true },
    sender:  { type: ObjectId, ref: 'User', required: true },
    text:    { type: String, trim: true, maxlength: 2000, default: '' },
    attachment: { type: AttachmentSchema, default: null },
    replyTo: { type: ObjectId, ref: 'ClassMessage', default: null },
    pinned:  { type: Boolean, default: false },
    deleted: { type: Boolean, default: false }, // soft delete, text is wiped
    reportedBy: { type: [ObjectId], default: [], select: false },
  },
  { timestamps: true }
);

MessageSchema.index({ class: 1, _id: -1 });
MessageSchema.index({ class: 1, pinned: 1 });

// What a reply preview shows when the original has no text
const labelFor = (m) => {
  if (m.text) return String(m.text).slice(0, 120);
  const a = m.attachment;
  if (!a) return '';
  if (a.kind === 'image') return 'Photo';
  if (a.kind === 'audio') return 'Voice note';
  return a.name ? `File: ${a.name}` : 'File';
};

// Shape sent to the Flutter app. Needs `sender` and `replyTo` populated
// (use ClassMessage.POPULATE) so names can be included.
MessageSchema.methods.toClient = function () {
  const nameOf = (u) => (u && u.profile && u.profile.name) || 'Student';
  const idOf   = (v) => String(v && v._id ? v._id : v);

  let replyTo = null;
  if (this.replyTo && typeof this.replyTo === 'object' && this.replyTo.text !== undefined) {
    replyTo = {
      id:         String(this.replyTo._id),
      text:       this.replyTo.deleted ? '' : labelFor(this.replyTo),
      deleted:    !!this.replyTo.deleted,
      senderName: nameOf(this.replyTo.sender),
    };
  }

  const a = this.attachment;
  const attachment = !this.deleted && a && a.url
    ? { kind: a.kind, url: a.url, name: a.name, size: a.size, mime: a.mime, duration: a.duration }
    : null;

  return {
    id:        String(this._id),
    classId:   String(this.class),
    sender:    { id: idOf(this.sender), name: nameOf(this.sender) },
    text:      this.deleted ? '' : this.text,
    attachment,
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
    select:   'text deleted sender attachment',
    populate: { path: 'sender', select: 'profile.name' },
  },
];

module.exports = ClassMessage;