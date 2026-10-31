// Message reactions: one emoji per person per message.
//
// The emoji are written as escapes so the server and the app always agree on
// the exact characters (the heart carries an invisible "variation selector").

const REACTIONS = [
  '\u{1F44D}',   // thumbs up
  '❤️', // red heart
  '\u{1F602}',   // laughing
  '\u{1F62E}',   // surprised
  '\u{1F622}',   // sad
  '\u{1F64F}',   // thanks
];

// [{ user, emoji }, ...]  →  { "👍": ["userId", ...], "❤️": [...] }
const groupReactions = (list) => {
  const out = {};
  for (const r of list || []) {
    if (!r || !r.emoji) continue;
    (out[r.emoji] = out[r.emoji] || []).push(String(r.user));
  }
  return out;
};

module.exports = { REACTIONS, groupReactions };