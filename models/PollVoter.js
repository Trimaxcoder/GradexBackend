// models/PollVoter.js
//
// "This person has voted in this poll." It is what stops double voting.
//
// It is deliberately SEPARATE from PollVote (what was chosen), and has no id
// that links to it. In a secret ballot that means nobody, not even someone
// looking at the database, can tell who voted for what.
//
// voterKey is:
//   u:<userId>                      a SchoolLife account
//   d:<hash of device id + poll>    a guest on a public or private poll

const mongoose = require('mongoose');

const PollVoterSchema = new mongoose.Schema(
  {
    poll: { type: mongoose.Schema.Types.ObjectId, ref: 'Poll', required: true },
    voterKey: { type: String, required: true },
    votedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

// One vote per person per poll: the database itself refuses a second one
PollVoterSchema.index({ poll: 1, voterKey: 1 }, { unique: true });

// For "polls I voted in"
PollVoterSchema.index({ voterKey: 1, votedAt: -1 });

module.exports = mongoose.model('PollVoter', PollVoterSchema);