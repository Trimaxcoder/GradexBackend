// routes/announcements.js — FULL FILE (replaces the old one)
const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const { protect: auth } = require('../middleware/auth');
const {
  resolvePostTarget,
  canModify,
  feedFilter,
} = require('../middleware/announcementPermissions');
const Announcement = require('../models/Announcement');
const FcmToken     = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');
const { ensureAdminScope } = require('../utils/adminScope');

const TITLE_MAX   = 120;
const MESSAGE_MAX = 2000;
const PAGE_DEFAULT = 20;
const PAGE_MAX     = 50;
const FCM_BATCH    = 500; // FCM multicast limit per send

// ── Helpers ──────────────────────────────────────────────────────────────────

// Reject malformed ids early instead of letting Mongoose throw a CastError.
router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: 'Announcement not found' });
  }
  next();
});

// Everyone an announcement should reach, based on the announcement itself.
async function tokensFor(announcement) {
  const query = { enabled: true };

  if (announcement.scope !== 'global') {
    query.school     = announcement.school;
    query.faculty    = announcement.faculty;
    query.department = announcement.department;
    // Legacy department-wide ('all') announcements have no level filter.
    if (announcement.level && announcement.level !== 'all') {
      query.level = announcement.level;
    }
  }

  const docs = await FcmToken.find(query).select('token');
  return [...new Set(docs.map((d) => d.token).filter(Boolean))];
}

// Send in batches of 500. One failed batch never blocks the rest.
async function pushInBatches(tokens, title, body, data) {
  for (let i = 0; i < tokens.length; i += FCM_BATCH) {
    try {
      await sendToTokens(tokens.slice(i, i + FCM_BATCH), title, body, data);
    } catch (err) {
      console.error('[announcements] FCM batch failed:', err);
    }
  }
}

function notify(announcement, tokens, titlePrefix = '📢') {
  if (tokens.length === 0) return;
  pushInBatches(
    tokens,
    `${titlePrefix} ${announcement.title}`,
    announcement.message,
    {
      type: 'announcement',
      scope: announcement.scope,
      announcementId: announcement._id.toString(),
    },
  ).catch((err) => console.error('[announcements] FCM error:', err));
}

function validateText(title, message, { partial = false } = {}) {
  const check = (value, label, max) => {
    if (value === undefined && partial) return null;
    if (typeof value !== 'string' || !value.trim()) {
      return `${label} is required`;
    }
    if (value.trim().length > max) {
      return `${label} must be ${max} characters or fewer`;
    }
    return null;
  };
  return check(title, 'Title', TITLE_MAX) || check(message, 'Message', MESSAGE_MAX);
}

// ── POST /api/announcements ──────────────────────────────────────────────────
// body: { title, message, scope? }  scope: 'global' (superadmin) | 'class' (rep)
// The target class is NEVER read from the body.
router.post('/', auth, async (req, res, next) => {
  try {
    const { title, message, scope } = req.body;

    await ensureAdminScope(req.user);
    const permission = resolvePostTarget(req.user, scope);
    if (!permission.ok) {
      return res.status(permission.status).json({ message: permission.message });
    }

    const invalid = validateText(title, message);
    if (invalid) return res.status(400).json({ message: invalid });

    const { target } = permission;

    const announcement = await Announcement.create({
      ...target,
      admin: req.user._id,
      adminName:
        target.scope === 'global'
          ? 'SchoolLife'
          : req.user.profile?.name || req.user.email,
      title: title.trim(),
      message: message.trim(),
    });

    const tokens = await tokensFor(announcement);
    notify(announcement, tokens);

    res.status(201).json({
      message: 'Announcement sent',
      announcement,
      notifiedCount: tokens.length,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/announcements ───────────────────────────────────────────────────
// Query: ?scope=global|class (optional), ?limit=20, ?before=<ISO date>
// Returns { announcements, hasMore, nextCursor } — pass nextCursor as `before`.
router.get('/', auth, async (req, res, next) => {
  try {
    const { scope, before } = req.query;
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || PAGE_DEFAULT, 1),
      PAGE_MAX,
    );

    const conditions = [feedFilter(req.user)];

    if (scope === 'global') conditions.push({ scope: 'global' });
    if (scope === 'class')  conditions.push({ scope: { $ne: 'global' } });

    if (before) {
      const cursor = new Date(before);
      if (Number.isNaN(cursor.getTime())) {
        return res.status(400).json({ message: 'Invalid cursor' });
      }
      conditions.push({ createdAt: { $lt: cursor } });
    }

    // Fetch one extra to know whether another page exists.
    const rows = await Announcement.find({ $and: conditions })
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .select('-__v');

    const hasMore = rows.length > limit;
    const announcements = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? announcements[announcements.length - 1].createdAt.toISOString()
      : null;

    res.json({ announcements, hasMore, nextCursor });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/announcements/mine  (reps and superadmin: what they posted) ─────
// Defined before /:id so "mine" isn't treated as an id.
router.get('/mine', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin && !req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const announcements = await Announcement.find({ admin: req.user._id })
      .sort({ createdAt: -1 })
      .select('-__v');

    res.json({ announcements });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/announcements/:id  (opened from a push notification) ───────────
// Only returns it if this user is actually allowed to see it.
router.get('/:id', auth, async (req, res, next) => {
  try {
    const announcement = await Announcement.findOne({
      $and: [{ _id: req.params.id }, feedFilter(req.user)],
    }).select('-__v');

    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }
    res.json({ announcement });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/announcements/:id ───────────────────────────────────────────────
// Silent edit by default. Send resend: true to notify again.
router.put('/:id', auth, async (req, res, next) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }
    if (!canModify(req.user, announcement, 'edit')) {
      return res
        .status(403)
        .json({ message: 'You are not allowed to edit this announcement' });
    }

    const { title, message, resend } = req.body;

    if (title === undefined && message === undefined) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    const invalid = validateText(title, message, { partial: true });
    if (invalid) return res.status(400).json({ message: invalid });

    if (title !== undefined)   announcement.title   = title.trim();
    if (message !== undefined) announcement.message = message.trim();
    announcement.editedAt = new Date();
    await announcement.save();

    if (resend === true) {
      const tokens = await tokensFor(announcement);
      notify(announcement, tokens, '📢 (Updated)');
    }

    res.json({ message: 'Announcement updated', announcement });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/announcements/:id ────────────────────────────────────────────
// Hard delete: retracts it for everyone.
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }
    if (!canModify(req.user, announcement, 'delete')) {
      return res
        .status(403)
        .json({ message: 'You are not allowed to delete this announcement' });
    }

    await announcement.deleteOne();
    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;