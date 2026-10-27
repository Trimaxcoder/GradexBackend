const mongoose = require('mongoose');
const crypto   = require('crypto');

const { ObjectId } = mongoose.Schema.Types;

// No 0/O/1/I so codes are easy to read aloud or type from a screenshot
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH   = 6;

const randomCode = () => {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
};

// ── Member sub-schema ─────────────────────────────────────────────────────────
const MemberSchema = new mongoose.Schema(
  {
    user:     { type: ObjectId, ref: 'User', required: true },
    role:     { type: String, enum: ['admin', 'member'], default: 'member' },
    status:   { type: String, enum: ['active', 'pending'], default: 'active' },
    muted:    { type: Boolean, default: false },
    joinedAt: { type: Date, default: Date.now },
    // Receipts: the newest chat message that reached / was seen by this member
    lastDelivered: { type: ObjectId, default: null },
    lastRead:      { type: ObjectId, default: null },
  },
  { _id: false }
);

// ── Class schema ──────────────────────────────────────────────────────────────
const ClassSchema = new mongoose.Schema(
  {
    name: {
      type:      String,
      required:  [true, 'Class name is required'],
      trim:      true,
      minlength: 2,
      maxlength: 80,
    },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    owner:       { type: ObjectId, ref: 'User', required: true },
    joinCode: {
      type:      String,
      required:  true,
      unique:    true,
      uppercase: true,
    },
    requireApproval: { type: Boolean, default: false },
    chatLocked:      { type: Boolean, default: false }, // true = only admins can post
    archived:        { type: Boolean, default: false },
    members:         { type: [MemberSchema], default: [] },
  },
  { timestamps: true }
);

ClassSchema.index({ 'members.user': 1 });

// ── Helpers ───────────────────────────────────────────────────────────────────
ClassSchema.methods.getMember = function (userId) {
  const id = String(userId);
  return this.members.find((m) => String(m.user) === id) || null;
};

ClassSchema.methods.isActiveMember = function (userId) {
  const m = this.getMember(userId);
  return !!m && m.status === 'active';
};

ClassSchema.methods.isAdmin = function (userId) {
  const m = this.getMember(userId);
  return !!m && m.status === 'active' && m.role === 'admin';
};

ClassSchema.statics.generateUniqueCode = async function () {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const taken = await this.exists({ joinCode: code });
    if (!taken) return code;
  }
  throw new Error('Could not generate a unique join code');
};

module.exports = mongoose.model('Class', ClassSchema);