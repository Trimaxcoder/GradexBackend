const express      = require('express');
const router       = express.Router();
const { protect: auth } = require('../middleware/auth');
const AdminRequest = require('../models/AdminRequest');
const User         = require('../models/User');
const FcmToken     = require('../models/FcmToken');
const { sendToTokens } = require('../config/firebase');

// POST /api/admin/request
router.post('/request', auth, async (req, res, next) => {
  try {
    const { reason } = req.body;

    // 1. Validate reason
    if (!reason || reason.trim().length < 20) {
      return res.status(400).json({
        message: 'Please provide a reason of at least 20 characters',
      });
    }

    // 2. Pull profile from DB (prevents spoofing)
    const { school, faculty, department, level } = req.user.profile || {};

    if (!school || !faculty || !department || !level) {
      return res.status(400).json({
        message: 'Please complete your profile (school, faculty, department, level) before requesting admin access',
      });
    }

    // 3. Max 2 admins per dept/level
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

    // 4. No duplicate pending request
    const existing = await AdminRequest.findOne({
      user: req.user._id,
      status: 'pending',
    });
    if (existing) {
      return res.status(400).json({
        message: 'You already have a pending request.',
      });
    }

    // 5. Create using verified DB profile data
    const request = await AdminRequest.create({
      user: req.user._id,
      school, faculty, department, level,
      reason: reason.trim(),
      proofUrl: '',
    });

    res.status(201).json({ message: 'Request submitted', request });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/status
router.get('/status', auth, async (req, res, next) => {
  try {
    const request = await AdminRequest.findOne({ user: req.user._id })
      .sort({ createdAt: -1 });
    const isAdmin = req.user.isAdmin || false;
    const isSuperAdmin = req.user.isSuperAdmin || false;
    res.json({ isAdmin, isSuperAdmin, request });
    res.json({ isAdmin, request });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/pending (super admin only)
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

// PUT /api/admin/review/:id (super admin only)
router.put('/review/:id', auth, async (req, res, next) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { status, reviewNote } = req.body;
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
        isAdmin:              true,
        'profile.school':     request.school,
        'profile.faculty':    request.faculty,
        'profile.department': request.department,
        'profile.level':      request.level,
      });

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