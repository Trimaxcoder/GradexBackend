// routes/announcements.js
const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');
const Announcement = require('../models/Announcement');
const FcmToken     = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

// ── POST /api/announcements  (admin only) ────────────────────────────────────
// Sends a push to every student in the same school/faculty/dept/level (or all
// levels) and persists the announcement so the app can fetch it as a feed.
router.post('/', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { title, message, level } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Title is required' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'Message is required' });
    }

    // Pull scope from the admin's own verified profile (same pattern as /request)
    const { school, faculty, department } = req.user.profile || {};
    if (!school || !faculty || !department) {
      return res.status(400).json({
        message: 'Your profile must have school, faculty and department set',
      });
    }

    // "all" means every level in this dept, otherwise target one level
    const targetLevel = level && level !== 'all' ? level : null;

    // ── 1. Persist the announcement ──────────────────────────────────────────
    const announcement = await Announcement.create({
      admin:      req.user._id,
      adminName:  req.user.profile.name || req.user.email,
      school,
      faculty,
      department,
      level:      targetLevel || 'all',
      title:      title.trim(),
      message:    message.trim(),
    });

    // ── 2. Find FCM tokens in scope ──────────────────────────────────────────
    const tokenQuery = {
      school,
      faculty,
      department,
      enabled: true,
    };
    if (targetLevel) tokenQuery.level = targetLevel;

    const fcmDocs = await FcmToken.find(tokenQuery).select('token');
    const tokens  = fcmDocs.map(d => d.token).filter(Boolean);

    // ── 3. Push (fire-and-forget, don't fail the request if FCM errors) ──────
    if (tokens.length > 0) {
      sendToTokens(
        tokens,
        `📢 ${title.trim()}`,
        message.trim(),
        {
          type:           'announcement',
          announcementId: announcement._id.toString(),
        },
      ).catch(err =>
        console.error('[announcements] FCM sendToTokens error:', err),
      );
    }

    res.status(201).json({
      message:      'Announcement sent',
      announcement,
      notifiedCount: tokens.length,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/announcements  (any logged-in user) ─────────────────────────────
// Returns announcements scoped to the caller's school/faculty/dept/level.
router.get('/', auth, async (req, res, next) => {
  try {
    const { school, faculty, department, level } = req.user.profile || {};
    if (!school || !faculty || !department) {
      return res.json({ announcements: [] });
    }

    const announcements = await Announcement.find({
      school,
      faculty,
      department,
      level: { $in: [level, 'all'] },   // their specific level OR broadcast
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('-__v');

    res.json({ announcements });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/announcements/:id  (admin, own announcements only) ───────────
router.delete('/:id', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }
    if (announcement.admin.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only delete your own announcements' });
    }

    await announcement.deleteOne();
    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;