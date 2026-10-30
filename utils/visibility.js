// What a member can see of a class's history.
//
// Each member has two private settings:
//   clearedAt       set when they tap "Clear chat". Older messages are hidden.
//   disappearAfter  seconds (0 = off). Messages older than this are hidden.
//
// Nothing is deleted from the database because of one member's settings: the
// other members still see those messages. The retention job (retention.js)
// deletes a message only once EVERY active member has hidden it.

const DISAPPEAR_CHOICES = [0, 24 * 3600, 7 * 24 * 3600, 90 * 24 * 3600];

// Messages created at or before this moment are hidden from the member.
// Returns null when the member hides nothing.
const hideBeforeOf = (member, now = Date.now()) => {
  if (!member) return null;

  let t = 0;
  if (member.clearedAt) t = new Date(member.clearedAt).getTime();

  const after = Number(member.disappearAfter) || 0;
  if (after > 0) t = Math.max(t, now - after * 1000);

  return t > 0 ? new Date(t) : null;
};

module.exports = { DISAPPEAR_CHOICES, hideBeforeOf };