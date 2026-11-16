// models/PollVote.js
//
// What was chosen. In a SECRET ballot (the default) this record holds NO
// information about the voter: no user, no name, no exact time (only the day).
// Only when the creator turns secrecy off (a public vote) are the voter's name
// and exact time stored here.

const mongoose = require('mongoose');

const AnswerSchema = new mongoose.Schema(
  {
    questionId: { type: String, required: true },
    optionIds: { type: [String], default: [] },
  },
  { _id: false },
);

const PollVoteSchema = new mongoose.Schema(
  {
    poll: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Poll',
      required: true,
      index: true,
    },
    answers: { type: [AnswerSchema], default: [] },

    // Start of the day (UTC). Kept instead of the exact time, so in a secret
    // ballot nobody can match a vote to the moment someone voted.
    day: { type: Date, required: true },

    // ONLY for public votes (creator turned secrecy off):
    voterName: { type: String, default: '' },
    at: { type: Date, default: null },
  },
  { versionKey: false },
);

module.exports = mongoose.model('PollVote', PollVoteSchema);