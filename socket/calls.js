// socket/calls.js
//
// Voice and video calls between two friends, over the same socket as chat.
//
//   call:invite   { classId, kind }  caller  → rings the other person
//   call:accept   { callId }         callee  → answers
//   call:decline  { callId }         callee  → refuses
//   call:cancel   { callId }         caller  → hangs up before it was answered
//   call:end      { callId }         either  → hangs up
//
// The server sends back:
//   call:incoming { callId, classId, kind, from: { id, name } }
//   call:accepted { callId }
//   call:ended    { callId, reason }   reason: declined | cancelled | missed |
//                                      ended | answered_elsewhere | time_limit
//
// The audio and video themselves never touch this server: they go through
// Agora. This file only decides who may call whom, hands out the passes
// (tokens), and keeps the daily limit.

const mongoose = require('mongoose');

const Class      = require('../models/Class');
const Friendship = require('../models/Friendship');
const Call       = require('../models/Call');
const agora      = require('../utils/agora');
const { notifyIncomingCall, notifyMissedCall } = require('../utils/classPush');

const isId = mongoose.isValidObjectId;

// ── Limits (change on Render with environment variables) ─────────────────────
const RING_SECONDS       = 45;
const MAX_CALL_SECONDS   = (parseInt(process.env.CALL_MAX_MINUTES) || 45) * 60;
const DAILY_LIMIT_SEC    = (parseInt(process.env.CALL_DAILY_MINUTES) || 40) * 60;
// A video minute counts as this many minutes toward the daily limit
const VIDEO_WEIGHT       = 3;
const TOKEN_TTL_SECONDS  = MAX_CALL_SECONDS + 5 * 60;

// ── Tiny in-memory limiter: at most 6 call attempts a minute per student ─────
const attempts = new Map();
const allowAttempt = (userId) => {
  const now = Date.now();
  const recent = (attempts.get(userId) || []).filter((t) => now - t < 60 * 1000);
  if (recent.length >= 6) {
    attempts.set(userId, recent);
    return false;
  }
  recent.push(now);
  attempts.set(userId, recent);
  return true;
};
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) {
    if (!v.length || now - v[v.length - 1] > 60 * 1000) attempts.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ── Timers (ring timeout, maximum length) ────────────────────────────────────
const ringTimers = new Map(); // callId -> timeout
const maxTimers  = new Map();

const clearTimers = (callId) => {
  const id = String(callId);
  clearTimeout(ringTimers.get(id)); ringTimers.delete(id);
  clearTimeout(maxTimers.get(id));  maxTimers.delete(id);
};

// ── Daily usage ──────────────────────────────────────────────────────────────
const startOfToday = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** Seconds (weighted) this student has already spent on calls today. */
const usedToday = async (userId) => {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const rows = await Call.aggregate([
    {
      $match: {
        status:     'ended',
        answeredAt: { $gte: startOfToday() },
        $or: [{ caller: uid }, { callee: uid }],
      },
    },
    { $group: { _id: null, total: { $sum: '$weightedSeconds' } } },
  ]);
  return rows.length ? rows[0].total : 0;
};

const busy = (userId) => {
  const uid = new mongoose.Types.ObjectId(String(userId));
  return Call.exists({
    status: { $in: ['ringing', 'active'] },
    $or: [{ caller: uid }, { callee: uid }],
  });
};

// ── Module ───────────────────────────────────────────────────────────────────
/**
 * Ends calls that were left hanging (server restarted mid-call, etc.).
 * Call once at start-up. Also runs every 5 minutes.
 */
function startCallCleanup() {
  const sweep = async () => {
    try {
      await Call.updateMany(
        { status: 'ringing', createdAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } },
        { status: 'missed', endedAt: new Date() }
      );
      await Call.updateMany(
        {
          status: 'active',
          answeredAt: { $lt: new Date(Date.now() - (MAX_CALL_SECONDS + 5 * 60) * 1000) },
        },
        { status: 'ended', endedAt: new Date() }
      );
    } catch (err) {
      console.error('call cleanup failed:', err.message);
    }
  };
  sweep();
  setInterval(sweep, 5 * 60 * 1000).unref();
}

/** Registers the call events for one connected student. */
function registerCallHandlers({ io, socket, handle }) {
  const userId = socket.data.userId;
  const myName = socket.data.name;

  const toUser = (id, event, payload) => io.to(`user:${id}`).emit(event, payload);

  /** Moves a call from one of the allowed statuses to a new one. Returns the
   *  updated call, or null if it was already over (so nothing happens twice). */
  const finish = async (callId, fromStatuses, status, extra = {}) => {
    const now = new Date();
    const call = await Call.findOneAndUpdate(
      { _id: callId, status: { $in: fromStatuses } },
      { $set: { status, endedAt: now, ...extra } },
      { new: true }
    );
    if (call) clearTimers(call._id);
    return call;
  };

  /** Ends an active call and counts its time. */
  const endActive = async (callId, reason) => {
    const call = await Call.findOne({ _id: callId, status: 'active' });
    if (!call) return null;

    const seconds  = Math.max(0, Math.round((Date.now() - new Date(call.answeredAt).getTime()) / 1000));
    const weighted = seconds * (call.kind === 'video' ? VIDEO_WEIGHT : 1);

    const done = await finish(call._id, ['active'], 'ended', {
      durationSec: seconds,
      weightedSeconds: weighted,
    });
    if (done) {
      const payload = { callId: String(done._id), reason };
      toUser(done.caller, 'call:ended', payload);
      toUser(done.callee, 'call:ended', payload);
    }
    return done;
  };

  /** Nobody answered in time. */
  const markMissed = async (callId) => {
    const call = await finish(callId, ['ringing'], 'missed');
    if (!call) return;

    const payload = { callId: String(call._id), reason: 'missed' };
    toUser(call.caller, 'call:ended', payload);
    toUser(call.callee, 'call:ended', payload);

    notifyMissedCall({
      userId:     call.callee,
      callerName: await nameOf(call.caller),
      callId:     call._id,
      kind:       call.kind,
      classId:    call.class,
    });
  };

  const nameOf = async (id) => {
    if (String(id) === String(userId)) return myName;
    try {
      const sockets = await io.in(`user:${id}`).fetchSockets();
      if (sockets.length) return sockets[0].data.name;
    } catch (_) { /* fall through */ }
    const User = require('../models/User');
    const { displayName } = require('../utils/displayName');
    const u = await User.findById(id).select('profile.name username');
    return displayName(u, 'Someone');
  };

  // ── Start a call ───────────────────────────────────────────────────────────
  socket.on('call:invite', handle(async ({ classId, kind }, reply) => {
    if (!agora.isConfigured())        return reply({ ok: false, error: 'NOT_CONFIGURED' });
    if (!isId(classId))               return reply({ ok: false, error: 'INVALID' });
    if (kind !== 'voice' && kind !== 'video') return reply({ ok: false, error: 'INVALID' });
    if (!allowAttempt(userId))        return reply({ ok: false, error: 'RATE_LIMITED' });

    // Private chats only, and only between two people who are friends
    const cls = await Class.findById(classId).select('kind archived members');
    if (!cls || cls.kind !== 'dm')    return reply({ ok: false, error: 'NOT_ALLOWED' });
    if (cls.archived)                 return reply({ ok: false, error: 'NOT_ALLOWED' });

    const me    = cls.getMember(userId);
    const other = cls.members.find((m) => String(m.user) !== userId);
    if (!me || me.status !== 'active' || !other) return reply({ ok: false, error: 'NOT_ALLOWED' });

    const friends = await Friendship.exists({
      pair:   Friendship.pairKey(userId, other.user),
      status: 'accepted',
    });
    if (!friends)                     return reply({ ok: false, error: 'NOT_ALLOWED' });

    if (await busy(userId))           return reply({ ok: false, error: 'BUSY_SELF' });
    if (await busy(other.user))       return reply({ ok: false, error: 'BUSY' });

    if ((await usedToday(userId)) >= DAILY_LIMIT_SEC) {
      return reply({ ok: false, error: 'LIMIT_REACHED' });
    }

    const call = await Call.create({
      class:   cls._id,
      caller:  userId,
      callee:  other.user,
      kind,
      channel: `call_${new mongoose.Types.ObjectId()}`,
    });

    const calleeId = String(other.user);

    // Ring every open app of theirs. If none is in front, send a push.
    toUser(calleeId, 'call:incoming', {
      callId:  String(call._id),
      classId: String(cls._id),
      kind,
      from:    { id: userId, name: myName },
    });

    let reachable = false;
    try {
      const theirs = await io.in(`user:${calleeId}`).fetchSockets();
      reachable = theirs.some((s) => !s.data.away);
    } catch (_) { /* push instead */ }

    if (!reachable) {
      notifyIncomingCall({
        userId:     calleeId,
        callerName: myName,
        callId:     call._id,
        kind,
        classId:    cls._id,
      });
    }

    ringTimers.set(String(call._id), setTimeout(() => {
      markMissed(call._id).catch((e) => console.error('missed call failed:', e.message));
    }, RING_SECONDS * 1000));

    reply({
      ok:      true,
      callId:  String(call._id),
      kind,
      appId:   agora.appId(),
      channel: call.channel,
      uid:     agora.CALLER_UID,
      token:   agora.makeToken(call.channel, agora.CALLER_UID, TOKEN_TTL_SECONDS),
    });
  }));

  // ── Answer ─────────────────────────────────────────────────────────────────
  socket.on('call:accept', handle(async ({ callId }, reply) => {
    if (!isId(callId)) return reply({ ok: false, error: 'INVALID' });

    if ((await usedToday(userId)) >= DAILY_LIMIT_SEC) {
      return reply({ ok: false, error: 'LIMIT_REACHED' });
    }

    const call = await Call.findOneAndUpdate(
      { _id: callId, callee: userId, status: 'ringing' },
      { $set: { status: 'active', answeredAt: new Date() } },
      { new: true }
    );
    if (!call) return reply({ ok: false, error: 'CALL_ENDED' });

    clearTimeout(ringTimers.get(String(call._id)));
    ringTimers.delete(String(call._id));

    // A call can never run longer than the limit
    maxTimers.set(String(call._id), setTimeout(() => {
      endActive(call._id, 'time_limit').catch((e) => console.error('time limit failed:', e.message));
    }, MAX_CALL_SECONDS * 1000));

    toUser(call.caller, 'call:accepted', { callId: String(call._id) });
    // My other devices stop ringing
    socket.to(`user:${userId}`).emit('call:ended', {
      callId: String(call._id),
      reason: 'answered_elsewhere',
    });

    reply({
      ok:      true,
      callId:  String(call._id),
      classId: String(call.class),
      kind:    call.kind,
      appId:   agora.appId(),
      channel: call.channel,
      uid:     agora.CALLEE_UID,
      token:   agora.makeToken(call.channel, agora.CALLEE_UID, TOKEN_TTL_SECONDS),
    });
  }));

  // ── Refuse ─────────────────────────────────────────────────────────────────
  socket.on('call:decline', handle(async ({ callId }, reply) => {
    if (!isId(callId)) return reply({ ok: false, error: 'INVALID' });

    const call = await Call.findOne({ _id: callId, callee: userId, status: 'ringing' });
    if (!call) return reply({ ok: true }); // already over

    const done = await finish(call._id, ['ringing'], 'declined');
    if (done) {
      toUser(done.caller, 'call:ended', { callId: String(done._id), reason: 'declined' });
      socket.to(`user:${userId}`).emit('call:ended', {
        callId: String(done._id),
        reason: 'answered_elsewhere',
      });
    }
    reply({ ok: true });
  }));

  // ── Caller hangs up before it was answered ─────────────────────────────────
  socket.on('call:cancel', handle(async ({ callId }, reply) => {
    if (!isId(callId)) return reply({ ok: false, error: 'INVALID' });

    const call = await Call.findOne({ _id: callId, caller: userId, status: 'ringing' });
    if (!call) return reply({ ok: true });

    const done = await finish(call._id, ['ringing'], 'cancelled');
    if (done) {
      toUser(done.callee, 'call:ended', { callId: String(done._id), reason: 'cancelled' });
      notifyMissedCall({
        userId:     done.callee,
        callerName: myName,
        callId:     done._id,
        kind:       done.kind,
        classId:    done.class,
      });
    }
    reply({ ok: true });
  }));

  // ── Hang up ────────────────────────────────────────────────────────────────
  socket.on('call:end', handle(async ({ callId }, reply) => {
    if (!isId(callId)) return reply({ ok: false, error: 'INVALID' });

    const call = await Call.findOne({
      _id: callId,
      $or: [{ caller: userId }, { callee: userId }],
    });
    if (!call) return reply({ ok: true });

    if (call.status === 'active') {
      await endActive(call._id, 'ended');
    } else if (call.status === 'ringing') {
      // Hanging up while it still rings counts as cancelling or declining
      const mine = String(call.caller) === userId;
      const done = await finish(call._id, ['ringing'], mine ? 'cancelled' : 'declined');
      if (done) {
        toUser(mine ? done.callee : done.caller, 'call:ended', {
          callId: String(done._id),
          reason: mine ? 'cancelled' : 'declined',
        });
      }
    }
    reply({ ok: true });
  }));
}

module.exports = { registerCallHandlers, startCallCleanup, usedToday, DAILY_LIMIT_SEC };