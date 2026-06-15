const express      = require('express');
const router       = express.Router();
const auth         = require('../middleware/auth');
const AdminRequest = require('../models/AdminRequest');
const User         = require('../models/User');
const FcmToken     = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

// ── Apply to become an admin (course rep) ───────────────────────────────
// POST /admin/request
router.post('/request', auth, async (req, res, next) => {
  try {
    const { school, faculty, department, level, reason, proofUrl } = req.body;
    if (!school || !faculty || !department || !level || !reason) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Check max 2 admins per dept/level
    const existingAdmins = await User.countDocuments({
      isAdmin: true,
      'profile.school':     school,
      'profile.faculty':    faculty,
      'profile.department': department,
      'profile.level':      level,
    });
    if (existingAdmins >= 2) {
      return res.status(400).json({
        message: 'This department/level already has 2 admins.',
      });
    }

    // Check no duplicate pending request
    const existing = await AdminRequest.findOne({
      user: req.user._id,
      status: 'pending',
    });
    if (existing) {
      return res.status(400).json({ message: 'You already have a pending request.' });
    }

    const request = await AdminRequest.create({
      user: req.user._id,
      school, faculty, department, level, reason,
      proofUrl: proofUrl || '',
    });

    res.status(201).json({ message: 'Request submitted', request });
  } catch (err) {
    next(err);
  }
});

// ── Check own admin request status ──────────────────────────────────────
// GET /admin/status
router.get('/status', auth, async (req, res, next) => {
  try {
    const request = await AdminRequest.findOne({ user: req.user._id })
      .sort({ createdAt: -1 });
    const isAdmin = req.user.isAdmin || false;
    res.json({ isAdmin, request });
  } catch (err) {
    next(err);
  }
});

// ── Get all pending requests (super admin only) ──────────────────────────
// GET /admin/pending
router.get('/pending', auth, async (req, res, next) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const requests = await AdminRequest.find({ status: 'pending' })
      .populate('user', 'email profile');
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

// ── Approve or reject a request (super admin only) ──────────────────────
// PUT /admin/review/:id
router.put('/review/:id', auth, async (req, res, next) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { status, reviewNote } = req.body; // status: 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const request = await AdminRequest.findById(req.params.id).populate('user');
    if (!request) return res.status(404).json({ message: 'Request not found' });

    request.status     = status;
    request.reviewNote = reviewNote || '';
    request.reviewedBy = req.user._id;
    request.updatedAt  = new Date();
    await request.save();

    if (status === 'approved') {
      await User.findByIdAndUpdate(request.user._id, {
        isAdmin:             true,
        'profile.school':     request.school,
        'profile.faculty':    request.faculty,
        'profile.department': request.department,
        'profile.level':      request.level,
      });

      // Notify the approved user
      const fcmDoc = await FcmToken.findOne({ user: request.user._id });
      if (fcmDoc?.token) {
        await sendToTokens(
          [fcmDoc.token],
          '🎉 Admin Request Approved',
          'You are now a course rep admin for your department.',
          { type: 'admin_approved' }
        );
      }
    } else {
      // Notify rejection
      const fcmDoc = await FcmToken.findOne({ user: request.user._id });
      if (fcmDoc?.token) {
        await sendToTokens(
          [fcmDoc.token],
          'Admin Request Update',
          reviewNote || 'Your admin request was not approved.',
          { type: 'admin_rejected' }
        );
      }
    }

    res.json({ message: `Request ${status}`, request });
  } catch (err) {
    next(err);
  }
});

module.exports = router;