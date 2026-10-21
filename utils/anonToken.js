const crypto = require('crypto');

let warned = false;

/**
 * Per-session anonymous token = HMAC-SHA256(secret, "<sessionId>:<userId>").
 *
 * - Same student + same session always gives the same token, so we can
 *   rate-limit and block without storing who the student is.
 * - A different session gives a different token, so tokens can't be linked
 *   across sessions.
 * - It is one-way: a leaked database alone cannot be reversed to user IDs.
 *   (Whoever holds the server secret AND the member list could still test
 *   guesses, which is why this is "anonymous to the class", not "untraceable
 *   by the app owner". Be honest about that in the app's wording.)
 */
module.exports = function anonToken(sessionId, userId) {
  const secret = process.env.ANON_SECRET || process.env.JWT_SECRET;
  if (!process.env.ANON_SECRET && !warned) {
    warned = true;
    console.warn('ANON_SECRET is not set. Falling back to JWT_SECRET. Set a separate ANON_SECRET in your environment.');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`${sessionId}:${userId}`)
    .digest('hex');
};