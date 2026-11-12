const mongoose = require("mongoose");
const crypto = require("crypto");

const AnswerSchema = new mongoose.Schema(
  {
    fieldId: { type: String, required: true },
    // string, number, or array of strings (for checkbox fields)
    value: { type: mongoose.Schema.Types.Mixed, default: "" },
    // true when the answer was pulled from the student's profile
    fromProfile: { type: Boolean, default: false },
  },
  { _id: false },
);

const FormSubmissionSchema = new mongoose.Schema(
  {
    form: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Form",
      required: true,
      index: true,
    },
    // null when the person filled the form without an account
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // Anonymous people edit with a secret token. Only the hash is stored.
    editTokenHash: { type: String, select: false },

    answers: { type: [AnswerSchema], default: [] },
  },
  { timestamps: true },
);

// A logged-in user can only have one submission per form
FormSubmissionSchema.index(
  { form: 1, user: 1 },
  { unique: true, partialFilterExpression: { user: { $type: "objectId" } } },
);

FormSubmissionSchema.statics.hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

FormSubmissionSchema.statics.newToken = () =>
  crypto.randomBytes(24).toString("base64url");

module.exports = mongoose.model("FormSubmission", FormSubmissionSchema);