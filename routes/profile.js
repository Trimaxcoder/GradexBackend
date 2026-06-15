const express = require('express');
const { body, validationResult } = require('express-validator');
const User    = require('../models/User');
const Course  = require('../models/Course');
const { protect } = require('../middleware/auth');

const router = express.Router();

// All routes are protected
router.use(protect);

// ── GET /api/profile ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({ success: true, profile: req.user.profile });
});

// ── PUT /api/profile ──────────────────────────────────────────────────────────
router.put(
  '/',
  [
    body('name').optional().notEmpty().withMessage('Name cannot be empty'),
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('matricNumber').optional().notEmpty().withMessage('Matric number cannot be empty'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const allowed = ['name', 'matricNumber', 'department', 'faculty', 'email', 'school', 'level'];
      const updates = {};
      allowed.forEach((field) => {
        if (req.body[field] !== undefined) updates[`profile.${field}`] = req.body[field];
      });

      const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      res.json({ success: true, profile: user.profile });
    } catch (err) {
      next(err);
    }
  }
);

// ── PUT /api/profile/grading ──────────────────────────────────────────────────
router.put('/grading', async (req, res, next) => {
  try {
    const { rules } = req.body;
    if (!Array.isArray(rules) || rules.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'rules must be a non-empty array',
      });
    }

    // Basic rule shape validation
    for (const r of rules) {
      if (!r.grade || r.minScore == null || r.gradePoint == null) {
        return res.status(400).json({
          success: false,
          message: 'Each rule must have grade, minScore, and gradePoint',
        });
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { grading: { rules } } },
      { new: true }
    );

    res.json({ success: true, grading: user.grading });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/profile ───────────────────────────────────────────────────────
// Deletes the account AND all associated courses
router.delete('/', async (req, res, next) => {
  try {
    await Course.deleteMany({ userId: req.user._id });
    await User.findByIdAndDelete(req.user._id);
    res.json({ success: true, message: 'Account and all data permanently deleted.' });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/profile/change-password ─────────────────────────────────────────
router.put(
  '/change-password',
  [
    body('currentPassword').notEmpty().withMessage('Current password required'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('New password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const user = await User.findById(req.user._id).select('+password');
      if (!(await user.comparePassword(req.body.currentPassword))) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect.',
        });
      }

      user.password = req.body.newPassword;
      await user.save();

      res.json({ success: true, message: 'Password changed successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
