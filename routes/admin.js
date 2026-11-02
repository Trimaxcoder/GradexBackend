const express = require("express");
const router = express.Router();
const { protect: auth } = require("../middleware/auth");
const AdminRequest = require("../models/AdminRequest");
const User = require("../models/User");
const FcmToken = require("../models/FcmToken");
const { sendToTokens } = require("../config/firebase");
const { sendMorningDigests } = require("../jobs/morningDigest");
const { ensureAdminScope } = require("../utils/adminScope");
const { getTermState } = require("../utils/academicTerm");
const {
  norm,
  normMatric,
  sameClass,
  validateRepRequest,
} = require("../utils/repRequest");

const MAX_REPS_PER_CLASS = 2;

const requireSuperAdmin = (req, res, next) => {
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactCI = (s) =>
  new RegExp("^\\s*" + escapeRe(String(s).trim()) + "\\s*$", "i");

/** How many reps a class already has (older reps without a saved class count too). */
async function countClassAdmins(scope, excludeUserId = null) {
  const base = { isAdmin: true };
  if (excludeUserId) base._id = { $ne: excludeUserId };
  return User.countDocuments({
    ...base,
    $or: [
      {
        "adminScope.school": scope.school,
        "adminScope.faculty": scope.faculty,
        "adminScope.department": scope.department,
        "adminScope.level": scope.level,
      },
      {
        adminScope: { $exists: false },
        "profile.school": scope.school,
        "profile.faculty": scope.faculty,
        "profile.department": scope.department,
        "profile.level": scope.level,
      },
    ],
  });
}

/** The checklist the super admin sees on each pending request. */
async function buildChecks(r) {
  const u = r.user || {};
  const p = u.profile || {};

  let calendarSemester = null;
  let termStatus = "unconfigured";
  if (r.school) {
    const state = await getTermState(r.school);
    termStatus = state.status;
    calendarSemester =
      state.status === "active"
        ? state.current.semester
        : state.upcoming
          ? state.upcoming.semester
          : null;
  }

  const classAdmins = await countClassAdmins(r, u._id);

  let duplicateMatric = false;
  if (p.matricNumber && p.school) {
    const n = await User.countDocuments({
      _id: { $ne: u._id },
      "profile.matricNumber": exactCI(p.matricNumber),
      "profile.school": exactCI(p.school),
    });
    duplicateMatric = n > 0;
  }

  return {
    nameMatches: norm(r.fullName) === norm(p.name),
    matricMatches: normMatric(r.matricNumber) === normMatric(p.matricNumber),
    profileClassMatches: sameClass(r, p),
    semester: {
      declared: r.semester ?? null,
      calendar: calendarSemester,
      matches:
        calendarSemester == null || r.semester == null
          ? null
          : r.semester === calendarSemester,
      termStatus,
    },
    classAdmins,
    duplicateMatric,
  };
}

// POST /api/admin/request
// The student confirms their details; the server checks them against the profile.
router.post("/request", auth, async (req, res, next) => {
  try {
    const checked = validateRepRequest(req.user.profile, req.body);
    if (checked.error) {
      return res.status(400).json({ message: checked.error });
    }
    const v = checked.values;
    const { school, faculty, department } = req.user.profile;

    // No duplicate pending/approved request
    const existing = await AdminRequest.findOne({
      user: req.user._id,
      status: { $in: ["pending", "approved"] },
    });
    if (existing) {
      return res.status(400).json({
        message:
          existing.status === "approved"
            ? "You are already an admin."
            : "You already have a pending request.",
      });
    }

    // A class can have at most 2 reps
    const reps = await countClassAdmins({
      school,
      faculty,
      department,
      level: v.level,
    });
    if (reps >= MAX_REPS_PER_CLASS) {
      return res.status(400).json({
        message: "This department/level already has 2 admins.",
      });
    }

    const request = await AdminRequest.create({
      user: req.user._id,
      school,
      faculty,
      department,
      level: v.level,
      fullName: v.fullName,
      matricNumber: v.matricNumber,
      semester: v.semester,
      finalLevel: v.finalLevel,
      reason: v.reason,
      proofUrl: "",
    });

    res.status(201).json({ message: "Request submitted", request });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/status
router.get("/status", auth, async (req, res, next) => {
  try {
    await ensureAdminScope(req.user);
    const request = await AdminRequest.findOne({ user: req.user._id }).sort({
      createdAt: -1,
    });
    const isAdmin = req.user.isAdmin || false;
    const isSuperAdmin = req.user.isSuperAdmin || false;
    res.json({
      isAdmin,
      isSuperAdmin,
      request,
      adminScope: req.user.adminScope || null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/pending (super admin only)
router.get("/pending", auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rows = await AdminRequest.find({ status: "pending" })
      .populate("user", "email profile isAdmin")
      .sort({ createdAt: 1 })
      .lean();

    const requests = [];
    for (const r of rows) {
      if (!r.user) continue; // the student deleted their account
      requests.push({ ...r, checks: await buildChecks(r) });
    }
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/review/:id (super admin only)
router.put("/review/:id", auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { status, reviewNote } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const request = await AdminRequest.findById(req.params.id).populate("user");
    if (!request) return res.status(404).json({ message: "Request not found" });
    if (request.status !== "pending") {
      return res.status(409).json({ message: "This request was already reviewed." });
    }
    if (!request.user) {
      return res.status(409).json({ message: "This student no longer exists." });
    }

    if (status === "approved") {
      const student = request.user;
      const p = student.profile || {};

      if (student.isAdmin) {
        return res.status(409).json({ message: "This student is already an admin." });
      }
      // The class on the request must still be the student's class
      if (!sameClass(request, p)) {
        return res.status(409).json({
          message: `The student's profile changed since they applied (now ${p.department || "?"}, ${p.level || "?"} level). Reject this request and ask them to apply again.`,
        });
      }
      const reps = await countClassAdmins(request, student._id);
      if (reps >= MAX_REPS_PER_CLASS) {
        return res.status(409).json({ message: "This class already has 2 reps." });
      }
    }

    request.status = status;
    request.reviewNote = reviewNote || "";
    request.reviewedBy = req.user._id;
    request.updatedAt = new Date();
    await request.save();

    const fcmDoc = await FcmToken.findOne({ user: request.user._id });

    if (status === "approved") {
      const update = {
        isAdmin: true,
        // The class they manage is fixed here, by the super admin
        adminScope: {
          school: request.school,
          faculty: request.faculty,
          department: request.department,
          level: request.level,
        },
      };
      if (request.finalLevel) update["profile.finalLevel"] = request.finalLevel;
      await User.findByIdAndUpdate(request.user._id, update);

      if (fcmDoc?.token) {
        await sendToTokens(
          [fcmDoc.token],
          "🎉 Admin Request Approved",
          "You are now a course rep admin for your department.",
          { type: "admin_approved" },
        );
      }
    } else if (fcmDoc?.token) {
      await sendToTokens(
        [fcmDoc.token],
        "Admin Request Update",
        reviewNote || "Your admin request was not approved.",
        { type: "admin_rejected" },
      );
    }

    res.json({ message: `Request ${status}`, request });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/resign — admin resigns themselves
router.post("/resign", auth, async (req, res, next) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(400).json({ message: "You are not an admin." });
    }

    // Remove admin rights and the class they managed
    await User.findByIdAndUpdate(req.user._id, {
      isAdmin: false,
      $unset: { adminScope: 1 },
    });

    await AdminRequest.findOneAndUpdate(
      { user: req.user._id, status: "approved" },
      { status: "resigned", updatedAt: new Date() },
    );

    res.json({ message: "You have successfully resigned as admin." });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/revoke/:userId — super admin revokes someone's admin
router.delete("/revoke/:userId", auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await User.findById(req.params.userId);
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }
    if (!target.isAdmin) {
      return res.status(400).json({ message: "User is not an admin." });
    }

    await User.findByIdAndUpdate(req.params.userId, {
      isAdmin: false,
      $unset: { adminScope: 1 },
    });

    await AdminRequest.findOneAndUpdate(
      { user: req.params.userId, status: "approved" },
      { status: "revoked", updatedAt: new Date() },
    );

    const fcmDoc = await FcmToken.findOne({ user: req.params.userId });
    if (fcmDoc?.token) {
      await sendToTokens(
        [fcmDoc.token],
        "⚠️ Admin Access Revoked",
        "Your course rep admin access has been revoked.",
        { type: "admin_revoked" },
      );
    }

    res.json({ message: "Admin access revoked." });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/all — super admin sees all current admins
router.get("/all", auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const admins = await User.find({ isAdmin: true }).select(
      "email profile adminScope createdAt",
    );
    res.json({ admins });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/trigger-morning-digest — called by external cron (cron-job.org)
// No `auth` middleware: the caller is a cron service, not a logged-in user.
// Protected instead by a shared secret header.
router.post("/trigger-morning-digest", async (req, res, next) => {
  try {
    if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await sendMorningDigests();
    res.json({ success: true, message: "Morning digest triggered" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
