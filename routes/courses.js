const express = require("express");
const { body, param, validationResult } = require("express-validator");
const Course = require("../models/Course");
const { protect } = require("../middleware/auth");

const router = express.Router();

// All routes are protected
router.use(protect);

// ── GET /api/courses ──────────────────────────────────────────────────────────
// Optional query params: ?year=1&semester=2
router.get("/", async (req, res, next) => {
  try {
    const filter = { userId: req.user._id };
    if (req.query.year) filter.year = Number(req.query.year);
    if (req.query.semester) filter.semester = Number(req.query.semester);

    const courses = await Course.find(filter).sort({
      year: 1,
      semester: 1,
      createdAt: 1,
    });
    res.json({ success: true, count: courses.length, courses });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/courses ─────────────────────────────────────────────────────────
const courseValidators = [
  body("name").notEmpty().withMessage("Course name/code is required").trim(),
  body("score").isInt({ min: 0, max: 100 }).withMessage("Score must be 0–100"),
  body("unit").isInt({ min: 1, max: 6 }).withMessage("Unit must be 1–6"),
  body("year").isInt({ min: 1, max: 7 }).withMessage("Year must be 1–7"),
  body("semester")
    .isInt({ min: 1, max: 2 })
    .withMessage("Semester must be 1 or 2"),
];

router.post("/", courseValidators, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, title, score, unit, year, semester, clientId } = req.body;

    const course = await Course.create({
      userId: req.user._id,
      clientId: clientId || "",
      name,
      title: title || "",
      score,
      unit,
      year,
      semester,
    });

    res.status(201).json({ success: true, course });
  } catch (err) {
    // Duplicate → still return the existing document
    if (err.code === 11000) {
      const existing = await Course.findOne({
        userId: req.user._id,
        name: req.body.name?.toUpperCase(),
        unit: req.body.unit,
        year: req.body.year,
        semester: req.body.semester,
      });
      return res.status(409).json({
        success: false,
        message: "Course already exists for this semester.",
        course: existing,
      });
    }
    next(err);
  }
});

// ── PUT /api/courses/:id ──────────────────────────────────────────────────────
router.put(
  "/:id",
  [
    param("id").isMongoId().withMessage("Invalid course ID"),
    ...courseValidators,
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const course = await Course.findOneAndUpdate(
        { _id: req.params.id, userId: req.user._id }, // ownership check
        {
          name: req.body.name,
          title: req.body.title || "",
          score: req.body.score,
          unit: req.body.unit,
          year: req.body.year,
          semester: req.body.semester,
        },
        { new: true, runValidators: true },
      );

      if (!course) {
        return res.status(404).json({
          success: false,
          message: "Course not found or access denied.",
        });
      }

      res.json({ success: true, course });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/courses/:id ───────────────────────────────────────────────────
router.delete(
  "/:id",
  [param("id").isMongoId().withMessage("Invalid course ID")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const course = await Course.findOneAndDelete({
        _id: req.params.id,
        userId: req.user._id,
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          message: "Course not found or access denied.",
        });
      }

      res.json({
        success: true,
        message: "Course deleted.",
        courseId: req.params.id,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/courses ───────────────────────────────────────────────────────
// Wipe all courses for this user
router.delete("/", async (req, res, next) => {
  try {
    const result = await Course.deleteMany({ userId: req.user._id });
    res.json({
      success: true,
      message: `${result.deletedCount} course(s) deleted.`,
      deleted: result.deletedCount,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/courses/sync ────────────────────────────────────────────────────
router.post("/sync", async (req, res, next) => {
  try {
    const { courses: localCourses, deletedServerIds } = req.body;
    console.log("=== SYNC deletedServerIds received:", deletedServerIds);
    console.log("=== SYNC localCourses count:", localCourses?.length);

    if (!Array.isArray(localCourses)) {
      return res.status(400).json({
        success: false,
        message: '"courses" must be an array',
      });
    }

    // Delete courses that were deleted on the client
    if (Array.isArray(deletedServerIds) && deletedServerIds.length > 0) {
      await Course.deleteMany({
        _id: { $in: deletedServerIds },
        userId: req.user._id,
      });
    }

    // Only insert courses that have NO serverId (brand new local courses)
    const serverCourses = await Course.find({ userId: req.user._id });
    const serverIds = new Set(serverCourses.map((c) => c._id.toString()));

    const toInsert = localCourses.filter((c) => {
      // Skip if it already has a serverId — it exists on server already
      if (c.serverId) return false;
      // Skip if matching by name/unit/year/semester
      const key = `${(c.name || "").toUpperCase()}_${c.unit}_${c.year}_${c.semester}`;
      const serverKeys = new Set(
        serverCourses.map((s) => `${s.name}_${s.unit}_${s.year}_${s.semester}`),
      );
      return !serverKeys.has(key);
    });

    let inserted = 0;
    for (const c of toInsert) {
      try {
        await Course.create({
          userId: req.user._id,
          clientId: c.id || "",
          name: c.name,
          title: c.title || "",
          score: c.score,
          unit: c.unit,
          year: c.year,
          semester: c.semester,
        });
        inserted++;
      } catch (e) {
        if (e.code !== 11000) console.error("Sync insert error:", e.message);
      }
    }

    // Return the complete authoritative list
    const allCourses = await Course.find({ userId: req.user._id }).sort({
      year: 1,
      semester: 1,
      createdAt: 1,
    });

    res.json({
      success: true,
      inserted,
      total: allCourses.length,
      courses: allCourses,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
