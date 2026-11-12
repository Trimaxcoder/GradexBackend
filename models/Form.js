const mongoose = require("mongoose");
const crypto = require("crypto");

// Keys that match StudentProfileSchema in User.js. A field linked to one of
// these can be autofilled from the student's profile.
const PROFILE_KEYS = [
  "name",
  "matricNumber",
  "department",
  "faculty",
  "email",
  "school",
  "level",
];

const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "date",
  "email",
  "phone",
  "dropdown",
  "radio",
  "checkbox",
];

const FieldSchema = new mongoose.Schema(
  {
    id: { type: String, required: true }, // e.g. "f1", "f2" (made by the app)
    label: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: FIELD_TYPES, default: "text" },
    required: { type: Boolean, default: false },
    options: { type: [String], default: [] }, // for dropdown / radio / checkbox
    // "" = manual only. Otherwise one of PROFILE_KEYS (autofill allowed).
    profileKey: { type: String, enum: [...PROFILE_KEYS, ""], default: "" },
  },
  { _id: false },
);

const FormSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Optional: the class this form belongs to
    classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", default: null },

    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, default: "", maxlength: 2000 },
    logoUrl: { type: String, default: "" }, // logo or letterhead image

    // Short random id used in the public link: /f/<publicId>
    publicId: {
      type: String,
      unique: true,
      default: () => crypto.randomBytes(6).toString("base64url"),
    },

    status: { type: String, enum: ["open", "collected"], default: "open" },
    collectedAt: { type: Date, default: null },

    fields: {
      type: [FieldSchema],
      validate: [
        (v) => v.length >= 1 && v.length <= 50,
        "A form needs between 1 and 50 fields",
      ],
    },
  },
  { timestamps: true },
);

FormSchema.statics.PROFILE_KEYS = PROFILE_KEYS;
FormSchema.statics.FIELD_TYPES = FIELD_TYPES;

module.exports = mongoose.model("Form", FormSchema);