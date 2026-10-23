// utils/classPush.js
//
// Push notifications for the "Join a class" feature, sent through the same
// Firebase setup and FcmToken collection the rest of the app already uses.
//
// Rules:
//  - Chat messages: never push the sender, never push anyone who currently has
//    that class open (they already see the message live), and send each person
//    at most one push per class every PUSH_GAP_MS so a busy chat doesn't buzz
//    their phone all day. Each class shows ONE notification in the tray
//    (a newer push replaces the older one).
//  - Anonymous posts never produce a push. Only "a session was opened" does,
//    so nothing can hint at who wrote what.
//  - Every function here is safe to fire and forget: it never throws into the
//    caller, it only logs.

const Class    = require('../models/Class');
const FcmToken = require('../models/FcmToken');

let admin = null;
try {
  admin = require('firebase-admin');
} catch (_) {
  admin = null;
}

const PUSH_GAP_MS = 15 * 1000;
const BODY_MAX    = 110;

let warned = false;

function getMessaging() {
  if (!admin || !admin.apps || admin.apps.length === 0) {
    if (!warned) {
      warned = true;
      console.warn('classPush: Firebase Admin is not initialized, so class push notifications are off.');
    }
    return null;
  }
  return admin.messaging();
}

// ── Per (class, user) throttle ────────────────────────────────────────────────
// In memory, per server instance. Fine for one Render instance.
const lastPush = new Map();

const cleanup = setInterval(() => {
  const cutoff = Date.now() - PUSH_GAP_MS;
  for (const [key, at] of lastPush) {
    if (at < cutoff) lastPush.delete(key);
  }
}, 5 * 60 * 1000);
cleanup.unref();

function allowPush(classId, userId, now) {
  const key  = `${classId}:${userId}`;
  const last = lastPush.get(key);
  if (last && now - last < PUSH_GAP_MS) return false;
  lastPush.set(key, now);
  return true;
}

// ── Small helpers ─────────────────────────────────────────────────────────────
const shorten = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > BODY_MAX ? `${t.slice(0, BODY_MAX - 1)}…` : t;
};

// FCM data values must all be strings
const stringify = (data) => {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) out[k] = String(v);
  return out;
};

/** Ids of users who currently have this class open (joined its live room). */
async function onlineInRoom(io, classId) {
  if (!io) return new Set();
  try {
    const sockets = await io.in(`class:${classId}`).fetchSockets();
    return new Set(
      sockets.map((s) => s.data && s.data.userId).filter(Boolean).map(String)
    );
  } catch (_) {
    return new Set();
  }
}

/** Sends one notification to every device token the given users have saved. */
async function sendToUsers(userIds, { title, body, data, tag }) {
  if (!userIds || userIds.length === 0) return;

  const messaging = getMessaging();
  if (!messaging) return;

  const docs = await FcmToken
    .find({ user: { $in: userIds }, enabled: { $ne: false } })
    .select('token')
    .lean();

  const tokens = [...new Set(docs.map((d) => d.token).filter(Boolean))];

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);

    const message = {
      tokens: chunk,
      notification: { title, body },
      data: stringify(data),
      android: {
        priority: 'high',
        notification: tag ? { tag } : {},
      },
    };
    if (tag) message.apns = { payload: { aps: { 'thread-id': tag } } };

    const result = typeof messaging.sendEachForMulticast === 'function'
      ? await messaging.sendEachForMulticast(message)
      : await messaging.sendMulticast(message);

    // Forget tokens that Firebase says no longer exist (app uninstalled, etc.)
    const dead = [];
    result.responses.forEach((r, idx) => {
      const code = r.error && r.error.code;
      if (
        !r.success &&
        (code === 'messaging/registration-token-not-registered' ||
         code === 'messaging/invalid-registration-token')
      ) {
        dead.push(chunk[idx]);
      }
    });
    if (dead.length) await FcmToken.deleteMany({ token: { $in: dead } });
  }
}

// Wraps a function so a failure is logged and never reaches the caller
const safe = (name, fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    console.error(`classPush.${name} failed:`, err.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
//  PUBLIC
// ══════════════════════════════════════════════════════════════════════════════

/** A chat message was sent. */
const notifyClassMessage = safe('notifyClassMessage', async (
  io,
  { classId, senderId, senderName, text }
) => {
  const cls = await Class
    .findById(classId)
    .select('name archived members.user members.status')
    .lean();
  if (!cls || cls.archived) return;

  const online  = await onlineInRoom(io, classId);
  const now     = Date.now();
  const targets = [];

  for (const m of cls.members) {
    if (m.status !== 'active') continue;
    const uid = String(m.user);
    if (uid === String(senderId) || online.has(uid)) continue;
    if (!allowPush(classId, uid, now)) continue;
    targets.push(uid);
  }

  await sendToUsers(targets, {
    title: cls.name,
    body:  `${senderName || 'Someone'}: ${shorten(text)}`,
    tag:   `class:${classId}`,
    data:  { type: 'class_message', classId },
  });
});

/** An admin opened an anonymous session. Members not already in the class get a push. */
const notifyAnonOpened = safe('notifyAnonOpened', async (
  io,
  { classId, className, prompt, byUserId }
) => {
  const cls = await Class
    .findById(classId)
    .select('members.user members.status')
    .lean();
  if (!cls) return;

  const online  = await onlineInRoom(io, classId);
  const targets = cls.members
    .filter((m) => m.status === 'active')
    .map((m) => String(m.user))
    .filter((uid) => uid !== String(byUserId) && !online.has(uid));

  await sendToUsers(targets, {
    title: className,
    body:  prompt
      ? `Anonymous session: ${shorten(prompt)}`
      : 'An anonymous session is open. Tap to post without your name.',
    tag:   `anon:${classId}`,
    data:  { type: 'anon_opened', classId },
  });
});

/** Someone asked to join a class that needs approval. Tells the class admins. */
const notifyJoinRequest = safe('notifyJoinRequest', async ({
  classId,
  className,
  requesterName,
  adminIds,
}) => {
  await sendToUsers((adminIds || []).map(String), {
    title: className,
    body:  `${requesterName || 'A student'} asked to join your class.`,
    tag:   `join:${classId}`,
    data:  { type: 'class_join_request', classId },
  });
});

/** An admin approved a join request. Tells the student. */
const notifyJoinApproved = safe('notifyJoinApproved', async ({
  userId,
  classId,
  className,
}) => {
  await sendToUsers([String(userId)], {
    title: 'You are in!',
    body:  `An admin approved your request to join ${className}.`,
    tag:   `approved:${classId}`,
    data:  { type: 'class_approved', classId },
  });
});

module.exports = {
  notifyClassMessage,
  notifyAnonOpened,
  notifyJoinRequest,
  notifyJoinApproved,
};