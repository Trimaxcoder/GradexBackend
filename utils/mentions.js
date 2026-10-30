// utils/mentions.js
//
// Finds "@username" in a message and works out which class members it points
// to. Only ACTIVE members of that class can be mentioned, and only people who
// have set a username (a username is what you type after the @).

const mongoose = require('mongoose');
const User     = require('../models/User');
const Class    = require('../models/Class');

// "@name" must start the text or follow a space / punctuation, so an email
// address like a@b.com is not read as a mention.
const MENTION_RE = /(^|[^a-z0-9_.@])@([a-z0-9_.]{3,20})/gi;
const MAX_MENTIONS = 10;

function namesIn(text) {
  const found = new Set();
  const src = String(text || '');
  let match;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(src)) !== null) {
    // A full stop at the end is the end of a sentence, not part of the name
    const name = match[2].toLowerCase().replace(/\.+$/, '');
    if (name.length >= 3) found.add(name);
    if (found.size >= MAX_MENTIONS) break;
  }
  return [...found];
}

/**
 * Returns [{ user: ObjectId, username: String }] for the members mentioned in
 * [text]. The sender is left out (mentioning yourself notifies nobody).
 */
async function resolveMentions(classId, text, senderId) {
  const names = namesIn(text);
  if (!names.length) return [];

  const users = await User.find({ username: { $in: names } }).select('username').lean();
  if (!users.length) return [];

  const cls = await Class.findById(classId).select('members.user members.status').lean();
  if (!cls) return [];

  const active = new Set(
    cls.members.filter((m) => m.status === 'active').map((m) => String(m.user))
  );

  return users
    .filter((u) => active.has(String(u._id)) && String(u._id) !== String(senderId))
    .map((u) => ({ user: new mongoose.Types.ObjectId(u._id), username: u.username }));
}

module.exports = { resolveMentions, namesIn };