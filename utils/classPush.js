// utils/classPush.js
//
// Push notifications for the "Join a class" feature, sent through the same
// Firebase setup and FcmToken collection the rest of the app already uses.
//
// Rules:
//  - Chat messages: never push the sender, never push anyone who currently has
//    that class open (they already see the message live). Every message
//    reaches everyone else. Each class shows ONE notification in the tray
//    (a newer push replaces the older one), so a busy chat never piles up.
//  - Anonymous posts never produce a push. Only "a session was opened" does,
//    so nothing can hint at who wrote what.
//  - Every function here is safe to fire and forget: it never throws into the
//    caller, it only logs.

const Class    = require('../models/Class');
const FcmToken = require('../models/FcmToken');

// Uses the same Firebase startup as announcements (config/firebase.js).
const firebaseSetup = require('../config/firebase');

// 0 = no quiet gap: every message is pushed (a newer one replaces the old one)
const PUSH_GAP_MS = 0;
const BODY_MAX    = 110;

let ownApp = null;

function getMessaging() {
  try {
    // Normal path: the same startup announcements use
    if (typeof firebaseSetup.getFirebaseAdmin === 'function') {
      return firebaseSetup.getFirebaseAdmin().messaging();
    }

    // config/firebase.js has not been updated yet: start a separate, named
    // Firebase app from the same environment variables. A named app can never
    // clash with the one announcements start.
    console.warn('classPush: config/firebase.js does not export getFirebaseAdmin; using its own Firebase app.');
    const admin = require('firebase-admin');
    if (!ownApp) {
      ownApp = admin.initializeApp(
        {
          credential: admin.credential.cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          }),
        },
        'classPush'
      );
    }
    return ownApp.messaging();
  } catch (err) {
    console.error('classPush: Firebase could not start:', err.message);
    return null;
  }
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
  if (PUSH_GAP_MS <= 0) return true;
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
    // A phone that said "I'm away" (home pressed, app switched) does not
    // count as looking at the chat, even though its connection is still open.
    return new Set(
      sockets
        .filter((s) => s.data && !s.data.away && s.data.viewing === String(classId))
        .map((s) => s.data && s.data.userId)
        .filter(Boolean)
        .map(String)
    );
  } catch (_) {
    return new Set();
  }
}

/** Sends one notification to every device token the given users have saved. */
async function sendToUsers(userIds, { title, body, data, tag }) {
  if (!userIds || userIds.length === 0) return;

  const messaging = getMessaging();
  if (!messaging) {
    console.warn('classPush: NOT sending, Firebase Admin is not initialized.');
    return;
  }

  const docs = await FcmToken
    .find({ user: { $in: userIds }, enabled: { $ne: false } })
    .select('token')
    .lean();

  const tokens = [...new Set(docs.map((d) => d.token).filter(Boolean))];
  console.log(`classPush: "${title}" -> ${userIds.length} user(s), ${tokens.length} device token(s)`);
  if (!tokens.length) {
    console.warn('classPush: these users have NO saved device token, so nothing can be sent.');
  }

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);

    const message = {
      tokens: chunk,
      notification: { title, body },
      data: stringify(data),
      android: {
        priority: 'high',
        notification: {
          channelId: 'gradex_channel',   // created by the app, high importance
          icon:      'ic_notification',  // the white "SL" icon in the app
          color:     '#1565C0',
          ...(tag ? { tag } : {}),
        },
      },
    };
    if (tag) message.apns = { payload: { aps: { 'thread-id': tag } } };

    const result = typeof messaging.sendEachForMulticast === 'function'
      ? await messaging.sendEachForMulticast(message)
      : await messaging.sendMulticast(message);

    console.log(`classPush: sent ${result.successCount}, failed ${result.failureCount}`);
    result.responses.forEach((r) => {
      if (!r.success && r.error) console.warn('classPush: FCM error:', r.error.code);
    });

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
  { classId, senderId, senderName, text, mentionIds }
) => {
  const cls = await Class
    .findById(classId)
    .select('name kind archived members.user members.status')
    .lean();
  if (!cls || cls.archived) return;

  // A private chat looks like a message from a person: their name is the
  // title and the text is the body.
  if (cls.kind === 'dm') {
    const other = cls.members.find((m) => String(m.user) !== String(senderId));
    if (!other) return;
    const uid = String(other.user);
    if ((await onlineInRoom(io, classId)).has(uid)) return;

    await sendToUsers([uid], {
      title: senderName || 'New message',
      body:  shorten(text),
      tag:   `class:${classId}`,
      data:  { type: 'class_message', classId },
    });
    return;
  }

  const online    = await onlineInRoom(io, classId);
  console.log(`classPush: message in class ${classId}, people with the chat open: ${online.size}`);
  const now       = Date.now();
  const tagged    = new Set((mentionIds || []).map(String));
  const targets   = [];
  const taggedOut = [];

  for (const m of cls.members) {
    if (m.status !== 'active') continue;
    const uid = String(m.user);
    if (uid === String(senderId) || online.has(uid)) continue;

    // Someone who was @mentioned gets their own notification text.
    if (tagged.has(uid)) {
      taggedOut.push(uid);
      lastPush.set(`${classId}:${uid}`, now);
      continue;
    }
    if (!allowPush(classId, uid, now)) continue;
    targets.push(uid);
  }

  await sendToUsers(taggedOut, {
    title: cls.name,
    body:  `${senderName || 'Someone'} mentioned you: ${shorten(text)}`,
    tag:   `mention:${classId}`,
    data:  { type: 'class_message', classId },
  });

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

/** Someone sent me a friend request. */
const notifyFriendRequest = safe('notifyFriendRequest', async ({ userId, fromName, fromId }) => {
  await sendToUsers([String(userId)], {
    title: 'New friend request',
    body:  `${fromName || 'A student'} wants to be your friend.`,
    tag:   `friend:${fromId}`,
    data:  { type: 'friend_request', userId: String(fromId) },
  });
});

/** My friend request was accepted. */
const notifyFriendAccepted = safe('notifyFriendAccepted', async ({ userId, byName, classId }) => {
  await sendToUsers([String(userId)], {
    title: 'Friend request accepted',
    body:  `${byName || 'A student'} accepted your request. Say hi!`,
    tag:   `friend-ok:${classId}`,
    data:  { type: 'class_message', classId: String(classId) },
  });
});

module.exports = {
  notifyFriendRequest,
  notifyFriendAccepted,
  notifyClassMessage,
  notifyAnonOpened,
  notifyJoinRequest,
  notifyJoinApproved,
};