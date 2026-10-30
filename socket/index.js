const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const mongoose   = require('mongoose');

const User         = require('../models/User');
const Class        = require('../models/Class');
const ClassMessage = require('../models/ClassMessage');
const AnonSession  = require('../models/AnonSession');
const AnonPost     = require('../models/AnonPost');
const anonToken    = require('../utils/anonToken');
const { notifyClassMessage } = require('../utils/classPush');
const { cleanAttachment, attachmentLabel, destroyAsset } = require('../utils/cloudinary');
const { markDelivered, markRead } = require('../utils/receipts');
const { displayName } = require('../utils/displayName');

const isId = mongoose.isValidObjectId;

// ── Tiny in-memory rate limiter (per server instance) ─────────────────────────
// If you ever run more than one instance, swap this for a Redis-backed limiter.
const createLimiter = (max, windowMs) => {
  const hits = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) {
      if (!times.length || now - times[times.length - 1] > windowMs) hits.delete(key);
    }
  }, 5 * 60 * 1000);
  cleanup.unref();

  return (key) => {
    const now    = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
};

const chatLimiter = createLimiter(10, 10 * 1000); // 10 chat messages / 10 s
const anonLimiter = createLimiter(10, 60 * 1000); // 10 anon posts / minute / user
const readLimiter = createLimiter(30, 10 * 1000); // 30 "I've read up to here" / 10 s

// ── Membership lookup (loads only this user's member entry) ───────────────────
async function loadMembership(classId, userId) {
  if (!isId(classId)) return null;
  const uid = new mongoose.Types.ObjectId(userId);

  const cls = await Class.findOne(
    { _id: classId, 'members.user': uid },
    { chatLocked: 1, archived: 1, members: { $elemMatch: { user: uid } } }
  );

  const member = cls && cls.members[0];
  if (!member || member.status !== 'active') return null;
  return { cls, member };
}

// ── Wrap handlers so errors always produce an ack instead of crashing ─────────
const handle = (fn) => async (data, cb) => {
  const reply = typeof cb === 'function' ? cb : () => {};
  try {
    await fn(data || {}, reply);
  } catch (err) {
    // Deliberately logs only the message, never user IDs (anon posts live here too)
    console.error('Socket handler error:', err.message);
    reply({ ok: false, error: 'SERVER_ERROR' });
  }
};

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || '*' },
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e5, // 100 KB, plenty for text
  });

  // ── Auth: same JWT as the REST API ──────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('AUTH_REQUIRED'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('profile.name username');
      if (!user) return next(new Error('AUTH_INVALID'));

      socket.data.userId = String(user._id);
      socket.data.name   = displayName(user);
      next();
    } catch (err) {
      next(new Error(err.name === 'TokenExpiredError' ? 'AUTH_EXPIRED' : 'AUTH_INVALID'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, name } = socket.data;

    // Personal room: used for "you were approved / removed" style events
    socket.join(`user:${userId}`);

    // ── Join / leave a class room ─────────────────────────────────────────────
    socket.on('class:join', handle(async ({ classId }, reply) => {
      const m = await loadMembership(classId, userId);
      if (!m) return reply({ ok: false, error: 'NOT_A_MEMBER' });
      socket.join(`class:${classId}`);
      reply({ ok: true });
    }));

    socket.on('class:leave', handle(async ({ classId }, reply) => {
      socket.leave(`class:${classId}`);
      reply({ ok: true });
    }));

    // ── Send a chat message ───────────────────────────────────────────────────
    socket.on('message:send', handle(async ({ classId, text, replyTo, clientId, attachment }, reply) => {
      const clean = typeof text === 'string' ? text.trim() : '';

      // A message is text, an attachment (photo / file / voice note), or both
      let att = null;
      if (attachment) {
        att = cleanAttachment(attachment, classId);
        if (!att) return reply({ ok: false, error: 'INVALID_ATTACHMENT' });
      }

      if ((!clean && !att) || clean.length > 2000) return reply({ ok: false, error: 'INVALID_TEXT' });
      if (!chatLimiter(userId))                    return reply({ ok: false, error: 'RATE_LIMITED' });

      const m = await loadMembership(classId, userId);
      if (!m)                                   return reply({ ok: false, error: 'NOT_A_MEMBER' });
      if (m.cls.archived)                       return reply({ ok: false, error: 'CLASS_ARCHIVED' });
      if (m.member.muted)                       return reply({ ok: false, error: 'MUTED' });
      if (m.cls.chatLocked && m.member.role !== 'admin') {
        return reply({ ok: false, error: 'CHAT_LOCKED' });
      }

      let replyId = null;
      if (replyTo && isId(replyTo)) {
        const parent = await ClassMessage.exists({ _id: replyTo, class: classId });
        if (parent) replyId = replyTo;
      }

      const msg = await ClassMessage.create({
        class:   classId,
        sender:  userId,
        text:    clean,
        attachment: att,
        replyTo: replyId,
      });
      await msg.populate(ClassMessage.POPULATE);

      const payload = msg.toClient();
      // clientId lets the sender match this to its optimistic "sending..." bubble
      io.to(`class:${classId}`).emit('message:new', { ...payload, clientId: clientId || null });
      reply({ ok: true, message: payload });

      // Everyone else who has this class open has now received it
      (async () => {
        try {
          const live = await io.in(`class:${classId}`).fetchSockets();
          const ids  = [...new Set(live.map((s) => s.data.userId))].filter((id) => id !== userId);
          await markDelivered(io, classId, ids, msg._id);
        } catch (err) {
          console.error('delivery receipts failed:', err.message);
        }
      })();

      // Tell every member's app so the class list can show the last message
      // and the unread count without opening the class.
      (async () => {
        try {
          const cls = await Class.findById(classId).select('members.user members.status');
          if (!cls) return;
          const rooms = cls.members
            .filter((x) => x.status === 'active')
            .map((x) => `user:${x.user}`);
          if (!rooms.length) return;

          io.to(rooms).emit('class:activity', {
            classId,
            lastMessage: {
              id:         String(msg._id),
              text:       (clean || attachmentLabel(att)).replace(/\s+/g, ' ').slice(0, 120),
              senderId:   userId,
              senderName: displayName(msg.sender),
              createdAt:  msg.createdAt,
              deleted:    false,
            },
          });
        } catch (err) {
          console.error('class activity failed:', err.message);
        }
      })();

      // Push to members who don't have this class open right now.
      // Not awaited: the sender never waits for it, and it never throws.
      notifyClassMessage(io, {
        classId,
        senderId:   userId,
        senderName: displayName(msg.sender),
        text:       clean || attachmentLabel(att),
      });
    }));

    // ── "I have read up to this message" ──────────────────────────────────────
    socket.on('message:read', handle(async ({ classId, upToId }, reply) => {
      if (!isId(classId) || !isId(upToId)) return reply({ ok: false, error: 'INVALID' });
      if (!readLimiter(userId))            return reply({ ok: false, error: 'RATE_LIMITED' });
      if (!socket.rooms.has(`class:${classId}`)) return reply({ ok: false, error: 'NOT_IN_ROOM' });

      // Only real messages of this class count (stops made-up future ids)
      const exists = await ClassMessage.exists({ _id: upToId, class: classId });
      if (!exists) return reply({ ok: false, error: 'NOT_FOUND' });

      await markRead(io, classId, userId, upToId);
      reply({ ok: true });
    }));

    // ── Delete a message (own message, or any message if class admin) ─────────
    socket.on('message:delete', handle(async ({ messageId }, reply) => {
      if (!isId(messageId)) return reply({ ok: false, error: 'INVALID' });

      const msg = await ClassMessage.findById(messageId);
      if (!msg || msg.deleted) return reply({ ok: false, error: 'NOT_FOUND' });

      const m = await loadMembership(String(msg.class), userId);
      if (!m) return reply({ ok: false, error: 'NOT_A_MEMBER' });

      const isOwn = String(msg.sender) === userId;
      if (!isOwn && m.member.role !== 'admin') return reply({ ok: false, error: 'FORBIDDEN' });

      const oldFileUrl = msg.attachment && msg.attachment.url;

      msg.deleted    = true;
      msg.text       = '';
      msg.attachment = null;
      msg.pinned     = false;
      await msg.save();

      // Remove the file from Cloudinary too (best effort, not awaited)
      if (oldFileUrl) destroyAsset(oldFileUrl);

      io.to(`class:${msg.class}`).emit('message:deleted', {
        id:      String(msg._id),
        classId: String(msg.class),
      });
      reply({ ok: true });
    }));

    // ── Typing indicator (chat only, never used in anonymous sessions) ────────
    socket.on('typing', handle(async ({ classId, isTyping }) => {
      if (!socket.rooms.has(`class:${classId}`)) return;
      socket.to(`class:${classId}`).emit('typing', {
        classId,
        userId,
        name,
        isTyping: !!isTyping,
      });
    }));

    // ── Anonymous post ────────────────────────────────────────────────────────
    // The broadcast and the saved document contain NO author information.
    socket.on('anon:send', handle(async ({ classId, sessionId, text }, reply) => {
      const clean = typeof text === 'string' ? text.trim() : '';
      if (!clean || clean.length > 1000) return reply({ ok: false, error: 'INVALID_TEXT' });
      if (!isId(sessionId))              return reply({ ok: false, error: 'INVALID_SESSION' });
      if (!anonLimiter(userId))          return reply({ ok: false, error: 'RATE_LIMITED' });

      const m = await loadMembership(classId, userId);
      if (!m) return reply({ ok: false, error: 'NOT_A_MEMBER' });

      const session = await AnonSession.findOne({
        _id:    sessionId,
        class:  classId,
        status: 'open',
      }).select('+blockedTokens');
      if (!session) return reply({ ok: false, error: 'SESSION_CLOSED' });

      const token = anonToken(sessionId, userId);
      if (session.blockedTokens.includes(token)) {
        return reply({ ok: false, error: 'BLOCKED' });
      }

      // Per-token limit: 5 posts a minute inside one session
      const recent = await AnonPost.countDocuments({
        session:   sessionId,
        tokenHash: token,
        createdAt: { $gte: new Date(Date.now() - 60 * 1000) },
      });
      if (recent >= 5) return reply({ ok: false, error: 'RATE_LIMITED' });

      const post = await AnonPost.create({
        session:   sessionId,
        class:     classId,
        text:      clean,
        tokenHash: token,
      });
      await AnonSession.updateOne({ _id: sessionId }, { $inc: { postCount: 1 } });

      io.to(`class:${classId}`).emit('anon:new', post.toClient());
      reply({ ok: true });
    }));
  });

  return io;
}

module.exports = { initSocket };