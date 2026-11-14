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

// How the responses table looks on screen, in the PDF and when printed.
const CASES = ["none", "upper", "lower", "sentence", "title", "camel"];

const TableSettingsSchema = new mongoose.Schema(
  {
    numbered: { type: Boolean, default: true },
    numberLabel: { type: String, default: "S/N", maxlength: 12 },
    showSubmitter: { type: Boolean, default: false },
    // Payment status and "paid on" columns (only used when the form takes payment)
    showPayment: { type: Boolean, default: true },
    align: { type: String, enum: ["left", "center", "right"], default: "left" },
    headerCase: { type: String, enum: CASES, default: "none" },
    cellCase: { type: String, enum: CASES, default: "none" },
    fontSize: { type: String, enum: ["small", "normal", "large"], default: "normal" },
    orientation: { type: String, enum: ["portrait", "landscape"], default: "landscape" },
    // Empty rows added at the end of the printout, to be filled with a pen
    blankRows: { type: Number, default: 0, min: 0, max: 100 },
    // Empty columns (e.g. Signature) added to the printout
    blankColumns: { type: [String], default: [] },
    // Questions left out of the printout
    hiddenFieldIds: { type: [String], default: [] },
    // The question shown as the first column (after S/N)
    firstFieldId: { type: String, default: "" },
    sortFieldId: { type: String, default: "" },
    sortDir: { type: String, enum: ["asc", "desc"], default: "asc" },
    // Signature lines at the bottom, e.g. "Class Rep", "HOD"
    signatories: { type: [String], default: [] },
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

    // Deadline: after this time the form stops accepting and editing responses
    closesAt: { type: Date, default: null },

    // Question that must be different for every response (e.g. matric number)
    uniqueFieldId: { type: String, default: "" },

    // Optional payment (class dues). The money goes straight to the creator's
    // bank account through the payment company. SchoolLife never holds it.
    payment: {
      type: new mongoose.Schema(
        {
          enabled: { type: Boolean, default: false },
          amountKobo: { type: Number, default: 0 }, // ₦1 = 100 kobo
          label: { type: String, default: "", maxlength: 100 },
          payoutAccount: { type: mongoose.Schema.Types.ObjectId, ref: "PayoutAccount" },
          // copied from the payout account, so the pay screen can show who is collecting
          collectorName: { type: String, default: "" },
          bankName: { type: String, default: "" },
          accountLast4: { type: String, default: "" },
        },
        { _id: false },
      ),
      default: () => ({}),
    },

    tableSettings: { type: TableSettingsSchema, default: () => ({}) },

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