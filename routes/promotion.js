// routes/promotion.js
// Mounted from routes/academic.js, so every path starts with /api/academic.
const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const { protect: auth } = require('../middleware/auth');
const AcademicCalendar = require('../models/AcademicCalendar');
const PromotionRun = require('../models/PromotionRun');
const {
  planPromotion,
  executePromotion,
  undoRun,
  sessionEnd,
  dueFrom,
  UNDO_DAYS,
} = require('../jobs/promotion');

const DAY = 24 * 60 * 60 * 1000;

const requireSuperAdmin = (req, res, next) => {
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

async function loadCalendar(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ message: 'Calendar not found' });
    return null;
  }
  const cal = await AcademicCalendar.findById(req.params.id);
  if (!cal) {
    res.status(404).json({ message: 'Calendar not found' });
    return null;
  }
  return cal;
}

// ── GET /api/academic/calendars/:id/promotion/preview ────────────────────────
// Shows what promotion would do. Changes nothing.
router.get(
  '/calendars/:id/promotion/preview',
  auth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const cal = await loadCalendar(req, res);
      if (!cal) return;

      const plan = await planPromotion(cal);
      const end = sessionEnd(cal);

      res.json({
        preview: {
          school: cal.school,
          session: cal.session,
          // Nigerian-time calendar day of the session's last day
          endsOn: new Date(end + 60 * 60 * 1000).toISOString().slice(0, 10),
          dueAt: new Date(dueFrom(cal)),
          ended: Date.now() >= end,
          alreadyPromoted: !!cal.promotedAt,
          autoPromote: cal.autoPromote,
          stats: plan.stats,
          departments: plan.departments,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/academic/calendars/:id/promotion/run ───────────────────────────
// Runs the promotion now. Body must be { "confirm": true }.
router.post(
  '/calendars/:id/promotion/run',
  auth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({ message: 'Confirmation required' });
      }
      const cal = await loadCalendar(req, res);
      if (!cal) return;

      if (cal.promotedAt) {
        return res
          .status(409)
          .json({ message: 'Students were already promoted for this session.' });
      }
      if (Date.now() < sessionEnd(cal)) {
        return res
          .status(409)
          .json({ message: 'This session has not ended yet.' });
      }

      const result = await executePromotion(cal, {
        mode: 'manual',
        userId: req.user._id,
      });
      if (result.skipped) {
        return res.status(409).json({ message: result.reason });
      }
      res.json({
        message: 'Promotion complete',
        runId: result.runId,
        stats: result.stats,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/academic/promotions ─────────────────────────────────────────────
// Recent runs, newest first.
router.get('/promotions', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const runs = await PromotionRun.find()
      .select('-changes')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({
      runs: runs.map((r) => ({
        id: r._id,
        school: r.school,
        session: r.session,
        mode: r.mode,
        status: r.status,
        stats: r.stats,
        createdAt: r.createdAt,
        undoneAt: r.undoneAt,
        canUndo:
          !r.undoneAt &&
          r.status === 'done' &&
          Date.now() - r.createdAt.getTime() <= UNDO_DAYS * DAY,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/academic/promotions/:id/undo ───────────────────────────────────
router.post(
  '/promotions/:id/undo',
  auth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).json({ message: 'Promotion run not found' });
      }
      const result = await undoRun(req.params.id);
      if (result.error) {
        return res.status(409).json({ message: result.error });
      }
      res.json({ message: 'Promotion undone', reverted: result.reverted });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
