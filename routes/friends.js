// routes/friends.js
//
// Finding people, friend requests, blocking, and opening a private chat.
//
//   GET    /api/friends                  my friends, requests I got / sent, people I blocked
//   GET    /api/friends/search?q=        find students by name or username
//   GET    /api/friends/suggestions?scope=app|school|department&q=&skip=
//                                         "People you may know" (see below)
//   GET    /api/friends/person/:id       one student's card (for the tap-a-name sheet)
//   POST   /api/friends/request          { userId }  send a request (or accept theirs)
//   PUT    /api/friends/request/:userId  { action: 'accept' | 'decline' }
//   DELETE /api/friends/request/:userId  cancel a request I sent
//   DELETE /api/friends/:userId          unfriend
//   POST   /api/friends/block            { userId }
//   DELETE /api/friends/block/:userId    unblock
//   POST   /api/friends/:userId/chat     open (or create) my private chat with a friend
//   GET    /api/friends/settings         { findable }
//   PUT    /api/friends/settings         { findable }
//
// A private chat is a Class with kind 'dm', so messages, voice notes, replies
// and reactions all work exactly like in a class.

const express   = require('express');
const mongoose  = require('mongoose');
const rateLimit = require('express-rate-limit');

const { protect }  = require('../middleware/auth');
const User         = require('../models/User');
const Class        = require('../models/Class');
const Friendship   = require('../models/Friendship');
const { displayName } = require('../utils/displayName');
const { notifyFriendRequest, notifyFriendAccepted } = require('../utils/classPush');

const router = express.Router();
router.use(protect);

const isId = mongoose.isValidObjectId;

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message });

const emitToUser = (req, userId, event, payload) => {
  const io = req.app.get('io');
  if (io) io.to(`user:${userId}`).emit(event, payload);
};

const perUser = (max, windowMs, message) => rateLimit({
  windowMs,
  max,
  keyGenerator: (req) => String(req.user && req.user._id),
  validate: false,
  message: { success: false, message },
  standardHeaders: true,
  legacyHeaders: false,
});

const searchLimiter  = perUser(40, 60 * 1000, 'Too many searches. Try again in a moment.');
const suggestLimiter = perUser(60, 60 * 1000, 'Too many searches. Try again in a moment.');
const requestLimiter = perUser(30, 60 * 60 * 1000, 'You have sent a lot of requests. Try again later.');

const PEOPLE_FIELDS = 'profile.name profile.department profile.level username findable';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** What one student sees about another. Never includes the real name of a
 *  student who chose a username (the username is the public name). */
const cardOf = (u, relation, extra = {}) => ({
  id:         String(u._id),
  name:       displayName(u),
  username:   u.username || '',
  department: (u.profile && u.profile.department) || '',
  level:      (u.profile && u.profile.level) || '',
  relation,
  ...extra,
});

/** none | friends | sent | received | blocked (blocked = I blocked them) */
const relationOf = (fs, myId) => {
  if (!fs) return 'none';
  if (fs.status === 'accepted') return 'friends';
  if (fs.status === 'blocked')  return String(fs.blockedBy) === String(myId) ? 'blocked' : 'none';
  return String(fs.requester) === String(myId) ? 'sent' : 'received';
};

const pairOf = (a, b) => Friendship.pairKey(a, b);

/** Do these two students share a class (a real class, not a private chat)? */
const shareAClass = async (a, b) => {
  const ua = new mongoose.Types.ObjectId(String(a));
  const ub = new mongoose.Types.ObjectId(String(b));
  return !!(await Class.exists({
    kind: { $ne: 'dm' },
    archived: false,
    $and: [
      { members: { $elemMatch: { user: ua, status: 'active' } } },
      { members: { $elemMatch: { user: ub, status: 'active' } } },
    ],
  }));
};

/** May I look at / contact this student? Findable people, classmates, or anyone
 *  I already have a request or friendship with. */
const canReach = async (me, target, fs) => {
  if (target.findable !== false) return true;
  if (fs) return true;
  return shareAClass(me, target._id);
};

/** Finds or creates the private chat for two friends. Un-archives it if they
 *  were friends before. */
const ensureDm = async (a, b) => {
  const key = pairOf(a, b);
  let cls = await Class.findOne({ dmKey: key });
  if (cls) {
    if (cls.archived) {
      cls.archived = false;
      await cls.save();
    }
    return cls;
  }
  try {
    cls = await Class.create({
      name:     'Private chat',
      owner:    a,
      kind:     'dm',
      dmKey:    key,
      joinCode: await Class.generateUniqueCode(),
      members: [
        { user: a, role: 'member', status: 'active' },
        { user: b, role: 'member', status: 'active' },
      ],
    });
  } catch (err) {
    if (err.code === 11000) return Class.findOne({ dmKey: key }); // created at the same moment
    throw err;
  }
  return cls;
};

/** Hides the private chat (unfriend / block). History is kept for if they reconnect. */
const archiveDm = async (req, a, b) => {
  const cls = await Class.findOneAndUpdate(
    { dmKey: pairOf(a, b) },
    { archived: true },
    { new: true }
  );
  if (cls) {
    emitToUser(req, a, 'class:archived', { classId: String(cls._id) });
    emitToUser(req, b, 'class:archived', { classId: String(cls._id) });
  }
};

/** Turns a pending request into a friendship and opens their chat. */
const acceptRequest = async (req, fs) => {
  const me    = String(req.user._id);
  const other = String(fs.otherOf(me));

  const cls = await ensureDm(fs.requester, fs.recipient);
  fs.status  = 'accepted';
  fs.dmClass = cls._id;
  await fs.save();

  const payload = { classId: String(cls._id) };
  emitToUser(req, other, 'friend:accepted', { ...payload, userId: me });
  emitToUser(req, me,    'friend:accepted', { ...payload, userId: other });

  notifyFriendAccepted({
    userId:  other,
    byName:  displayName(req.user, 'A student'),
    classId: cls._id,
  });
  return cls;
};

// ══════════════════════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════════════════════

router.get('/settings', wrap(async (req, res) => {
  const me = await User.findById(req.user._id).select('findable');
  res.json({ success: true, findable: !me || me.findable !== false });
}));

router.put('/settings', wrap(async (req, res) => {
  if (typeof req.body.findable !== 'boolean') {
    return fail(res, 400, 'findable must be true or false.');
  }
  await User.updateOne({ _id: req.user._id }, { $set: { findable: req.body.findable } });
  res.json({ success: true, findable: req.body.findable });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  LISTS
// ══════════════════════════════════════════════════════════════════════════════

router.get('/', wrap(async (req, res) => {
  const me = req.user._id;

  const rows = await Friendship.find({
    $or: [{ requester: me }, { recipient: me }],
  }).sort({ updatedAt: -1 });

  const otherIds = rows.map((r) => String(r.otherOf(me)));
  const users = await User.find({ _id: { $in: otherIds } }).select(PEOPLE_FIELDS);
  const byId  = new Map(users.map((u) => [String(u._id), u]));

  const friends = [];
  const incoming = [];
  const outgoing = [];
  const blocked = [];

  for (const r of rows) {
    const u = byId.get(String(r.otherOf(me)));
    if (!u) continue;

    if (r.status === 'accepted') {
      friends.push(cardOf(u, 'friends', { classId: r.dmClass ? String(r.dmClass) : null }));
    } else if (r.status === 'pending') {
      if (String(r.recipient) === String(me)) {
        incoming.push(cardOf(u, 'received', { sentAt: r.createdAt }));
      } else {
        outgoing.push(cardOf(u, 'sent', { sentAt: r.createdAt }));
      }
    } else if (r.status === 'blocked' && String(r.blockedBy) === String(me)) {
      blocked.push(cardOf(u, 'blocked'));
    }
  }

  friends.sort((a, b) => a.name.localeCompare(b.name));

  res.json({ success: true, friends, incoming, outgoing, blocked });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  SEARCH + PERSON CARD
// ══════════════════════════════════════════════════════════════════════════════

router.get('/search', searchLimiter, wrap(async (req, res) => {
  let q = String(req.query.q || '').trim().replace(/^@/, '');
  if (q.length < 2)  return fail(res, 400, 'Type at least 2 characters.');
  if (q.length > 40) return fail(res, 400, 'That search is too long.');

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const me = req.user._id;

  // People with a username are found by it only, so searching a real name
  // can never reveal which username belongs to it.
  const noUsername = [
    { username: { $exists: false } },
    { username: null },
    { username: '' },
  ];

  const found = await User.find({
    _id:      { $ne: me },
    findable: { $ne: false },
    $or: [
      { username: re },
      { $and: [{ $or: noUsername }, { 'profile.name': re }] },
    ],
  })
    .select(PEOPLE_FIELDS)
    .limit(25)
    .maxTimeMS(5000);

  const pairs = found.map((u) => pairOf(me, u._id));
  const links = await Friendship.find({ pair: { $in: pairs } });
  const byPair = new Map(links.map((l) => [l.pair, l]));

  const people = [];
  for (const u of found) {
    const fs = byPair.get(pairOf(me, u._id));
    // Someone who blocked me never shows up for me
    if (fs && fs.status === 'blocked' && String(fs.blockedBy) !== String(me)) continue;
    people.push(cardOf(u, relationOf(fs, me)));
  }

  res.json({ success: true, people });
}));

// ── People you may know ──────────────────────────────────────────────────────
// GET /api/friends/suggestions?scope=app|school|department&q=text&skip=0
//   app         everyone who can be found
//   school      students at my school
//   department  students in my department (and my level, and my school when set)
// Never lists me, my friends, people I blocked, or people who blocked me.
// People who turned off "let others find me" are left out. People with a
// username are matched by it only, like the normal search. 20 per page.

const SUGGEST_PAGE = 20;
const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactRe  = (v) => new RegExp(`^\\s*${escapeRe(String(v).trim())}\\s*$`, 'i');

router.get('/suggestions', suggestLimiter, wrap(async (req, res) => {
  const me    = req.user._id;
  const scope = ['app', 'school', 'department'].includes(req.query.scope)
    ? req.query.scope
    : 'app';
  const skip = Math.max(0, Math.min(parseInt(req.query.skip, 10) || 0, 2000));

  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (q.length > 40) return fail(res, 400, 'That search is too long.');

  const mine = await User.findById(me).select('profile.school profile.department profile.level');
  const school = ((mine && mine.profile && mine.profile.school) || '').trim();
  const dept   = ((mine && mine.profile && mine.profile.department) || '').trim();
  const level  = ((mine && mine.profile && mine.profile.level) || '').trim();

  // These tabs need something filled in on my own profile
  if (scope === 'school' && !school) {
    return res.json({ success: true, people: [], hasMore: false, needsProfile: 'school' });
  }
  if (scope === 'department' && !dept) {
    return res.json({ success: true, people: [], hasMore: false, needsProfile: 'department' });
  }

  // Friends and blocked people (either direction) never show up
  const hidden = await Friendship.find({
    $or: [{ requester: me }, { recipient: me }],
    status: { $in: ['accepted', 'blocked'] },
  }).select('requester recipient');
  const excluded = [me, ...hidden.map((r) => r.otherOf(me))];

  const filter = { _id: { $nin: excluded }, findable: { $ne: false } };
  if (scope === 'school') {
    filter['profile.school'] = exactRe(school);
  } else if (scope === 'department') {
    filter['profile.department'] = exactRe(dept);
    if (level)  filter['profile.level']  = exactRe(level);
    if (school) filter['profile.school'] = exactRe(school);
  }

  if (q.length >= 2) {
    const re = new RegExp(escapeRe(q), 'i');
    const noUsername = [
      { username: { $exists: false } },
      { username: null },
      { username: '' },
    ];
    filter.$or = [
      { username: re },
      { $and: [{ $or: noUsername }, { 'profile.name': re }] },
    ];
  }

  const rows = await User.find(filter)
    .select(`${PEOPLE_FIELDS} profile.school`)
    .sort({ _id: -1 })
    .skip(skip)
    .limit(SUGGEST_PAGE + 1)
    .maxTimeMS(5000);

  const hasMore = rows.length > SUGGEST_PAGE;
  const page    = rows.slice(0, SUGGEST_PAGE);

  // Requests already sent or received, so the button says Requested / Accept
  const pairs  = page.map((u) => pairOf(me, u._id));
  const links  = await Friendship.find({ pair: { $in: pairs } });
  const byPair = new Map(links.map((l) => [l.pair, l]));

  // How many classes I have in common with each person
  const myClasses = await Class.find({
    kind: { $ne: 'dm' },
    archived: false,
    members: { $elemMatch: { user: me, status: 'active' } },
  }).select('members.user members.status').lean();

  const common = new Map();
  for (const c of myClasses) {
    for (const m of c.members) {
      if (m.status !== 'active' || String(m.user) === String(me)) continue;
      common.set(String(m.user), (common.get(String(m.user)) || 0) + 1);
    }
  }

  const people = page.map((u) => {
    const fs = byPair.get(pairOf(me, u._id));
    return cardOf(u, relationOf(fs, me), {
      school:        (u.profile && u.profile.school) || '',
      mutualClasses: common.get(String(u._id)) || 0,
    });
  });

  // Classmates first inside each page (stable for everyone else)
  people.sort((a, b) => b.mutualClasses - a.mutualClasses);

  res.json({ success: true, people, hasMore });
}));

router.get('/person/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, 'Invalid user id.');
  const me = req.user._id;

  const u = await User.findById(req.params.id).select(PEOPLE_FIELDS);
  if (!u) return fail(res, 404, 'Student not found.');

  if (String(u._id) === String(me)) {
    return res.json({ success: true, person: cardOf(u, 'self') });
  }

  const fs = await Friendship.findOne({ pair: pairOf(me, u._id) });
  if (fs && fs.status === 'blocked' && String(fs.blockedBy) !== String(me)) {
    return fail(res, 404, 'Student not found.');
  }
  if (!(await canReach(me, u, fs))) return fail(res, 404, 'Student not found.');

  res.json({
    success: true,
    person: cardOf(u, relationOf(fs, me), {
      classId: fs && fs.status === 'accepted' && fs.dmClass ? String(fs.dmClass) : null,
    }),
  });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  REQUESTS
// ══════════════════════════════════════════════════════════════════════════════

router.post('/request', requestLimiter, wrap(async (req, res) => {
  const targetId = req.body.userId;
  const me = req.user._id;

  if (!isId(targetId))                  return fail(res, 400, 'Invalid user id.');
  if (String(targetId) === String(me))  return fail(res, 400, 'You cannot add yourself.');

  const target = await User.findById(targetId).select(PEOPLE_FIELDS);
  if (!target) return fail(res, 404, 'Student not found.');

  const key = pairOf(me, targetId);
  let fs = await Friendship.findOne({ pair: key });

  if (fs) {
    if (fs.status === 'blocked') {
      return fail(res, 403, 'You cannot send a request to this person.');
    }
    if (fs.status === 'accepted') {
      return res.json({ success: true, relation: 'friends', classId: String(fs.dmClass || '') });
    }
    // They already asked me: sending one back is the same as accepting
    if (String(fs.recipient) === String(me)) {
      const cls = await acceptRequest(req, fs);
      return res.json({ success: true, relation: 'friends', classId: String(cls._id) });
    }
    return res.json({ success: true, relation: 'sent' });
  }

  if (!(await canReach(me, target, null))) {
    return fail(res, 403, 'You cannot send a request to this person.');
  }

  try {
    fs = await Friendship.create({ pair: key, requester: me, recipient: targetId });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true, relation: 'sent' });
    throw err;
  }

  const name = displayName(req.user, 'A student');
  emitToUser(req, targetId, 'friend:request', { userId: String(me), name });
  notifyFriendRequest({ userId: targetId, fromName: name, fromId: me });

  res.status(201).json({ success: true, relation: 'sent' });
}));

router.put('/request/:userId', wrap(async (req, res) => {
  if (!isId(req.params.userId)) return fail(res, 400, 'Invalid user id.');
  const me = req.user._id;

  const fs = await Friendship.findOne({
    pair:      pairOf(me, req.params.userId),
    status:    'pending',
    recipient: me,
  });
  if (!fs) return fail(res, 404, 'No request from this person.');

  const action = req.body.action;
  if (action === 'accept') {
    const cls = await acceptRequest(req, fs);
    return res.json({ success: true, relation: 'friends', classId: String(cls._id) });
  }
  if (action === 'decline') {
    await fs.deleteOne();
    emitToUser(req, me, 'friend:removed', { userId: String(req.params.userId) });
    return res.json({ success: true, relation: 'none' });
  }
  fail(res, 400, 'Unknown action.');
}));

router.delete('/request/:userId', wrap(async (req, res) => {
  if (!isId(req.params.userId)) return fail(res, 400, 'Invalid user id.');
  const me = req.user._id;

  const fs = await Friendship.findOneAndDelete({
    pair:      pairOf(me, req.params.userId),
    status:    'pending',
    requester: me,
  });
  if (!fs) return fail(res, 404, 'No request to cancel.');

  emitToUser(req, req.params.userId, 'friend:removed', { userId: String(me) });
  res.json({ success: true, relation: 'none' });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  BLOCK
// ══════════════════════════════════════════════════════════════════════════════

router.post('/block', wrap(async (req, res) => {
  const targetId = req.body.userId;
  const me = req.user._id;

  if (!isId(targetId))                 return fail(res, 400, 'Invalid user id.');
  if (String(targetId) === String(me)) return fail(res, 400, 'You cannot block yourself.');
  if (!(await User.exists({ _id: targetId }))) return fail(res, 404, 'Student not found.');

  const key = pairOf(me, targetId);
  const fs  = await Friendship.findOne({ pair: key });

  if (fs && fs.status === 'blocked') {
    // If THEY blocked me, I must not be able to overwrite it
    if (String(fs.blockedBy) !== String(me)) return res.json({ success: true, relation: 'blocked' });
  }

  await Friendship.findOneAndUpdate(
    { pair: key },
    { $set: { status: 'blocked', blockedBy: me, requester: me, recipient: targetId } },
    { upsert: true }
  );

  await archiveDm(req, me, targetId);
  emitToUser(req, targetId, 'friend:removed', { userId: String(me) });
  res.json({ success: true, relation: 'blocked' });
}));

router.delete('/block/:userId', wrap(async (req, res) => {
  if (!isId(req.params.userId)) return fail(res, 400, 'Invalid user id.');
  await Friendship.deleteOne({
    pair:      pairOf(req.user._id, req.params.userId),
    status:    'blocked',
    blockedBy: req.user._id,
  });
  res.json({ success: true, relation: 'none' });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  UNFRIEND + OPEN CHAT
// ══════════════════════════════════════════════════════════════════════════════

router.delete('/:userId', wrap(async (req, res) => {
  if (!isId(req.params.userId)) return fail(res, 400, 'Invalid user id.');
  const me = req.user._id;

  const fs = await Friendship.findOneAndDelete({
    pair:   pairOf(me, req.params.userId),
    status: 'accepted',
  });
  if (!fs) return fail(res, 404, 'You are not friends with this person.');

  await archiveDm(req, me, req.params.userId);
  emitToUser(req, req.params.userId, 'friend:removed', { userId: String(me) });
  emitToUser(req, me, 'friend:removed', { userId: String(req.params.userId) });
  res.json({ success: true, relation: 'none' });
}));

// POST /api/friends/:userId/chat → the private chat with a friend
router.post('/:userId/chat', wrap(async (req, res) => {
  if (!isId(req.params.userId)) return fail(res, 400, 'Invalid user id.');
  const me = req.user._id;

  const fs = await Friendship.findOne({
    pair:   pairOf(me, req.params.userId),
    status: 'accepted',
  });
  if (!fs) return fail(res, 403, 'You can only message friends.');

  const cls = await ensureDm(me, req.params.userId);
  if (!fs.dmClass || String(fs.dmClass) !== String(cls._id)) {
    fs.dmClass = cls._id;
    await fs.save();
  }

  const other = await User.findById(req.params.userId).select('profile.name username');
  res.json({
    success: true,
    class: {
      id:           String(cls._id),
      kind:         'dm',
      name:         displayName(other, 'Student'),
      peerId:       String(req.params.userId),
      peerUsername: (other && other.username) || '',
      description:  '',
      requireApproval: false,
      chatLocked:   false,
      archived:     false,
      memberCount:  2,
      myRole:       'member',
      myStatus:     'active',
      isOwner:      false,
      createdAt:    cls.createdAt,
    },
  });
}));

module.exports = router;