// routes/timetable.js — FULL FILE (replaces the old one)
const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const { protect: auth } = require("../middleware/auth");
const { LectureEntry, PersonalEntry } = require("../models/Timetable");
const { sendToTokens } = require("../config/firebase");
const { ensureAdminScope } = require("../utils/adminScope");
const {
  getTermState,
  describeTerm,
  listTerms,
} = require("../utils/academicTerm");
const {
  adoptLegacyEntries,
  entryInScope,
  termForNewEntry,
  canNotify,
  isEditable,
  classTokens,
} = require("../utils/timetableTerm");

// ── Constants & validation helpers ───────────────────────────────────────────
const DAYS = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];
const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const CLASS_TYPES = ["normal", "impromptu", "test", "meeting", "other"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const str = (v, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/**
 * Which class's timetable a user reads.
 *  - Students: the class in their profile.
 *  - Course reps: their verified class, so what they read is exactly the
 *    timetable they manage, even if their profile level is edited.
 */
async function classForReading(user) {
  if (user.isAdmin) {
    await ensureAdminScope(user);
    const s = user.adminScope;
    if (s && s.school && s.faculty && s.department && s.level) {
      return {
        school: s.school,
        faculty: s.faculty,
        department: s.department,
        level: s.level,
        repScoped: true,
      };
    }
  }
  const p = user.profile || {};
  return {
    school: p.school,
    faculty: p.faculty,
    department: p.department,
    level: p.level,
    repScoped: false,
  };
}

// Reject malformed ids early instead of letting Mongoose throw a CastError.
router.param("id", (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: "Not found" });
  }
  next();
});

/**
 * Admin guard. The class an admin may touch comes from their verified
 * adminScope, never from the request body.
 */
async function classAdmin(req, res, next) {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: "Admins only" });
    }
    await ensureAdminScope(req.user);

    const s = req.user.adminScope || {};
    if (!s.school || !s.faculty || !s.department || !s.level) {
      return res.status(403).json({
        message: "Your course rep class is not set. Please contact the super admin.",
      });
    }
    req.scope = {
      school: s.school,
      faculty: s.faculty,
      department: s.department,
      level: s.level,
    };

    // Old entries get assigned to a semester before we look at any of them.
    await adoptLegacyEntries(req.scope.school);
    next();
  } catch (err) {
    next(err);
  }
}

/** Loads an entry the calling admin is allowed to change, or answers the request. */
async function loadOwnEntry(req, res, type) {
  const entry = await LectureEntry.findById(req.params.id);
  if (!entry || entry.type !== type) {
    res.status(404).json({ message: "Not found" });
    return null;
  }
  if (!entryInScope(entry, req.scope)) {
    res.status(403).json({ message: "This entry belongs to another class" });
    return null;
  }
  return entry;
}

const PAST_MESSAGE =
  "This entry belongs to a past semester and can no longer be changed.";

function buildLectureFields(body, partial = false) {
  const f = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("courseCode")) {
    const v = str(body.courseCode, 30);
    if (!v) return { error: "Course code is required" };
    f.courseCode = v;
  }
  if (has("courseTitle")) f.courseTitle = str(body.courseTitle, 150);
  if (!partial || has("day")) {
    if (!DAYS.includes(body.day)) return { error: "Choose a valid day" };
    f.day = body.day;
  }
  for (const k of ["startTime", "endTime"]) {
    if (!partial || has(k)) {
      if (typeof body[k] !== "string" || !TIME_RE.test(body[k])) {
        return { error: "Times must look like 08:00" };
      }
      f[k] = body[k];
    }
  }
  if (has("venue")) f.venue = str(body.venue, 100);
  if (has("note")) f.note = str(body.note, 500);
  if (has("classType")) {
    if (!CLASS_TYPES.includes(body.classType)) {
      return { error: "Invalid class type" };
    }
    f.classType = body.classType;
  }
  if (has("isImportant")) f.isImportant = body.isImportant === true;
  return { fields: f };
}

function buildExamFields(body, partial = false) {
  const f = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("courseCode")) {
    const v = str(body.courseCode, 30);
    if (!v) return { error: "Course code is required" };
    f.courseCode = v;
  }
  if (has("courseTitle")) f.courseTitle = str(body.courseTitle, 150);
  if (!partial || has("date")) {
    const d = new Date(body.date);
    if (!body.date || Number.isNaN(d.getTime())) {
      return { error: "Pick a valid exam date" };
    }
    f.date = d;
    f.day = DAY_NAMES[d.getUTCDay()];
  }
  for (const k of ["startTime", "endTime"]) {
    if (!partial || has(k)) {
      if (typeof body[k] !== "string" || !TIME_RE.test(body[k])) {
        return { error: "Times must look like 09:00" };
      }
      f[k] = body[k];
    }
  }
  if (has("venue")) f.venue = str(body.venue, 100);
  if (has("note")) f.note = str(body.note, 500);
  return { fields: f };
}

async function pushToClass(entry, title, body, data) {
  const tokens = await classTokens(entry);
  if (tokens.length > 0) {
    await sendToTokens(tokens, title, body, data);
  }
}

// ════════════════════════════════════════════════════════════
//  LECTURE TIMETABLE
// ════════════════════════════════════════════════════════════

// GET /timetable/lecture — the timetable for the user's class, for the
// semester that is running. Between semesters it is empty, and `term` tells
// the app why (so it can show "waiting for the new semester").
router.get("/lecture", auth, async (req, res, next) => {
  try {
    const { school, faculty, department, level, repScoped } =
      await classForReading(req.user);
    if (!school || !faculty || !department || !level) {
      return res.json({
        entries: [],
        term: describeTerm({ status: "unconfigured" }),
        setupNeeded: false,
        preparing: false,
      });
    }

    await adoptLegacyEntries(school);
    const state = await getTermState(school);

    const query = { type: "lecture", school, faculty, department, level };
    const sort = { day: 1, startTime: 1 };

    let entries = [];
    let preparing = false;

    if (state.status === "unconfigured") {
      entries = await LectureEntry.find(query).sort(sort);
    } else if (state.status === "active") {
      entries = await LectureEntry.find({
        ...query,
        term: state.current.term,
      }).sort(sort);
    } else if (state.status === "break" && state.targetTerm && repScoped) {
      // The rep can see what they are preparing for the next semester.
      entries = await LectureEntry.find({
        ...query,
        term: state.targetTerm,
      }).sort(sort);
      preparing = true;
    }

    res.json({
      entries,
      term: describeTerm(state),
      setupNeeded: state.status === "active" && entries.length === 0,
      preparing,
    });
  } catch (err) {
    next(err);
  }
});

// POST /timetable/lecture — rep adds a lecture to their OWN class
router.post("/lecture", auth, classAdmin, async (req, res, next) => {
  try {
    const built = buildLectureFields(req.body);
    if (built.error) return res.status(400).json({ message: built.error });
    const f = built.fields;
    if (f.endTime <= f.startTime) {
      return res.status(400).json({ message: "End time must be after start time" });
    }

    const state = await getTermState(req.scope.school);
    const target = termForNewEntry(state);
    if (!target.ok) return res.status(409).json({ message: target.message });

    const entry = await LectureEntry.create({
      type: "lecture",
      classType: "normal",
      ...f,
      ...req.scope,
      term: target.term,
      createdBy: req.user._id,
    });

    // Push for important classes, only while the semester is running.
    if (entry.isImportant && canNotify(entry.term, state)) {
      const typeLabel =
        entry.classType === "test"
          ? "📝 Test Alert"
          : entry.classType === "impromptu"
            ? "⚡ Impromptu Class"
            : entry.classType === "meeting"
              ? "📢 Meeting"
              : "📌 Important Class";
      await pushToClass(
        entry,
        typeLabel,
        `${entry.courseCode}: ${entry.day} ${entry.startTime}–${entry.endTime}${entry.venue ? " @ " + entry.venue : ""}`,
        {
          type: "important_class",
          entryId: String(entry._id),
          courseCode: entry.courseCode,
        },
      );
    }

    res.status(201).json({ message: "Entry added", entry });
  } catch (err) {
    next(err);
  }
});

// PUT /timetable/lecture/:id — rep edits one of their class's lectures
router.put("/lecture/:id", auth, classAdmin, async (req, res, next) => {
  try {
    const entry = await loadOwnEntry(req, res, "lecture");
    if (!entry) return;

    const state = await getTermState(req.scope.school);
    if (!isEditable(entry, state)) {
      return res.status(409).json({ message: PAST_MESSAGE });
    }

    const built = buildLectureFields(req.body, true);
    if (built.error) return res.status(400).json({ message: built.error });
    const f = built.fields;

    const start = f.startTime ?? entry.startTime;
    const end = f.endTime ?? entry.endTime;
    if (end <= start) {
      return res.status(400).json({ message: "End time must be after start time" });
    }

    Object.assign(entry, f); // only whitelisted fields, never class or term
    entry.updatedAt = new Date();
    await entry.save();
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// PUT /timetable/lecture/:id/emergency — toggle emergency, notify the class
router.put("/lecture/:id/emergency", auth, classAdmin, async (req, res, next) => {
  try {
    const entry = await loadOwnEntry(req, res, "lecture");
    if (!entry) return;

    const state = await getTermState(req.scope.school);
    if (!canNotify(entry.term, state)) {
      return res.status(409).json({
        message: "Alerts can only be changed while this semester is running.",
      });
    }

    entry.isEmergency = !entry.isEmergency;
    entry.updatedAt = new Date();
    await entry.save();

    await pushToClass(
      entry,
      entry.isEmergency ? "🚨 Class Alert " : "🚨 Class Alert Removed",
      entry.isEmergency
        ? `${entry.courseCode} class has started on ${entry.day} at ${entry.startTime}${entry.venue ? " @ " + entry.venue : ""}!`
        : `${entry.courseCode} class is not on yet.`,
      {
        type: "emergency_toggle",
        entryId: String(entry._id),
        courseCode: entry.courseCode,
      },
    );

    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// Generic toggle handler for alert flags
const ALERT_CONFIG = {
  test: {
    field: "isTest",
    onTitle: "📝 Test Alert",
    onBody: (e) =>
      `${e.courseCode}: A test has been scheduled for ${e.day} ${e.startTime}–${e.endTime}${e.venue ? " @ " + e.venue : ""}`,
    offTitle: "Test Alert Removed",
    offBody: (e) => `${e.courseCode} test has been canceled.`,
  },
  attendance: {
    field: "isAttendance",
    onTitle: "✅ Compulsory Attendance",
    onBody: (e) =>
      `${e.courseCode}: Attendance is compulsory for ${e.day} ${e.startTime}–${e.endTime}${e.venue ? " @ " + e.venue : ""}`,
    offTitle: "Attendance Alert Removed",
    offBody: (e) =>
      `${e.courseCode} is no longer marked as compulsory attendance.`,
  },
  cancelled: {
    field: "isCancelled",
    onTitle: "🚫 Class Cancelled",
    onBody: (e) =>
      `${e.courseCode}: Class on ${e.day} ${e.startTime}–${e.endTime} has been cancelled.`,
    offTitle: "Class Reinstated",
    offBody: (e) => `${e.courseCode} class on ${e.day} has been reinstated.`,
  },
};

// PUT /timetable/lecture/:id/alert/:type — toggle test/attendance/cancelled
router.put("/lecture/:id/alert/:type", auth, classAdmin, async (req, res, next) => {
  try {
    const config = ALERT_CONFIG[req.params.type];
    if (!config) {
      return res.status(400).json({ message: "Invalid alert type" });
    }

    const entry = await loadOwnEntry(req, res, "lecture");
    if (!entry) return;

    const state = await getTermState(req.scope.school);
    if (!canNotify(entry.term, state)) {
      return res.status(409).json({
        message: "Alerts can only be changed while this semester is running.",
      });
    }

    entry[config.field] = !entry[config.field];
    entry.updatedAt = new Date();
    await entry.save();

    await pushToClass(
      entry,
      entry[config.field] ? config.onTitle : config.offTitle,
      entry[config.field] ? config.onBody(entry) : config.offBody(entry),
      {
        type: `${req.params.type}_toggle`,
        entryId: String(entry._id),
        courseCode: entry.courseCode,
      },
    );

    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// DELETE /timetable/lecture/:id
router.delete("/lecture/:id", auth, classAdmin, async (req, res, next) => {
  try {
    const entry = await loadOwnEntry(req, res, "lecture");
    if (!entry) return;

    const state = await getTermState(req.scope.school);
    if (!isEditable(entry, state)) {
      return res.status(409).json({ message: PAST_MESSAGE });
    }

    await entry.deleteOne();
    res.json({ message: "Deleted" });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════
//  EXAM TIMETABLE
// ════════════════════════════════════════════════════════════

// GET /timetable/exam
router.get("/exam", auth, async (req, res, next) => {
  try {
    const { school, faculty, department, level, repScoped } =
      await classForReading(req.user);
    if (!school || !faculty || !department || !level) {
      return res.json({
        entries: [],
        term: describeTerm({ status: "unconfigured" }),
        preparing: false,
      });
    }

    await adoptLegacyEntries(school);
    const state = await getTermState(school);

    const query = { type: "exam", school, faculty, department, level };
    const sort = { date: 1, startTime: 1 };

    let entries = [];
    let preparing = false;

    if (state.status === "unconfigured") {
      entries = await LectureEntry.find(query).sort(sort);
    } else if (state.status === "active") {
      entries = await LectureEntry.find({
        ...query,
        term: state.current.term,
      }).sort(sort);
    } else if (state.status === "break" && state.targetTerm && repScoped) {
      entries = await LectureEntry.find({
        ...query,
        term: state.targetTerm,
      }).sort(sort);
      preparing = true;
    }

    res.json({ entries, term: describeTerm(state), preparing });
  } catch (err) {
    next(err);
  }
});

// POST /timetable/exam — rep adds an exam for their OWN class
router.post("/exam", auth, classAdmin, async (req, res, next) => {
  try {
    const built = buildExamFields(req.body);
    if (built.error) return res.status(400).json({ message: built.error });
    const f = built.fields;
    if (f.endTime <= f.startTime) {
      return res.status(400).json({ message: "End time must be after start time" });
    }

    const state = await getTermState(req.scope.school);
    const target = termForNewEntry(state);
    if (!target.ok) return res.status(409).json({ message: target.message });

    const entry = await LectureEntry.create({
      type: "exam",
      ...f,
      ...req.scope,
      term: target.term,
      isImportant: true,
      createdBy: req.user._id,
    });

    // Notify only for a running semester; exams set up ahead of time are silent.
    if (canNotify(entry.term, state)) {
      await pushToClass(
        entry,
        "📅 Exam Scheduled",
        `${entry.courseCode} exam on ${entry.date.toDateString()} at ${entry.startTime}${entry.venue ? " @ " + entry.venue : ""}`,
        {
          type: "exam_added",
          entryId: String(entry._id),
          courseCode: entry.courseCode,
        },
      );
    }

    res.status(201).json({ message: "Exam added", entry });
  } catch (err) {
    next(err);
  }
});

// PUT /timetable/exam/:id
router.put("/exam/:id", auth, classAdmin, async (req, res, next) => {
  try {
    const entry = await loadOwnEntry(req, res, "exam");
    if (!entry) return;

    const state = await getTermState(req.scope.school);
    if (!isEditable(entry, state)) {
      return res.status(409).json({ message: PAST_MESSAGE });
    }

    const built = buildExamFields(req.body, true);
    if (built.error) return res.status(400).json({ message: built.error });
    const f = built.fields;

    const start = f.startTime ?? entry.startTime;
    const end = f.endTime ?? entry.endTime;
    if (end <= start) {
      return res.status(400).json({ message: "End time must be after start time" });
    }

    Object.assign(entry, f);
    entry.updatedAt = new Date();
    await entry.save();
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// DELETE /timetable/exam/:id
router.delete("/exam/:id", auth, classAdmin, async (req, res, next) => {
  try {
    const entry = await loadOwnEntry(req, res, "exam");
    if (!entry) return;

    const state = await getTermState(req.scope.school);
    if (!isEditable(entry, state)) {
      return res.status(409).json({ message: PAST_MESSAGE });
    }

    await entry.deleteOne();
    res.json({ message: "Deleted" });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════
//  NEW SEMESTER SET-UP (course reps)
// ════════════════════════════════════════════════════════════

/**
 * Where could a rep copy their class timetable from?
 * Prefers the same semester of an earlier session (1st semester → 1st
 * semester), otherwise the most recent earlier semester that has classes.
 */
async function findCarrySource(scope, state) {
  const terms = await listTerms(scope.school);
  const target = terms.find((t) => t.term === state.targetTerm);
  if (!target) return null;

  const rows = await LectureEntry.aggregate([
    {
      $match: {
        type: "lecture",
        school: scope.school,
        faculty: scope.faculty,
        department: scope.department,
        level: scope.level,
        term: { $nin: ["", target.term] },
      },
    },
    { $group: { _id: "$term", count: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((r) => [r._id, r.count]));

  const earlier = terms.filter(
    (t) => t.startDate < target.startDate && counts.has(t.term),
  );
  if (earlier.length === 0) return null;

  const sameSemester = [...earlier].reverse().find(
    (t) => t.semester === target.semester,
  );
  const pick = sameSemester || earlier[earlier.length - 1];
  return { term: pick.term, count: counts.get(pick.term) };
}

// GET /timetable/setup — what a rep sees when setting up a semester
router.get("/setup", auth, classAdmin, async (req, res, next) => {
  try {
    const state = await getTermState(req.scope.school);

    let target = null;
    let source = null;

    if (state.targetTerm) {
      const classQuery = { ...req.scope, term: state.targetTerm };
      const [lectureCount, examCount] = await Promise.all([
        LectureEntry.countDocuments({ ...classQuery, type: "lecture" }),
        LectureEntry.countDocuments({ ...classQuery, type: "exam" }),
      ]);
      target = { term: state.targetTerm, lectureCount, examCount };
      if (lectureCount === 0) source = await findCarrySource(req.scope, state);
    }

    res.json({ term: describeTerm(state), target, source });
  } catch (err) {
    next(err);
  }
});

// POST /timetable/setup/carry-over — copy last time's classes into this semester
// Only works on an empty timetable. Alerts are reset and nobody is notified.
router.post("/setup/carry-over", auth, classAdmin, async (req, res, next) => {
  try {
    const state = await getTermState(req.scope.school);

    if (state.status === "unconfigured") {
      return res
        .status(409)
        .json({ message: "No academic calendar is set for your school yet." });
    }
    if (!state.targetTerm) {
      return res.status(409).json({
        message: "Waiting for the new session calendar from the super admin.",
      });
    }

    const existing = await LectureEntry.countDocuments({
      ...req.scope,
      type: "lecture",
      term: state.targetTerm,
    });
    if (existing > 0) {
      return res.status(409).json({
        message: "This semester already has classes. Copying only works on an empty timetable.",
      });
    }

    const source = await findCarrySource(req.scope, state);
    if (!source) {
      return res
        .status(409)
        .json({ message: "There is no earlier timetable to copy from." });
    }

    const old = await LectureEntry.find({
      ...req.scope,
      type: "lecture",
      term: source.term,
    }).lean();

    const copies = old.map((d) => ({
      type: "lecture",
      courseCode: d.courseCode,
      courseTitle: d.courseTitle,
      day: d.day,
      startTime: d.startTime,
      endTime: d.endTime,
      venue: d.venue,
      classType: d.classType,
      isImportant: d.isImportant,
      note: d.note,
      ...req.scope,
      term: state.targetTerm,
      createdBy: req.user._id,
    }));
    await LectureEntry.insertMany(copies);

    res.status(201).json({
      message: `Copied ${copies.length} classes from ${source.term}`,
      copied: copies.length,
      from: source.term,
    });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════
//  PERSONAL TIMETABLE (user managed, not tied to a semester)
// ════════════════════════════════════════════════════════════

// GET /timetable/personal
router.get("/personal", auth, async (req, res, next) => {
  try {
    const entries = await PersonalEntry.find({ user: req.user._id }).sort({
      day: 1,
      startTime: 1,
    });
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});

// POST /timetable/personal
router.post("/personal", auth, async (req, res, next) => {
  try {
    const { title, day, startTime, endTime, color, note, reminderMinutes } =
      req.body;
    const entry = await PersonalEntry.create({
      user: req.user._id,
      title,
      day,
      startTime,
      endTime,
      color: color || "#4F46E5",
      note,
      reminderMinutes: reminderMinutes || 0,
    });
    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
});

// PUT /timetable/personal/:id
router.put("/personal/:id", auth, async (req, res, next) => {
  try {
    const entry = await PersonalEntry.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ...req.body, user: req.user._id, updatedAt: new Date() },
      { new: true },
    );
    if (!entry) return res.status(404).json({ message: "Not found" });
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// DELETE /timetable/personal/:id
router.delete("/personal/:id", auth, async (req, res, next) => {
  try {
    await PersonalEntry.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });
    res.json({ message: "Deleted" });
  } catch (err) {
    next(err);
  }
});

// PUT /timetable/personal/:id/bookmark — toggle bookmark
router.put("/personal/:id/bookmark", auth, async (req, res, next) => {
  try {
    const entry = await PersonalEntry.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!entry) return res.status(404).json({ message: "Not found" });
    entry.isBookmarked = !entry.isBookmarked;
    await entry.save();
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

module.exports = router;