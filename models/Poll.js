// models/Poll.js
//
// One engine for simple polls AND elections:
//   - a simple poll has ONE question ("Which day for the excursion?") with options
//   - an election (built later) has SEVERAL questions, one per position
//     (President, Secretary...), and the options are the candidates.

const mongoose = require('mongoose');
const crypto = require('crypto');

const { ObjectId } = mongoose.Schema.Types;

const OptionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true }, // "o1", "o2" ... (made by the server)
    label: { type: String, required: true, trim: true, maxlength: 200 },
    // used by elections later
    photoUrl: { type: String, default: '' },
    bio: { type: String, default: '', maxlength: 500 },
  },
  { _id: false },
);

const QuestionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true }, // "q1", "q2" ...
    title: { type: String, default: '', trim: true, maxlength: 300 },
    type: { type: String, enum: ['single', 'multiple'], default: 'single' },
    maxChoices: { type: Number, default: 1, min: 1, max: 20 },
    // elections: a voter may skip a position
    allowAbstain: { type: Boolean, default: false },
    options: { type: [OptionSchema], default: [] },
  },
  { _id: false },
);

const PollSchema = new mongoose.Schema(
  {
    owner: { type: ObjectId, ref: 'User', required: true, index: true },

    // Optional: share with a class. Members see it in their Polls.
    classId: { type: ObjectId, ref: 'Class', default: null, index: true },

    kind: { type: String, enum: ['poll', 'election'], default: 'poll' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 2000 },

    // Short random id used in the link: /p/<publicId>
    publicId: {
      type: String,
      unique: true,
      default: () => crypto.randomBytes(6).toString('base64url'),
    },

    questions: { type: [QuestionSchema], default: [] },

    // ── Who can vote ──
    requireAccount: { type: Boolean, default: false }, // SchoolLife account needed
    classOnly: { type: Boolean, default: false }, // only active members of classId
    requireCode: { type: Boolean, default: false }, // private: needs the code
    code: { type: String, default: '' }, // shown to the owner so they can share it

    // ── The ballot ──
    // true  = nobody can see who voted for what (default). Votes are final.
    // false = names are shown next to each person's choices.
    secretBallot: { type: Boolean, default: true },

    // live | afterVote | afterClose | private (only the creator)
    resultsVisibility: {
      type: String,
      enum: ['live', 'afterVote', 'afterClose', 'private'],
      default: 'afterVote',
    },

    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    closesAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    // Number of people who have voted (kept in step with the votes)
    voteCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Poll', PollSchema);