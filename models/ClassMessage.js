const mongoose = require('mongoose');
const { displayName } = require('../utils/displayName');
const { groupReactions } = require('../utils/reactions');

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

// One person's reaction to a message
const ReactionSchema = new mongoose.Schema(
  {
    user:  { type: ObjectId, ref: 'User', required: true },
    emoji: { type: String, required: true, maxlength: 8 },
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
    reactions: { type: [ReactionSchema], default: [] },
    editedAt:  { type: Date, default: null }, // set when the text was edited
    forwarded: { type: Boolean, default: false }, // this message was forwarded from another chat
    // people tagged with @username in the text (checked against the class members)
    mentions: [{ _id: false, user: { type: ObjectId, ref: 'User' }, username: String }],
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
  const nameOf = (u) => displayName(u);
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
    reactions: this.deleted ? {} : groupReactions(this.reactions),
    editedAt:  this.deleted ? null : (this.editedAt || null),
    forwarded: !this.deleted && !!this.forwarded,
    mentions:  this.deleted ? [] : (this.mentions || []).map((x) => ({ id: String(x.user), username: x.username })),
    replyTo,
    createdAt: this.createdAt,
  };
};

const ClassMessage = mongoose.model('ClassMessage', MessageSchema);

ClassMessage.POPULATE = [
  { path: 'sender', select: 'profile.name username' },
  {
    path:     'replyTo',
    select:   'text deleted sender attachment',
    populate: { path: 'sender', select: 'profile.name username' },
  },
];

module.exports = ClassMessage;