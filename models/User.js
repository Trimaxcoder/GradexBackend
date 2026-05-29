const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ── Grading Rule sub-schema ───────────────────────────────────────────────────
const GradeRuleSchema = new mongoose.Schema(
  {
    grade:      { type: String, required: true },
    minScore:   { type: Number, required: true, min: 0, max: 100 },
    gradePoint: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// ── Grading Model sub-schema ──────────────────────────────────────────────────
const GradingModelSchema = new mongoose.Schema(
  {
    rules: { type: [GradeRuleSchema], default: [] },
  },
  { _id: false }
);

// ── Student Profile sub-schema ────────────────────────────────────────────────
const StudentProfileSchema = new mongoose.Schema(
  {
    name:         { type: String, default: '' },
    matricNumber: { type: String, default: '' },
    department:   { type: String, default: '' },
    faculty:      { type: String, default: '' },
    email:        { type: String, default: '' },
    school:       { type: String, default: '' },
  },
  { _id: false }
);

// ── User schema ───────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema(
  {
    email: {
      type:      String,
      required:  [true, 'Email is required'],
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     [/^\S+@\S+\.\S+$/, 'Invalid email address'],
    },
    password: {
      type:      String,
      required:  [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select:    false,
    },
    profile: {
      type:    StudentProfileSchema,
      default: () => ({}),
    },
    grading: {
      type:    GradingModelSchema,
      default: () => ({ rules: [] }),
    },
    refreshToken: {
      type:   String,
      select: false,
    },

    // ── Password reset ──────────────────────────────────────────────────────
    resetPasswordToken: {
      type:   String,
      select: false,
    },
    resetPasswordExpiry: {
      type:   Date,
      select: false,
    },

    // ── Google OAuth ────────────────────────────────────────────────────────
    googleId: {
      type: String,
    },
  },
  { timestamps: true }
);

// ── Pre-save: hash password ───────────────────────────────────────────────────
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt    = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── Instance method: compare plain-text password ──────────────────────────────
UserSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// ── Remove sensitive fields from JSON output ──────────────────────────────────
UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpiry;
  return obj;
};

module.exports = mongoose.model('User', UserSchema);