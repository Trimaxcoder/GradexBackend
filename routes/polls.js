// routes/polls.js
//
// Rules this file follows:
//  1. One person, one vote. The database itself refuses a second vote
//     (unique index on PollVoter).
//  2. In a secret ballot, the record of WHAT was chosen (PollVote) has no
//     link to WHO voted (PollVoter), and keeps only the day, not the time.
//  3. Counts are always worked out on the server.
//  4. Access errors use status 403 with a `code`, never 401, so the app does not
//     think a guest's session has expired.

const express   = require('express');
const mongoose  = require('mongoose');
const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { protect }     = require('../middleware/auth');
const identify        = require('../middleware/identify');
const User            = require('../models/User');
const Class           = require('../models/Class');
const Poll            = require('../models/Poll');
const PollVoter       = require('../models/PollVoter');
const PollVote        = require('../models/PollVote');
const { displayName } = require('../utils/displayName');
const { isConfigured, signUpload } = require('../utils/cloudinary');

const router = express.Router();

const MAX_POLLS_PER_USER = 200;
const MAX_OPTIONS = 20;

const isId = mongoose.isValidObjectId;

// ── Who is acting: a SchoolLife user (req.user) or a Gmail guest (req.guest) ──
const ownerFilter = (req) =>
  req.user ? { owner: req.user._id } : { ownerEmail: req.guest.email };

const ownerFields = (req) =>
  req.user ? { owner: req.user._id } : { ownerEmail: req.guest.email };

const userIdOf = (req) => (req.user ? req.user._id : null);

const isOwner = (doc, req) =>
  req.user
    ? !!doc.owner && String(doc.owner) === String(req.user._id)
    : !!req.guest && !!doc.ownerEmail && doc.ownerEmail === req.guest.email;

// ── Small helpers ─────────────────────────────────────────────────────────────
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, status, message, code) =>
  res.status(status).json({ success: false, message, ...(code ? { code } : {}) });

const pollLink = (publicId) =>
  `${process.env.POLL_LINK_BASE || 'https://schoolife.web.app/p'}/${publicId}`;

const optionalAuth = async (req, _res, next) => {
  try {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) {
      const decoded = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
      if (decoded.type === 'guest' && decoded.email) {
        req.guest = { email: String(decoded.email).toLowerCase(), name: String(decoded.name || '') };
      } else {
        const user = await User.findById(decoded.id).select('-password -refreshToken');
        if (user) req.user = user;
      }
    }
  } catch (_) {}
  next();
};

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many requests. Try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Counts only FAILED tries (wrong code, closed poll...), so many students on the
// same campus Wi-Fi can still vote, but code guessing is stopped.
const attemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many tries. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const voteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: { success: false, message: 'Too many votes from this network. Try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Poll state ────────────────────────────────────────────────────────────────
const notStarted = (poll) => !!poll.opensAt && poll.opensAt.getTime() > Date.now();

const isOpen = (poll) =>
  poll.status === 'open' &&
  !notStarted(poll) &&
  (!poll.closesAt || poll.closesAt.getTime() > Date.now());

// Voting is over (closed by hand, or the deadline passed)
const isFinished = (poll) =>
  poll.status === 'closed' || (!!poll.closesAt && poll.closesAt.getTime() <= Date.now());

// 'scheduled' (not started) | 'open' | 'closed' | 'expired' (deadline passed)
const effectiveStatus = (poll) =>
  poll.status === 'closed'
    ? 'closed'
    : notStarted(poll)
      ? 'scheduled'
      : isOpen(poll)
        ? 'open'
        : 'expired';

const closedMessage = (poll) => {
  const st = effectiveStatus(poll);
  if (st === 'scheduled') return 'Voting has not started yet.';
  if (st === 'expired') return 'The deadline for this poll has passed.';
  return 'This poll is closed.';
};

const startOfDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const parseDeadline = (raw, current, label = 'deadline') => {
  if (raw === null || raw === '') return { value: null };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { error: `Choose a valid ${label}.` };
  if (current && current.getTime() === d.getTime()) return { value: d };
  if (d.getTime() <= Date.now()) return { error: `The ${label} must be in the future.` };
  return { value: d };
};

// Private poll code: 6 characters, no look-alikes (0/O, 1/I)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
};

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ── Validation ────────────────────────────────────────────────────────────────
// Only photos uploaded to your own Cloudinary are accepted
const cleanPhoto = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.length <= 500 && /^https:\/\/res\.cloudinary\.com\//.test(s) ? s : null;
};

// Returns { questions } or { error }. Ids are made here (q1, o1, ...).
const sanitizeQuestions = (raw, kind, pollTitle) => {
  if (!Array.isArray(raw) || raw.length < 1) return { error: 'Add the question and its options.' };

  const maxQuestions = kind === 'election' ? 20 : 1;
  if (raw.length > maxQuestions) {
    return {
      error: kind === 'poll'
        ? 'A simple poll has one question.'
        : 'An election can have up to 20 positions.',
    };
  }

  const questions = [];
  for (let qi = 0; qi < raw.length; qi++) {
    const q = raw[qi] || {};

    // options can be plain text or { label, photoUrl, bio }
    const seen = new Set();
    const options = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const label = String(typeof o === 'string' ? o : (o && o.label) || '').trim();
      if (!label) continue;
      if (label.length > 200) return { error: 'An option is too long (200 characters max).' };
      if (seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      let photoUrl = '';
      if (kind === 'election' && o && typeof o === 'object') {
        photoUrl = cleanPhoto(o.photoUrl);
        if (photoUrl === null) return { error: 'A candidate photo is not valid. Upload it again.' };
      }
      options.push({
        label,
        photoUrl,
        bio: kind === 'election' && o && typeof o === 'object' ? String(o.bio || '').trim().slice(0, 500) : '',
      });
    }

    const minOptions = kind === 'election' ? 1 : 2;
    if (options.length < minOptions || options.length > MAX_OPTIONS) {
      return { error: `Add ${minOptions} to ${MAX_OPTIONS} options.` };
    }

    let type = 'single';
    let maxChoices = 1;
    if (q.type === 'multiple' && options.length >= 2) {
      type = 'multiple';
      const wanted = parseInt(q.maxChoices) || options.length;
      maxChoices = Math.min(Math.max(wanted, 2), options.length);
    }

    const title = kind === 'poll' ? pollTitle : String(q.title || '').trim().slice(0, 300);
    if (!title) return { error: 'Every position needs a title.' };

    questions.push({
      id: `q${qi + 1}`,
      title,
      type,
      maxChoices,
      allowAbstain: kind === 'election' && q.allowAbstain === true,
      options: options.map((o, i) => ({ id: `o${i + 1}`, ...o })),
    });
  }
  return { questions };
};

const questionOut = (q) => ({
  id: q.id,
  title: q.title,
  type: q.type,
  maxChoices: q.maxChoices,
  allowAbstain: q.allowAbstain,
  options: q.options.map((o) => ({ id: o.id, label: o.label, photoUrl: o.photoUrl, bio: o.bio })),
});

const pollOut = (poll, owner = false) => ({
  id: String(poll._id),
  publicId: poll.publicId,
  link: pollLink(poll.publicId),
  kind: poll.kind,
  title: poll.title,
  description: poll.description,
  classId: poll.classId ? String(poll.classId) : null,
  status: poll.status,
  effectiveStatus: effectiveStatus(poll),
  closesAt: poll.closesAt,
  requireAccount: poll.requireAccount,
  classOnly: poll.classOnly,
  requireCode: poll.requireCode,
  requireGmail: poll.requireGmail,
  opensAt: poll.opensAt,
  secretBallot: poll.secretBallot,
  resultsVisibility: poll.resultsVisibility,
  voteCount: poll.voteCount,
  questions: poll.questions.map(questionOut),
  ...(owner ? { code: poll.code } : {}),
  createdAt: poll.createdAt,
  updatedAt: poll.updatedAt,
});

// What anyone with the link may know before passing the code / account checks
const publicInfo = (poll) => ({
  publicId: poll.publicId,
  kind: poll.kind,
  title: poll.title,
  description: poll.description,
  status: effectiveStatus(poll),
  closesAt: poll.closesAt,
  opensAt: poll.opensAt,
  requireAccount: poll.requireAccount,
  requireCode: poll.requireCode,
  requireGmail: poll.requireGmail,
  classOnly: poll.classOnly,
  secretBallot: poll.secretBallot,
  resultsVisibility: poll.resultsVisibility,
});

// ── Access: account, class, code ──────────────────────────────────────────────
// Returns { voterKey } or { status, code, message }.
const checkAccess = async (poll, req, body) => {
  if (poll.requireAccount && !req.user) {
    return {
      status: 403,
      code: 'ACCOUNT_REQUIRED',
      message: 'This poll is for SchoolLife accounts only. Log in or create an account to continue.',
    };
  }

  // "Gmail only": guests must have signed in with Google (one vote per Gmail)
  if (poll.requireGmail && !req.user && !req.guest) {
    return {
      status: 403,
      code: 'GMAIL_REQUIRED',
      message: 'Sign in with your Gmail to take part in this poll.',
    };
  }

  if (poll.requireCode) {
    const given = String(body.code || '').trim().toUpperCase();
    if (!given) {
      return { status: 403, code: 'CODE_REQUIRED', message: 'Enter the poll code to continue.' };
    }
    if (!sameText(given, poll.code)) {
      return { status: 403, code: 'CODE_WRONG', message: 'That code is not correct.' };
    }
  }

  if (poll.classOnly) {
    const cls = poll.classId ? await Class.findById(poll.classId) : null;
    if (!cls || !req.user || !cls.isActiveMember(req.user._id)) {
      return {
        status: 403,
        code: 'CLASS_ONLY',
        message: 'Only members of this class can take part in this poll.',
      };
    }
  }

  // Who is voting? A SchoolLife account counts as one person on any device.
  // A guest is recognised by a random id kept on their device.
  if (req.user) return { voterKey: `u:${req.user._id}` };
  if (req.guest && poll.requireGmail) return { voterKey: `g:${req.guest.email}` };

  const deviceId = String(body.deviceId || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) {
    return { status: 400, code: 'NO_DEVICE', message: 'Could not recognise this device. Update the app and try again.' };
  }
  const hash = crypto.createHash('sha256').update(`${poll._id}:${deviceId}`).digest('hex');
  return { voterKey: `d:${hash}` };
};

// Who may see the results, and when
const resultsAccess = (poll, hasVoted) => {
  switch (poll.resultsVisibility) {
    case 'live':
      return { ok: true };
    case 'afterVote':
      return hasVoted || isFinished(poll)
        ? { ok: true }
        : { ok: false, message: 'You will see the results after you vote.' };
    case 'afterClose':
      return isFinished(poll)
        ? { ok: true }
        : { ok: false, message: 'The results will be shown when the poll closes.' };
    default:
      return { ok: false, message: 'The creator keeps the results private.' };
  }
};

// ── Counting ──────────────────────────────────────────────────────────────────
const tally = async (poll) => {
  const [optRows, qRows] = await Promise.all([
    PollVote.aggregate([
      { $match: { poll: poll._id } },
      { $unwind: '$answers' },
      { $unwind: '$answers.optionIds' },
      { $group: { _id: { q: '$answers.questionId', o: '$answers.optionIds' }, n: { $sum: 1 } } },
    ]),
    PollVote.aggregate([
      { $match: { poll: poll._id } },
      { $unwind: '$answers' },
      { $match: { 'answers.optionIds.0': { $exists: true } } },
      { $group: { _id: '$answers.questionId', n: { $sum: 1 } } },
    ]),
  ]);

  const votesOf = new Map(optRows.map((r) => [`${r._id.q}:${r._id.o}`, r.n]));
  const answeredOf = new Map(qRows.map((r) => [r._id, r.n]));
  const finished = isFinished(poll);

  const questions = poll.questions.map((q) => {
    const answered = answeredOf.get(q.id) || 0;
    const options = q.options.map((o) => {
      const votes = votesOf.get(`${q.id}:${o.id}`) || 0;
      return {
        id: o.id,
        label: o.label,
        photoUrl: o.photoUrl,
        votes,
        percent: answered ? Math.round((votes / answered) * 1000) / 10 : 0,
      };
    });

    // After the poll is over, work out who won. A position can have several
    // seats (voters pick up to N). A tie that does not fit in the remaining
    // seats is reported as "tied" so the creator can decide what to do.
    const seats = q.type === 'multiple' ? q.maxChoices : 1;
    let winners = [];
    let tied = [];
    if (finished && answered > 0) {
      const sorted = [...options].sort((a, b) => b.votes - a.votes);
      const cut = (sorted[seats - 1] || sorted[sorted.length - 1]).votes;
      if (cut === 0) {
        winners = sorted.filter((o) => o.votes > 0).map((o) => o.id);
      } else {
        const above = sorted.filter((o) => o.votes > cut);
        const at = sorted.filter((o) => o.votes === cut);
        if (above.length + at.length <= seats) {
          winners = [...above, ...at].map((o) => o.id);
        } else {
          winners = above.map((o) => o.id);
          tied = at.map((o) => o.id);
        }
      }
    }

    return {
      id: q.id,
      title: q.title,
      type: q.type,
      seats,
      answered,
      abstained: Math.max(poll.voteCount - answered, 0),
      options,
      winners,
      tied,
      leaders: [...winners, ...tied],
    };
  });

  const result = { voters: poll.voteCount, finished, questions };

  // Class polls: how many of the members have voted
  if (poll.classOnly && poll.classId) {
    const cls = await Class.findById(poll.classId).select('members');
    if (cls) {
      result.turnout = {
        eligible: cls.members.filter((m) => m.status === 'active').length,
        voted: poll.voteCount,
      };
    }
  }
  return result;
};

// ── Checking a ballot ─────────────────────────────────────────────────────────
const cleanBallot = (poll, raw) => {
  if (!Array.isArray(raw)) return { error: 'Your answers are missing.' };

  const answers = [];
  for (const q of poll.questions) {
    const a = raw.find((x) => x && x.questionId === q.id);
    const ids = [...new Set((a && Array.isArray(a.optionIds) ? a.optionIds : []).map(String))];

    if (ids.length === 0) {
      if (q.allowAbstain) continue;
      return { error: q.title ? `Choose an answer for "${q.title}".` : 'Choose an answer.' };
    }

    const valid = new Set(q.options.map((o) => o.id));
    if (ids.some((id) => !valid.has(id))) return { error: 'One of your choices is not valid.' };
    if (q.type === 'single' && ids.length !== 1) return { error: 'Pick only one option.' };
    if (q.type === 'multiple' && ids.length > q.maxChoices) {
      return { error: `You can pick up to ${q.maxChoices} options.` };
    }
    answers.push({ questionId: q.id, optionIds: ids });
  }
  return { answers };
};

// ══════════════════════════════════════════════════════════════════════════════
//  PUBLIC  (voting)
// ══════════════════════════════════════════════════════════════════════════════

const findByPublicId = (req) =>
  Poll.findOne({ publicId: String(req.params.publicId || '').slice(0, 20) });

// GET /api/polls/public/:publicId   → what to show before voting starts
router.get('/public/:publicId', readLimiter, optionalAuth, wrap(async (req, res) => {
  const poll = await findByPublicId(req);
  if (!poll) return fail(res, 404, 'Poll not found.');
  res.json({ success: true, poll: publicInfo(poll), loggedIn: !!req.user });
}));

// POST /api/polls/public/:publicId/ballot   body: { code?, deviceId? }
// Passes the account / class / code checks, then returns the questions.
router.post('/public/:publicId/ballot', attemptLimiter, optionalAuth, wrap(async (req, res) => {
  const poll = await findByPublicId(req);
  if (!poll) return fail(res, 404, 'Poll not found.');

  const access = await checkAccess(poll, req, req.body);
  if (access.message) return fail(res, access.status, access.message, access.code);

  const voted = !!(await PollVoter.exists({ poll: poll._id, voterKey: access.voterKey }));

  res.json({
    success: true,
    poll: { ...publicInfo(poll), questions: poll.questions.map(questionOut) },
    hasVoted: voted,
    canSeeResults: resultsAccess(poll, voted).ok,
  });
}));

// POST /api/polls/public/:publicId/vote
// body: { code?, deviceId?, answers: [{ questionId, optionIds: [] }] }
router.post('/public/:publicId/vote', voteLimiter, attemptLimiter, optionalAuth, wrap(async (req, res) => {
  const poll = await findByPublicId(req);
  if (!poll) return fail(res, 404, 'Poll not found.');
  if (!isOpen(poll)) return fail(res, 403, closedMessage(poll), 'CLOSED');

  const access = await checkAccess(poll, req, req.body);
  if (access.message) return fail(res, access.status, access.message, access.code);

  const ballot = cleanBallot(poll, req.body.answers);
  if (ballot.error) return fail(res, 400, ballot.error);

  // 1. Record that this person voted. The unique index refuses a second time.
  try {
    await PollVoter.create({ poll: poll._id, voterKey: access.voterKey });
  } catch (err) {
    if (err.code === 11000) {
      return fail(res, 409, 'You have already voted in this poll.', 'ALREADY_VOTED');
    }
    throw err;
  }

  // 2. Record what was chosen. A secret ballot keeps nothing about the voter.
  try {
    await PollVote.create({
      poll: poll._id,
      answers: ballot.answers,
      day: startOfDay(),
      ...(poll.secretBallot
        ? {}
        : {
            voterName: req.user
              ? displayName(req.user, 'Student')
              : (req.guest && poll.requireGmail ? (req.guest.name || req.guest.email) : 'Guest'),
            at: new Date(),
          }),
    });
  } catch (err) {
    // do not leave the person marked as "voted" without a vote
    await PollVoter.deleteOne({ poll: poll._id, voterKey: access.voterKey });
    throw err;
  }

  await Poll.updateOne({ _id: poll._id }, { $inc: { voteCount: 1 } });

  res.status(201).json({
    success: true,
    canSeeResults: resultsAccess(poll, true).ok,
  });
}));

// POST /api/polls/public/:publicId/results   body: { code?, deviceId? }
router.post('/public/:publicId/results', attemptLimiter, optionalAuth, wrap(async (req, res) => {
  const poll = await findByPublicId(req);
  if (!poll) return fail(res, 404, 'Poll not found.');

  const access = await checkAccess(poll, req, req.body);
  if (access.message) return fail(res, access.status, access.message, access.code);

  const voted = !!(await PollVoter.exists({ poll: poll._id, voterKey: access.voterKey }));
  const allowed = resultsAccess(poll, voted);
  if (!allowed.ok) return fail(res, 403, allowed.message, 'RESULTS_HIDDEN');

  res.json({ success: true, results: await tally(poll) });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  LISTS (logged-in users)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/polls/mine   → polls I created
router.get('/mine', identify, wrap(async (req, res) => {
  const polls = await Poll.find(ownerFilter(req))
    .sort({ createdAt: -1 })
    .limit(MAX_POLLS_PER_USER);
  res.json({ success: true, polls: polls.map((p) => pollOut(p, true)) });
}));

// GET /api/polls/classes   → open polls shared with the classes I belong to
router.get('/classes', protect, wrap(async (req, res) => {
  const classes = await Class.find({
    'members.user': req.user._id,
    archived: false,
    kind: { $ne: 'dm' },
  }).select('name members');
  const mine = classes.filter((c) => c.isActiveMember(req.user._id));

  const polls = await Poll.find({
    classId: { $in: mine.map((c) => c._id) },
    status: 'open',
    $or: [{ closesAt: null }, { closesAt: { $gt: new Date() } }],
  })
    .sort({ createdAt: -1 })
    .limit(100);

  const nameOf = new Map(mine.map((c) => [String(c._id), c.name]));
  res.json({
    success: true,
    polls: polls.map((p) => ({
      publicId: p.publicId,
      title: p.title,
      closesAt: p.closesAt,
      requireCode: p.requireCode,
      className: nameOf.get(String(p.classId)) || '',
    })),
  });
}));

// GET /api/polls/voted   → polls I voted in (SchoolLife accounts only)
router.get('/voted', protect, wrap(async (req, res) => {
  const rows = await PollVoter.find({ voterKey: `u:${req.user._id}` })
    .sort({ votedAt: -1 })
    .limit(50)
    .populate({ path: 'poll', select: 'title publicId status closesAt' });

  res.json({
    success: true,
    polls: rows
      .filter((r) => r.poll)
      .map((r) => ({
        publicId: r.poll.publicId,
        title: r.poll.title,
        status: effectiveStatus(r.poll),
        votedAt: r.votedAt,
      })),
  });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  OWNER
// ══════════════════════════════════════════════════════════════════════════════

const getOwnedPoll = async (req, res) => {
  if (!isId(req.params.id)) { fail(res, 400, 'Invalid poll id.'); return null; }
  const poll = await Poll.findById(req.params.id);
  if (!poll) { fail(res, 404, 'Poll not found.'); return null; }
  if (!isOwner(poll, req)) {
    fail(res, 403, 'Only the person who created this poll can do this.');
    return null;
  }
  return poll;
};

// A poll can be shared with a class the creator belongs to
const resolveClass = async (classId, userId) => {
  if (!classId) return { id: null };
  if (!userId) return { status: 403, error: 'Sharing with a class needs a SchoolLife account.' };
  if (!isId(classId)) return { status: 400, error: 'Invalid class.' };
  const cls = await Class.findById(classId);
  if (!cls || cls.kind === 'dm' || cls.archived) return { status: 404, error: 'Class not found.' };
  if (!cls.isActiveMember(userId)) {
    return { status: 403, error: 'You can only share a poll with a class you belong to.' };
  }
  return { id: cls._id };
};

const RESULT_MODES = ['live', 'afterVote', 'afterClose', 'private'];

// POST /api/polls/upload-signature   → short-lived permission to upload a candidate photo
const actorKey = (req) =>
  req.user
    ? String(req.user._id)
    : `g-${crypto.createHash('sha256').update(req.guest.email).digest('hex').slice(0, 12)}`;

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => actorKey(req),
  validate: false,
  message: { success: false, message: 'Too many uploads. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/upload-signature', identify, uploadLimiter, wrap(async (req, res) => {
  if (!isConfigured()) return fail(res, 503, 'File uploads are not set up yet.');
  res.json({ success: true, upload: signUpload(`polls-${actorKey(req)}`) });
}));

// POST /api/polls
// body: { title, description, kind?, questions, requireAccount, classOnly, classId,
//         requireCode, secretBallot, resultsVisibility, closesAt }
router.post('/', identify, wrap(async (req, res) => {
  const b = req.body;
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const kind = b.kind === 'election' ? 'election' : 'poll';

  if (title.length < 3 || title.length > 200) return fail(res, 400, 'The title must be 3 to 200 characters.');
  if (description.length > 2000) return fail(res, 400, 'The details can be at most 2000 characters.');

  const q = sanitizeQuestions(b.questions, kind, title);
  if (q.error) return fail(res, 400, q.error);

  const cls = await resolveClass(b.classId, userIdOf(req));
  if (cls.error) return fail(res, cls.status, cls.error);

  const classOnly = b.classOnly === true && !!cls.id;
  const requireAccount = b.requireAccount === true || classOnly;
  const requireCode = b.requireCode === true;
  const requireGmail = b.requireGmail === true && !requireAccount;
  // A class link only makes sense for account polls
  const classId = requireAccount ? cls.id : null;

  const deadline = parseDeadline(b.closesAt, null);
  if (deadline.error) return fail(res, 400, deadline.error);

  const maxPolls = req.user ? MAX_POLLS_PER_USER : 50; // guests get a smaller limit
  const opens = parseDeadline(b.opensAt, null, 'start time');
  if (opens.error) return fail(res, 400, opens.error);
  if (opens.value && deadline.value && opens.value.getTime() >= deadline.value.getTime()) {
    return fail(res, 400, 'The start time must be before the deadline.');
  }

  const count = await Poll.countDocuments(ownerFilter(req));
  if (count >= maxPolls) {
    return fail(res, 400, `You can have up to ${maxPolls} polls. Delete old ones first.`);
  }

  const poll = await Poll.create({
    ...ownerFields(req),
    classId,
    kind,
    title,
    description,
    questions: q.questions,
    requireAccount,
    classOnly: classOnly && !!classId,
    requireCode,
    requireGmail,
    opensAt: opens.value,
    code: requireCode ? makeCode() : '',
    secretBallot: b.secretBallot !== false,
    resultsVisibility: RESULT_MODES.includes(b.resultsVisibility)
      ? b.resultsVisibility
      : (kind === 'election' ? 'afterClose' : 'afterVote'),
    closesAt: deadline.value,
  });

  res.status(201).json({ success: true, poll: pollOut(poll, true) });
}));

// GET /api/polls/:id
router.get('/:id', identify, wrap(async (req, res) => {
  const poll = await getOwnedPoll(req, res);
  if (!poll) return;
  res.json({ success: true, poll: pollOut(poll, true) });
}));

// PUT /api/polls/:id
// Once somebody has voted, the question, options, who can vote and secrecy are
// locked (changing them would make the votes meaningless). The description,
// deadline and when results are shown can always change.
router.put('/:id', identify, wrap(async (req, res) => {
  const poll = await getOwnedPoll(req, res);
  if (!poll) return;

  const b = req.body;
  const locked = poll.voteCount > 0;

  if (b.description !== undefined) {
    const d = String(b.description).trim();
    if (d.length > 2000) return fail(res, 400, 'The details can be at most 2000 characters.');
    poll.description = d;
  }
  if (b.closesAt !== undefined) {
    const deadline = parseDeadline(b.closesAt, poll.closesAt);
    if (deadline.error) return fail(res, 400, deadline.error);
    poll.closesAt = deadline.value;
  }
  if (b.resultsVisibility !== undefined) {
    if (!RESULT_MODES.includes(b.resultsVisibility)) return fail(res, 400, 'Choose when results are shown.');
    poll.resultsVisibility = b.resultsVisibility;
  }

  const structural =
    b.title !== undefined || b.questions !== undefined || b.secretBallot !== undefined ||
    b.requireAccount !== undefined || b.requireCode !== undefined ||
    b.classOnly !== undefined || b.classId !== undefined ||
    b.requireGmail !== undefined || b.opensAt !== undefined;

  if (structural) {
    if (locked) {
      return fail(res, 409, 'People have already voted, so the question, options and voting rules cannot change.');
    }

    const title = b.title !== undefined ? String(b.title).trim() : poll.title;
    if (title.length < 3 || title.length > 200) return fail(res, 400, 'The title must be 3 to 200 characters.');

    if (b.questions !== undefined) {
      const q = sanitizeQuestions(b.questions, poll.kind, title);
      if (q.error) return fail(res, 400, q.error);
      poll.questions = q.questions;
    } else if (poll.kind === 'poll' && poll.questions[0]) {
      poll.questions[0].title = title;
    }
    poll.title = title;

    if (b.secretBallot !== undefined) poll.secretBallot = b.secretBallot !== false;

    const cls = await resolveClass(b.classId !== undefined ? b.classId : poll.classId, userIdOf(req));
    if (cls.error) return fail(res, cls.status, cls.error);

    const classOnly = (b.classOnly !== undefined ? b.classOnly === true : poll.classOnly) && !!cls.id;
    const requireAccount = (b.requireAccount !== undefined ? b.requireAccount === true : poll.requireAccount) || classOnly;
    const requireCode = b.requireCode !== undefined ? b.requireCode === true : poll.requireCode;

    poll.requireAccount = requireAccount;
    poll.classOnly = classOnly;
    poll.classId = requireAccount ? cls.id : null;
    if (requireCode && !poll.code) poll.code = makeCode();
    if (!requireCode) poll.code = '';
    poll.requireCode = requireCode;
    poll.requireGmail = (b.requireGmail !== undefined ? b.requireGmail === true : poll.requireGmail) && !requireAccount;

    if (b.opensAt !== undefined) {
      const o = parseDeadline(b.opensAt, poll.opensAt, 'start time');
      if (o.error) return fail(res, 400, o.error);
      poll.opensAt = o.value;
    }
    if (poll.opensAt && poll.closesAt && poll.opensAt.getTime() >= poll.closesAt.getTime()) {
      return fail(res, 400, 'The start time must be before the deadline.');
    }
  }

  await poll.save();
  res.json({ success: true, poll: pollOut(poll, true) });
}));

// POST /api/polls/:id/close
router.post('/:id/close', identify, wrap(async (req, res) => {
  const poll = await getOwnedPoll(req, res);
  if (!poll) return;
  poll.status = 'closed';
  poll.closedAt = new Date();
  await poll.save();
  res.json({ success: true, poll: pollOut(poll, true) });
}));

// POST /api/polls/:id/reopen  (a passed deadline is removed so it really opens)
router.post('/:id/reopen', identify, wrap(async (req, res) => {
  const poll = await getOwnedPoll(req, res);
  if (!poll) return;
  poll.status = 'open';
  poll.closedAt = null;
  if (poll.closesAt && poll.closesAt.getTime() <= Date.now()) poll.closesAt = null;
  await poll.save();
  res.json({ success: true, poll: pollOut(poll, true) });
}));

// POST /api/polls/:id/new-code  → a fresh code (the old one stops working)
router.post('/:id/new-code', identify, wrap(async (req, res) => {
  const poll = await getOwnedPoll(req, res);
  if (!poll) return;
  if (!poll.requireCode) return fail(res, 400, 'This poll does not use a code.');
  poll.code = makeCode();
  await poll.save();
  res.json({ success: true, code: poll.code });
}));

// GET /api/polls/:id/results   → the creator always sees the counts
router.get('/:id/results', identify, wrap(async (req, res) => {
  const poll = await getOwnedPoll(req, res);
  if (!poll) return;
  res.json({ success: true, results: await tally(poll) });
}));

// GET /api/polls/:id/voters   → who voted for what (only when votes are public)
router.get('/:id/voters', identify, wrap(async (req, res) => {
  const poll = await getOwnedPoll(req, res);
  if (!poll) return;
  if (poll.secretBallot) {
    return fail(res, 403, 'This is a secret ballot. Nobody can see who voted for what.');
  }

  const labelOf = new Map();
  for (const q of poll.questions) {
    for (const o of q.options) labelOf.set(`${q.id}:${o.id}`, o.label);
  }

  const votes = await PollVote.find({ poll: poll._id }).sort({ at: 1 }).limit(5000);
  res.json({
    success: true,
    voters: votes.map((v) => ({
      name: v.voterName || 'Guest',
      at: v.at,
      choices: v.answers.map((a) => ({
        questionId: a.questionId,
        options: a.optionIds.map((id) => labelOf.get(`${a.questionId}:${id}`) || ''),
      })),
    })),
  });
}));

// DELETE /api/polls/:id  → removes the poll and every vote
router.delete('/:id', identify, wrap(async (req, res) => {
  const poll = await getOwnedPoll(req, res);
  if (!poll) return;
  await Promise.all([
    PollVote.deleteMany({ poll: poll._id }),
    PollVoter.deleteMany({ poll: poll._id }),
  ]);
  await poll.deleteOne();
  res.json({ success: true });
}));

module.exports = router;