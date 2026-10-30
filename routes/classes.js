const express   = require('express');
const mongoose  = require('mongoose');
const rateLimit = require('express-rate-limit');

const { protect }  = require('../middleware/auth');
const User         = require('../models/User');
const Class        = require('../models/Class');
const ClassMessage = require('../models/ClassMessage');
const AnonSession  = require('../models/AnonSession');
const AnonPost     = require('../models/AnonPost');
const {
  notifyAnonOpened,
  notifyJoinRequest,
  notifyJoinApproved,
} = require('../utils/classPush');
const { isConfigured, signUpload } = require('../utils/cloudinary');
const { markDelivered, receiptsFor } = require('../utils/receipts');
const { displayName } = require('../utils/displayName');

const router = express.Router();
router.use(protect);

const MAX_MEMBERS       = 1000;
const MAX_OWNED_CLASSES = 10;

const isId = mongoose.isValidObjectId;
const oid  = (v) => new mongoose.Types.ObjectId(String(v));

// ── Small helpers ─────────────────────────────────────────────────────────────
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message });

const emitToClass = (req, classId, event, payload) => {
  const io = req.app.get('io');
  if (io) io.to(`class:${classId}`).emit(event, payload);
};

const emitToUser = (req, userId, event, payload) => {
  const io = req.app.get('io');
  if (io) io.to(`user:${userId}`).emit(event, payload);
};

// Set APP_LINK_BASE to an https link (e.g. https://schoollife.web.app/join)
// so the link is tappable in WhatsApp. Custom schemes are not linkified there.
const inviteLink = (code) =>
  `${process.env.APP_LINK_BASE || 'schoollife://join'}/${code}`;

const activeCount = (cls) => cls.members.filter((m) => m.status === 'active').length;

const classSummary = (cls, userId) => {
  const me = cls.getMember(userId);
  const out = {
    id:              String(cls._id),
    name:            cls.name,
    description:     cls.description,
    requireApproval: cls.requireApproval,
    chatLocked:      cls.chatLocked,
    archived:        cls.archived,
    memberCount:     activeCount(cls),
    myRole:          me ? me.role : null,
    myStatus:        me ? me.status : null,
    isOwner:         String(cls.owner) === String(userId),
    createdAt:       cls.createdAt,
  };
  // Active members can share the code; pending members can't see it
  if (me && me.status === 'active') {
    out.joinCode   = cls.joinCode;
    out.inviteLink = inviteLink(cls.joinCode);
  }
  return out;
};

// ── Middleware: load class + the caller's membership ──────────────────────────
const loadClass = wrap(async (req, res, next) => {
  if (!isId(req.params.id)) return fail(res, 400, 'Invalid class id.');
  const cls = await Class.findById(req.params.id);
  if (!cls) return fail(res, 404, 'Class not found.');
  req.cls    = cls;
  req.member = cls.getMember(req.user._id);
  next();
});

const requireMember = (req, res, next) => {
  if (!req.member || req.member.status !== 'active') {
    return fail(res, 403, 'You are not a member of this class.');
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.member || req.member.status !== 'active' || req.member.role !== 'admin') {
    return fail(res, 403, 'Only class admins can do this.');
  }
  next();
};

const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many join attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 30 upload permissions per 10 minutes per student
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.user && req.user._id),
  validate: false,
  message: { success: false, message: 'Too many uploads. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ══════════════════════════════════════════════════════════════════════════════
//  CLASSES
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/classes  → create a class (creator becomes owner + admin)
router.post('/', wrap(async (req, res) => {
  const name        = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();

  if (name.length < 2 || name.length > 80) {
    return fail(res, 400, 'Class name must be 2 to 80 characters.');
  }
  if (description.length > 500) {
    return fail(res, 400, 'Description can be at most 500 characters.');
  }

  const owned = await Class.countDocuments({ owner: req.user._id, archived: false });
  if (owned >= MAX_OWNED_CLASSES) {
    return fail(res, 400, `You can own up to ${MAX_OWNED_CLASSES} active classes.`);
  }

  const cls = await Class.create({
    name,
    description,
    owner:           req.user._id,
    joinCode:        await Class.generateUniqueCode(),
    requireApproval: !!req.body.requireApproval,
    members: [{ user: req.user._id, role: 'admin', status: 'active' }],
  });

  res.status(201).json({ success: true, class: classSummary(cls, req.user._id) });
}));

// GET /api/classes  → classes I'm in (including ones awaiting approval)
router.get('/', wrap(async (req, res) => {
  const classes = await Class.find({
    'members.user': req.user._id,
    archived: false,
  }).sort({ updatedAt: -1 });

  res.json({
    success: true,
    classes: classes.map((c) => classSummary(c, req.user._id)),
  });
}));

// POST /api/classes/join  → join with a code (also used by the invite link)
router.post('/join', joinLimiter, wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return fail(res, 400, 'Enter a valid 6-character class code.');
  }

  const uid = req.user._id;
  const cls = await Class.findOne({ joinCode: code, archived: false });
  if (!cls) return fail(res, 404, 'No class found with that code.');

  const existing = cls.getMember(uid);
  if (existing) {
    return res.json({
      success: true,
      status:  existing.status,
      class:   classSummary(cls, uid),
    });
  }

  if (activeCount(cls) >= MAX_MEMBERS) return fail(res, 400, 'This class is full.');

  const status = cls.requireApproval ? 'pending' : 'active';

  // Atomic: the $ne guard stops a double-tap from adding the user twice
  await Class.updateOne(
    { _id: cls._id, 'members.user': { $ne: uid } },
    {
      $push: {
        members: { user: uid, role: 'member', status, muted: false, joinedAt: new Date() },
      },
    }
  );

  const fresh = await Class.findById(cls._id);
  const name  = displayName(req.user, 'A student');
  const payload = { classId: String(cls._id), user: { id: String(uid), name } };

  if (status === 'active') {
    emitToClass(req, cls._id, 'member:joined', payload);
  } else {
    const admins = fresh.members.filter((m) => m.role === 'admin' && m.status === 'active');
    admins.forEach((m) => emitToUser(req, m.user, 'member:pending', payload));

    notifyJoinRequest({
      classId:       cls._id,
      className:     cls.name,
      requesterName: name,
      adminIds:      admins.map((m) => m.user),
    });
  }

  res.status(201).json({ success: true, status, class: classSummary(fresh, uid) });
}));

// GET /api/classes/:id  → class details + open anon session + pinned messages
router.get('/:id', loadClass, requireMember, wrap(async (req, res) => {
  const { cls } = req;

  const [open, pinned] = await Promise.all([
    AnonSession.findOne({ class: cls._id, status: 'open' }),
    ClassMessage.find({ class: cls._id, pinned: true, deleted: false })
      .sort({ _id: -1 })
      .limit(3)
      .populate(ClassMessage.POPULATE),
  ]);

  res.json({
    success: true,
    class: classSummary(cls, req.user._id),
    activeAnonSession: open ? open.toClient() : null,
    pinned: pinned.map((m) => m.toClient()),
    receipts: receiptsFor(cls, req.user._id),
  });
}));

// GET /api/classes/:id/info  → everything the class info screen shows
router.get('/:id/info', loadClass, requireMember, wrap(async (req, res) => {
  const { cls } = req;

  const adminMembers = cls.members.filter((m) => m.status === 'active' && m.role === 'admin');
  const ownerId      = String(cls.owner);
  const adminIds     = adminMembers.map((m) => String(m.user));

  const people = await User.find({ _id: { $in: [...new Set([ownerId, ...adminIds])] } })
    .select('profile.name username');
  const byId = new Map(people.map((u) => [String(u._id), u]));

  // Photos, files and voice notes that have not been deleted
  const mediaMatch = {
    class:            cls._id,
    deleted:          false,
    'attachment.url': { $exists: true, $ne: '' },
  };

  const [counts, recentImages, recentFiles, pinnedCount] = await Promise.all([
    ClassMessage.aggregate([
      { $match: mediaMatch },
      { $group: { _id: '$attachment.kind', n: { $sum: 1 } } },
    ]),
    ClassMessage.find({ ...mediaMatch, 'attachment.kind': 'image' })
      .sort({ _id: -1 })
      .limit(8)
      .select('attachment'),
    ClassMessage.find({ ...mediaMatch, 'attachment.kind': 'file' })
      .sort({ _id: -1 })
      .limit(5)
      .select('attachment'),
    ClassMessage.countDocuments({ class: cls._id, pinned: true, deleted: false }),
  ]);

  const countOf = (kind) => {
    const row = counts.find((c) => c._id === kind);
    return row ? row.n : 0;
  };

  res.json({
    success: true,
    info: {
      createdAt: cls.createdAt,
      createdBy: {
        id:   ownerId,
        name: displayName(byId.get(ownerId), 'Former member'),
      },
      admins: adminIds.map((id) => ({
        userId:  id,
        name:    displayName(byId.get(id)),
        isOwner: id === ownerId,
      })),
      myJoinedAt: req.member.joinedAt,
      pinnedCount,
      media: {
        images: countOf('image'),
        files:  countOf('file'),
        audio:  countOf('audio'),
        recentImages: recentImages.map((m) => ({
          id:  String(m._id),
          url: m.attachment.url,
        })),
        recentFiles: recentFiles.map((m) => ({
          id:   String(m._id),
          name: m.attachment.name,
          url:  m.attachment.url,
          size: m.attachment.size,
          mime: m.attachment.mime,
        })),
      },
    },
  });
}));

// PUT /api/classes/:id  → admin edits class settings
router.put('/:id', loadClass, requireAdmin, wrap(async (req, res) => {
  const { cls } = req;
  if (cls.archived) return fail(res, 400, 'This class is archived.');

  const { name, description, requireApproval, chatLocked } = req.body;

  if (name !== undefined) {
    const n = String(name).trim();
    if (n.length < 2 || n.length > 80) return fail(res, 400, 'Class name must be 2 to 80 characters.');
    cls.name = n;
  }
  if (description !== undefined) {
    const d = String(description).trim();
    if (d.length > 500) return fail(res, 400, 'Description can be at most 500 characters.');
    cls.description = d;
  }
  if (requireApproval !== undefined) cls.requireApproval = !!requireApproval;
  if (chatLocked !== undefined)      cls.chatLocked      = !!chatLocked;

  await cls.save();

  emitToClass(req, cls._id, 'class:updated', {
    classId:         String(cls._id),
    name:            cls.name,
    description:     cls.description,
    requireApproval: cls.requireApproval,
    chatLocked:      cls.chatLocked,
  });

  res.json({ success: true, class: classSummary(cls, req.user._id) });
}));

// POST /api/classes/:id/regenerate-code  → invalidate the old code and link
router.post('/:id/regenerate-code', loadClass, requireAdmin, wrap(async (req, res) => {
  const { cls } = req;
  cls.joinCode = await Class.generateUniqueCode();
  await cls.save();
  res.json({ success: true, joinCode: cls.joinCode, inviteLink: inviteLink(cls.joinCode) });
}));

// POST /api/classes/:id/archive  → owner only, closes the class for everyone
router.post('/:id/archive', loadClass, wrap(async (req, res) => {
  const { cls } = req;
  if (String(cls.owner) !== String(req.user._id)) {
    return fail(res, 403, 'Only the class owner can archive it.');
  }

  cls.archived = true;
  await cls.save();
  await AnonSession.updateMany(
    { class: cls._id, status: 'open' },
    { status: 'closed', closedAt: new Date() }
  );

  emitToClass(req, cls._id, 'class:archived', { classId: String(cls._id) });
  res.json({ success: true });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  MEMBERS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/classes/:id/members  (admins also see people awaiting approval)
router.get('/:id/members', loadClass, requireMember, wrap(async (req, res) => {
  const { cls } = req;
  const iAmAdmin = req.member.role === 'admin';

  const visible = cls.members.filter(
    (m) => m.status === 'active' || (iAmAdmin && m.status === 'pending')
  );

  const users = await User.find({ _id: { $in: visible.map((m) => m.user) } })
    .select('profile.name username profile.department profile.level');
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const members = visible.map((m) => {
    const u = byId.get(String(m.user));
    const p = (u && u.profile) || {};
    return {
      userId:     String(m.user),
      name:       displayName(u),
      department: p.department || '',
      level:      p.level || '',
      role:       m.role,
      status:     m.status,
      muted:      m.muted,
      isOwner:    String(m.user) === String(cls.owner),
      joinedAt:   m.joinedAt,
    };
  });

  const rank = (m) => (m.isOwner ? 0 : m.role === 'admin' ? 1 : m.status === 'pending' ? 2 : 3);
  members.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  res.json({ success: true, members });
}));

// PUT /api/classes/:id/members/:userId   body: { action }
// actions: approve | promote | demote | mute | unmute
router.put('/:id/members/:userId', loadClass, requireAdmin, wrap(async (req, res) => {
  const { cls } = req;
  const targetId = req.params.userId;
  const target   = isId(targetId) ? cls.getMember(targetId) : null;
  if (!target) return fail(res, 404, 'Member not found.');

  const iAmOwner      = String(cls.owner) === String(req.user._id);
  const isOwnerTarget = String(cls.owner) === String(targetId);
  const action        = req.body.action;
  let update;

  switch (action) {
    case 'approve':
      if (target.status !== 'pending') return fail(res, 400, 'This member is not waiting for approval.');
      if (activeCount(cls) >= MAX_MEMBERS) return fail(res, 400, 'This class is full.');
      update = { 'members.$.status': 'active' };
      break;
    case 'promote':
      if (target.status !== 'active') return fail(res, 400, 'Only active members can be promoted.');
      update = { 'members.$.role': 'admin' };
      break;
    case 'demote':
      if (!iAmOwner)      return fail(res, 403, 'Only the class owner can remove admin rights.');
      if (isOwnerTarget)  return fail(res, 400, 'The owner always stays an admin.');
      update = { 'members.$.role': 'member' };
      break;
    case 'mute':
    case 'unmute':
      if (target.role === 'admin') return fail(res, 400, 'Admins cannot be muted.');
      update = { 'members.$.muted': action === 'mute' };
      break;
    default:
      return fail(res, 400, 'Unknown action.');
  }

  // Positional update is atomic and safe even if someone joins or leaves at the same time
  await Class.updateOne({ _id: cls._id, 'members.user': oid(targetId) }, { $set: update });

  if (action === 'approve') {
    const u = await User.findById(targetId).select('profile.name username');
    emitToUser(req, targetId, 'class:approved', { classId: String(cls._id) });
    emitToClass(req, cls._id, 'member:joined', {
      classId: String(cls._id),
      user: { id: String(targetId), name: displayName(u) },
    });
    notifyJoinApproved({ userId: targetId, classId: cls._id, className: cls.name });
  } else {
    emitToClass(req, cls._id, 'member:updated', {
      classId: String(cls._id),
      userId:  String(targetId),
      change:  action,
    });
  }

  res.json({ success: true });
}));

// DELETE /api/classes/:id/members/:userId
// Leave the class (own id) or remove someone (admins). Also cancels a pending request.
router.delete('/:id/members/:userId', loadClass, wrap(async (req, res) => {
  const { cls } = req;
  const targetId = req.params.userId;
  const uid      = String(req.user._id);

  if (!req.member) return fail(res, 403, 'You are not part of this class.');
  const target = isId(targetId) ? cls.getMember(targetId) : null;
  if (!target) return fail(res, 404, 'Member not found.');

  if (String(cls.owner) === String(targetId)) {
    return fail(res, 400, 'The owner cannot leave or be removed. Archive the class instead.');
  }

  const isSelf = String(targetId) === uid;
  if (!isSelf) {
    const iAmAdmin = req.member.status === 'active' && req.member.role === 'admin';
    if (!iAmAdmin) return fail(res, 403, 'Only class admins can remove members.');
    if (target.role === 'admin' && String(cls.owner) !== uid) {
      return fail(res, 403, 'Only the owner can remove another admin.');
    }
  }

  await Class.updateOne({ _id: cls._id }, { $pull: { members: { user: oid(targetId) } } });

  // Kick their live sockets out of the class room right away
  const io = req.app.get('io');
  if (io) io.in(`user:${targetId}`).socketsLeave(`class:${cls._id}`);
  if (!isSelf) emitToUser(req, targetId, 'class:removed', { classId: String(cls._id) });
  emitToClass(req, cls._id, 'member:left', { classId: String(cls._id), userId: String(targetId) });

  res.json({ success: true });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  CHAT HISTORY, PINS, REPORTS  (sending and deleting happen over the socket)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/classes/:id/upload-signature
// Gives the app a short-lived, class-specific permission to upload one file
// (photo, document or voice note) straight to Cloudinary.
router.post('/:id/upload-signature', uploadLimiter, loadClass, requireMember, wrap(async (req, res) => {
  if (!isConfigured()) return fail(res, 503, 'File uploads are not set up yet.');
  if (req.cls.archived) return fail(res, 403, 'This class has been archived.');
  if (req.member.muted) return fail(res, 403, 'You are muted in this class.');
  if (req.cls.chatLocked && req.member.role !== 'admin') {
    return fail(res, 403, 'Only admins can send messages right now.');
  }

  res.json({ success: true, upload: signUpload(String(req.cls._id)) });
}));

// GET /api/classes/:id/messages?before=<messageId>&limit=30
router.get('/:id/messages', loadClass, requireMember, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
  const filter = { class: req.cls._id };
  if (req.query.before && isId(req.query.before)) filter._id = { $lt: req.query.before };

  const rows = await ClassMessage.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate(ClassMessage.POPULATE);

  const hasMore = rows.length > limit;
  const page    = rows.slice(0, limit).reverse(); // oldest first for the chat view

  res.json({ success: true, hasMore, messages: page.map((m) => m.toClient()) });

  // Opening the chat means the newest messages have reached this student
  if (!req.query.before && rows.length) {
    markDelivered(req.app.get('io'), req.cls._id, [req.user._id], rows[0]._id);
  }
}));

// PUT /api/classes/:id/messages/:mid/pin   body: { pinned: true|false }
router.put('/:id/messages/:mid/pin', loadClass, requireAdmin, wrap(async (req, res) => {
  if (!isId(req.params.mid)) return fail(res, 400, 'Invalid message id.');
  const pinned = !!req.body.pinned;

  const msg = await ClassMessage.findOneAndUpdate(
    { _id: req.params.mid, class: req.cls._id, deleted: false },
    { pinned },
    { new: true }
  );
  if (!msg) return fail(res, 404, 'Message not found.');

  emitToClass(req, req.cls._id, 'message:pinned', {
    id:      String(msg._id),
    classId: String(req.cls._id),
    pinned,
  });
  res.json({ success: true });
}));

// POST /api/classes/:id/messages/:mid/report
router.post('/:id/messages/:mid/report', loadClass, requireMember, wrap(async (req, res) => {
  if (!isId(req.params.mid)) return fail(res, 400, 'Invalid message id.');

  const msg = await ClassMessage.findOneAndUpdate(
    {
      _id:     req.params.mid,
      class:   req.cls._id,
      deleted: false,
      sender:  { $ne: req.user._id },
    },
    { $addToSet: { reportedBy: req.user._id } }
  );
  if (!msg) return fail(res, 404, 'Message not found.');

  res.json({ success: true, message: 'Report sent to the class admins.' });
}));

// GET /api/classes/:id/reports  → admins see reported messages
router.get('/:id/reports', loadClass, requireAdmin, wrap(async (req, res) => {
  const rows = await ClassMessage.find({
    class:   req.cls._id,
    deleted: false,
    'reportedBy.0': { $exists: true },
  })
    .select('+reportedBy')
    .sort({ _id: -1 })
    .limit(50)
    .populate(ClassMessage.POPULATE);

  res.json({
    success: true,
    reports: rows.map((m) => ({ ...m.toClient(), reportCount: m.reportedBy.length })),
  });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  ANONYMOUS SESSIONS  (posting happens over the socket: "anon:send")
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/classes/:id/anon  → admin opens a session   body: { prompt }
router.post('/:id/anon', loadClass, requireAdmin, wrap(async (req, res) => {
  const { cls } = req;
  if (cls.archived) return fail(res, 400, 'This class is archived.');

  const prompt = String(req.body.prompt || '').trim().slice(0, 300);

  const alreadyOpen = await AnonSession.exists({ class: cls._id, status: 'open' });
  if (alreadyOpen) return fail(res, 409, 'An anonymous session is already open. Close it first.');

  let session;
  try {
    session = await AnonSession.create({ class: cls._id, prompt, createdBy: req.user._id });
  } catch (err) {
    if (err.code === 11000) return fail(res, 409, 'An anonymous session is already open. Close it first.');
    throw err;
  }

  emitToClass(req, cls._id, 'anon:opened', session.toClient());
  res.status(201).json({ success: true, session: session.toClient() });

  // One push that a session opened. Individual anonymous posts never push.
  notifyAnonOpened(req.app.get('io'), {
    classId:   cls._id,
    className: cls.name,
    prompt:    session.prompt,
    byUserId:  req.user._id,
  });
}));

// POST /api/classes/:id/anon/:sid/close
router.post('/:id/anon/:sid/close', loadClass, requireAdmin, wrap(async (req, res) => {
  if (!isId(req.params.sid)) return fail(res, 400, 'Invalid session id.');

  const session = await AnonSession.findOneAndUpdate(
    { _id: req.params.sid, class: req.cls._id, status: 'open' },
    { status: 'closed', closedAt: new Date() },
    { new: true }
  );
  if (!session) return fail(res, 404, 'No open session found.');

  emitToClass(req, req.cls._id, 'anon:closed', session.toClient());
  res.json({ success: true, session: session.toClient() });
}));

// GET /api/classes/:id/anon  → recent sessions
router.get('/:id/anon', loadClass, requireMember, wrap(async (req, res) => {
  const sessions = await AnonSession.find({ class: req.cls._id })
    .sort({ createdAt: -1 })
    .limit(20);
  res.json({ success: true, sessions: sessions.map((s) => s.toClient()) });
}));

// GET /api/classes/:id/anon/:sid/posts?before=<postId>&limit=50
router.get('/:id/anon/:sid/posts', loadClass, requireMember, wrap(async (req, res) => {
  if (!isId(req.params.sid)) return fail(res, 400, 'Invalid session id.');

  const session = await AnonSession.findOne({ _id: req.params.sid, class: req.cls._id });
  if (!session) return fail(res, 404, 'Session not found.');

  const limit  = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const filter = { session: session._id, hidden: false };
  if (req.query.before && isId(req.query.before)) filter._id = { $lt: req.query.before };

  const rows = await AnonPost.find(filter).sort({ _id: -1 }).limit(limit + 1);
  const hasMore = rows.length > limit;

  res.json({
    success: true,
    session: session.toClient(),
    hasMore,
    posts: rows.slice(0, limit).map((p) => p.toClient()), // newest first
  });
}));

// DELETE /api/classes/:id/anon/:sid/posts/:pid?block=true
// Hides a post. With block=true the sender is also blocked for the rest of this
// session, without the admin ever learning who they are.
router.delete('/:id/anon/:sid/posts/:pid', loadClass, requireAdmin, wrap(async (req, res) => {
  const { sid, pid } = req.params;
  if (!isId(sid) || !isId(pid)) return fail(res, 400, 'Invalid id.');

  const post = await AnonPost.findOne({ _id: pid, session: sid, class: req.cls._id })
    .select('+tokenHash');
  if (!post) return fail(res, 404, 'Post not found.');

  post.hidden = true;
  await post.save();

  if (req.query.block === 'true') {
    await AnonSession.updateOne({ _id: sid }, { $addToSet: { blockedTokens: post.tokenHash } });
  }

  emitToClass(req, req.cls._id, 'anon:hidden', {
    id:        String(post._id),
    sessionId: String(sid),
    classId:   String(req.cls._id),
  });
  res.json({ success: true });
}));

module.exports = router;