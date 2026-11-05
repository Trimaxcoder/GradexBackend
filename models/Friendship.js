// models/Friendship.js
//
// One document per pair of students. It is a request while 'pending', a
// friendship once 'accepted', and a block while 'blocked'. Declined and
// cancelled requests and unfriending delete the document.

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const FriendshipSchema = new mongoose.Schema(
  {
    // "<smaller id>:<bigger id>" — one document per pair, in either direction
    pair:      { type: String, required: true, unique: true },
    requester: { type: ObjectId, ref: 'User', required: true },
    recipient: { type: ObjectId, ref: 'User', required: true },
    status:    { type: String, enum: ['pending', 'accepted', 'blocked'], default: 'pending' },
    blockedBy: { type: ObjectId, ref: 'User', default: null },
    dmClass:   { type: ObjectId, ref: 'Class', default: null },
  },
  { timestamps: true }
);

FriendshipSchema.index({ requester: 1, status: 1 });
FriendshipSchema.index({ recipient: 1, status: 1 });

FriendshipSchema.statics.pairKey = function (a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? `${x}:${y}` : `${y}:${x}`;
};

/** The other person in this pair, from my point of view. */
FriendshipSchema.methods.otherOf = function (userId) {
  return String(this.requester) === String(userId) ? this.recipient : this.requester;
};

module.exports = mongoose.model('Friendship', FriendshipSchema);