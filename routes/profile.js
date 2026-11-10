const express = require('express');
const { body, validationResult } = require('express-validator');
const User     = require('../models/User');
const Course   = require('../models/Course');
const FcmToken = require('../models/FcmToken');
const Carryover = require('../models/Carryover');
const { protect } = require('../middleware/auth');
const { norm, levelNum } = require('../utils/repRequest');

const router = express.Router();

// All routes are protected
router.use(protect);

const CLASS_FIELDS = ['school', 'faculty', 'department', 'level'];

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

      const current = req.user.profile || {};

      // A class rep manages one class. To move to another school, faculty,
      // department or level they must resign as rep first (the app offers this).
      if (req.user.isAdmin) {
        const changed = CLASS_FIELDS.filter(
          (f) => req.body[f] !== undefined && norm(req.body[f]) !== norm(current[f])
        );
        if (changed.length > 0) {
          const s = req.user.adminScope || {};
          return res.status(409).json({
            success: false,
            code: 'ADMIN_MUST_RESIGN',
            fields: changed,
            message: `You are the class rep for ${s.department || current.department} ${s.level || current.level} level. Resign as rep before changing your ${changed.join(', ')}.`,
          });
        }
      }

      const allowed = ['name', 'matricNumber', 'department', 'faculty', 'email', 'school', 'level'];
      const updates = {};
      allowed.forEach((field) => {
        if (req.body[field] !== undefined) updates[`profile.${field}`] = req.body[field];
      });

      // Last level before graduation (optional; empty clears it)
      if (req.body.finalLevel !== undefined) {
        const fl = String(req.body.finalLevel).trim();
        if (fl !== '') {
          const flNum = levelNum(fl);
          if (flNum === null) {
            return res.status(400).json({
              success: false,
              message: 'Last level before graduation must be 100, 200 … up to 700.',
            });
          }
          const lvlNum = levelNum(req.body.level !== undefined ? req.body.level : current.level);
          if (lvlNum !== null && flNum < lvlNum) {
            return res.status(400).json({
              success: false,
              message: 'Your last level cannot be lower than your current level.',
            });
          }
        }
        updates['profile.finalLevel'] = fl;
      }

      const levelChanged =
        updates['profile.level'] !== undefined &&
        updates['profile.level'] !== current.level;

      if (levelChanged) {
        // Correcting your own level means you are no longer "graduated"
        // (this is how anyone fixes a wrong automatic promotion).
        updates['profile.graduated'] = false;

        // A last level below the new level no longer makes sense; clear it
        // so the system falls back to the department's.
        const newLevel = levelNum(updates['profile.level']);
        const finalNow = levelNum(
          updates['profile.finalLevel'] !== undefined
            ? updates['profile.finalLevel']
            : current.finalLevel
        );
        if (newLevel !== null && finalNow !== null && finalNow < newLevel) {
          updates['profile.finalLevel'] = '';
        }
      }

      // Worked out BEFORE saving, from the profile as it was
      const deptMoved = ['school', 'faculty', 'department'].some(
        (f) => updates[`profile.${f}`] !== undefined && norm(updates[`profile.${f}`]) !== norm(current[f])
      );

      const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      // Carry-over courses belong to a department and sit below the student's
      // level: moving department clears them; lowering the level drops any that
      // are no longer below it.
      if (deptMoved) {
        await Carryover.deleteMany({ user: user._id });
      } else if (levelChanged) {
        const n = levelNum(updates['profile.level']);
        if (n !== null) {
          const notBelow = ['100', '200', '300', '400', '500', '600', '700'].filter(
            (l) => levelNum(l) >= n
          );
          await Carryover.deleteMany({ user: user._id, level: { $in: notBelow } });
        }
      }

      // Keep the notification scope in step with the profile, so class
      // pushes follow a changed school / department / level straight away.
      const p = user.profile || {};
      await FcmToken.updateOne(
        { user: user._id },
        {
          $set: {
            school: p.school || '',
            faculty: p.faculty || '',
            department: p.department || '',
            level: p.graduated ? '' : p.level || '',
            updatedAt: new Date(),
          },
        }
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
// Deletes the account, all its courses and its push token (so the phone
// stops getting class notifications for an account that no longer exists)
router.delete('/', async (req, res, next) => {
  try {
    await Course.deleteMany({ userId: req.user._id });
    await FcmToken.deleteMany({ user: req.user._id });
    await Carryover.deleteMany({ user: req.user._id });
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
