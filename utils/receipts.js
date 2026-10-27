// utils/receipts.js
//
// Delivery / read receipts for the class chat.
//
// Every class member has two bookmarks:
//   lastDelivered  the newest message that reached their app
//   lastRead       the newest message they have actually seen
//
// For a message I sent, the app shows:
//   one silver tick     sent, nobody else has received it yet
//   two silver ticks    at least one classmate's app has received it
//   two gold ticks      at least one classmate has seen it
//
// Message ids are ObjectIds, which are ordered by time, so "newest message
// seen" is enough to tell which messages count as seen.

const mongoose = require('mongoose');
const Class    = require('../models/Class');

const toId = (v) => new mongoose.Types.ObjectId(String(v));

/**
 * Moves the given fields forward (never backward) for these members.
 * Returns true if anything changed.
 */
async function advance(classId, userIds, fields, upToId) {
  if (!userIds.length) return false;

  const upTo = toId(upToId);
  const $max = {};
  for (const f of fields) $max[`members.$[m].${f}`] = upTo;

  const res = await Class.updateOne(
    { _id: classId },
    { $max },
    {
      timestamps:   false, // don't touch updatedAt on every receipt
      arrayFilters: [{ 'm.user': { $in: userIds.map(toId) }, 'm.status': 'active' }],
    }
  );
  return res.modifiedCount > 0;
}

/** These people's apps received messages up to upToId. */
async function markDelivered(io, classId, userIds, upToId) {
  try {
    const changed = await advance(classId, userIds, ['lastDelivered'], upToId);
    if (changed && io) {
      io.to(`class:${classId}`).emit('receipt:update', {
        classId: String(classId),
        kind:    'delivered',
        upToId:  String(upToId),
        userIds: userIds.map(String),
      });
    }
  } catch (err) {
    console.error('markDelivered failed:', err.message);
  }
}

/** This person has seen messages up to upToId (which also means delivered). */
async function markRead(io, classId, userId, upToId) {
  try {
    const changed = await advance(classId, [userId], ['lastRead', 'lastDelivered'], upToId);
    if (changed && io) {
      io.to(`class:${classId}`).emit('receipt:update', {
        classId: String(classId),
        kind:    'read',
        upToId:  String(upToId),
        userIds: [String(userId)],
      });
    }
  } catch (err) {
    console.error('markRead failed:', err.message);
  }
}

/**
 * The newest message any OTHER member has received / read, from the point of
 * view of `userId`. The app compares its own messages against these.
 */
function receiptsFor(cls, userId) {
  const me = String(userId);
  let delivered = '';
  let read      = '';

  for (const m of cls.members) {
    if (m.status !== 'active' || String(m.user) === me) continue;
    if (m.lastRead      && String(m.lastRead)      > read)      read      = String(m.lastRead);
    if (m.lastDelivered && String(m.lastDelivered) > delivered) delivered = String(m.lastDelivered);
  }

  // Seeing a message means it was delivered
  if (read > delivered) delivered = read;

  return { delivered: delivered || null, read: read || null };
}

module.exports = { markDelivered, markRead, receiptsFor };