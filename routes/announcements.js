// routes/announcements.js  — FULL FILE (adds PUT edit route)
const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');
const Announcement = require('../models/Announcement');
const FcmToken     = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

// ── POST /api/announcements  (admin only) ────────────────────────────────────
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

    const { school, faculty, department } = req.user.profile || {};
    if (!school || !faculty || !department) {
      return res.status(400).json({
        message: 'Your profile must have school, faculty and department set',
      });
    }

    const targetLevel = level && level !== 'all' ? level : null;

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

    const tokenQuery = { school, faculty, department, enabled: true };
    if (targetLevel) tokenQuery.level = targetLevel;

    const fcmDocs = await FcmToken.find(tokenQuery).select('token');
    const tokens  = fcmDocs.map(d => d.token).filter(Boolean);

    if (tokens.length > 0) {
      sendToTokens(
        tokens,
        `📢 ${title.trim()}`,
        message.trim(),
        { type: 'announcement', announcementId: announcement._id.toString() },
      ).catch(err =>
        console.error('[announcements] FCM sendToTokens error:', err),
      );
    }

    res.status(201).json({
      message: 'Announcement sent',
      announcement,
      notifiedCount: tokens.length,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/announcements  (any logged-in user) ─────────────────────────────
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
      level: { $in: [level, 'all'] },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('-__v');

    res.json({ announcements });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/announcements/mine  (admin — their own sent announcements) ─────
router.get('/mine', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
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

// ── PUT /api/announcements/:id  (admin, own announcements only) ─────────────
// Edits title/message. Does NOT re-send a push notification — it's a silent
// correction. Set resend=true in body if you want it to notify again.
router.put('/:id', auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }
    if (announcement.admin.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only edit your own announcements' });
    }

    const { title, message, resend } = req.body;

    if (title !== undefined) {
      if (!title.trim()) {
        return res.status(400).json({ message: 'Title cannot be empty' });
      }
      announcement.title = title.trim();
    }
    if (message !== undefined) {
      if (!message.trim()) {
        return res.status(400).json({ message: 'Message cannot be empty' });
      }
      announcement.message = message.trim();
    }
    announcement.editedAt = new Date();
    await announcement.save();

    // Optional: re-notify (off by default — most edits are typo fixes)
    if (resend === true) {
      const tokenQuery = {
        school: announcement.school,
        faculty: announcement.faculty,
        department: announcement.department,
        enabled: true,
      };
      if (announcement.level !== 'all') tokenQuery.level = announcement.level;

      const fcmDocs = await FcmToken.find(tokenQuery).select('token');
      const tokens  = fcmDocs.map(d => d.token).filter(Boolean);

      if (tokens.length > 0) {
        sendToTokens(
          tokens,
          `📢 (Updated) ${announcement.title}`,
          announcement.message,
          { type: 'announcement', announcementId: announcement._id.toString() },
        ).catch(err =>
          console.error('[announcements] FCM resend error:', err),
        );
      }
    }

    res.json({ message: 'Announcement updated', announcement });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/announcements/:id  (admin, own announcements only) ───────────
// This is a HARD delete — removes it for everyone, since the admin is
// retracting it entirely (e.g. posted by mistake, wrong info).
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