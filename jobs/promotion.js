// jobs/promotion.js
//
// Moves students up a level when an academic session ends.
//
// Built to be safe:
//   * Nothing runs by itself unless the super admin turned "auto promote" on
//     for that session, and then only inside a 14-day window after it ends.
//   * Each person is promoted at most once per session (profile.promotedSession),
//     so a retry or a double run can never move anyone up twice.
//   * A preview shows exactly what would happen before anything changes.
//   * Every change is recorded, so a whole run can be undone for 30 days.
//   * Graduating students keep their account and their last level. They are
//     only marked graduated, which stops the class timetable, class
//     announcements and class pushes.

const AcademicCalendar = require('../models/AcademicCalendar');
const PromotionRun = require('../models/PromotionRun');
const User = require('../models/User');
const AdminRequest = require('../models/AdminRequest');
const FcmToken = require('../models/FcmToken');
const { LectureEntry } = require('../models/Timetable');
const { sendToTokens } = require('../config/firebase');

const DAY = 24 * 60 * 60 * 1000;
const PROMOTE_AFTER_DAYS = 1;   // promote the day after the session's last day
const AUTO_WINDOW_DAYS = 14;    // older sessions need a manual run
const LOCK_MS = 10 * 60 * 1000; // a run holds the session this long at most
const CHUNK = 500;
const UNDO_DAYS = 30;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const deptKey = (faculty, department) => `${norm(faculty)}|${norm(department)}`;

/** "300" -> 300, anything else -> null */
function levelNumber(level) {
  const m = /^([1-9])00$/.exec(String(level || '').trim());
  return m ? Number(m[1]) * 100 : null;
}

const sessionEnd = (cal) =>
  Math.max(...cal.semesters.map((s) => s.endDate.getTime()));

const dueFrom = (cal) => sessionEnd(cal) + PROMOTE_AFTER_DAYS * DAY;

/** The new User fields must exist, or Mongoose would silently drop them. */
function assertSchemaReady() {
  const profileSchema =
    User.schema.path('profile') && User.schema.path('profile').schema;
  if (
    !profileSchema ||
    !profileSchema.path('promotedSession') ||
    !profileSchema.path('graduated')
  ) {
    throw new Error(
      'User model is missing profile.graduated and profile.promotedSession. Add them before running promotions.',
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  PLAN (reads only, writes nothing)
// ════════════════════════════════════════════════════════════════════════════

async function planPromotion(cal) {
  const stats = {
    total: 0,
    promoted: 0,
    graduated: 0,
    repsMoved: 0,
    repsEnded: 0,
    skippedAlready: 0,
    skippedLevel: 0,
  };
  const plan = { changes: [], stats, departments: [] };

  // Students may have typed the school slightly differently.
  const allSchools = await User.distinct('profile.school');
  const schools = allSchools.filter(
    (s) => s && AcademicCalendar.normalizeSchool(s) === cal.schoolKey,
  );
  if (schools.length === 0) return plan;

  const users = await User.find({ 'profile.school': { $in: schools } })
    .select('profile isAdmin adminScope')
    .lean();
  stats.total = users.length;

  // Highest level seen per department (students and timetables). A department
  // is never treated as finishing earlier than a level that really exists.
  const observed = new Map();
  const see = (faculty, department, level) => {
    const n = levelNumber(level);
    if (!n) return;
    const k = deptKey(faculty, department);
    if ((observed.get(k) || 0) < n) observed.set(k, n);
  };
  for (const u of users) {
    const p = u.profile || {};
    if (!p.graduated) {
      see(p.faculty, p.department, p.level);
      // a student's own last level is evidence the department runs that long
      see(p.faculty, p.department, p.finalLevel);
    }
  }
  const entryLevels = await LectureEntry.aggregate([
    { $match: { school: { $in: schools }, type: 'lecture' } },
    { $group: { _id: { f: '$faculty', d: '$department', l: '$level' } } },
  ]);
  for (const r of entryLevels) see(r._id.f, r._id.d, r._id.l);

  // Super admin's per-department choices win; otherwise the school default,
  // raised to the highest level that exists in that department.
  const overrides = new Map(
    (cal.finalLevelOverrides || []).map((o) => [
      deptKey(o.faculty, o.department),
      levelNumber(o.finalLevel),
    ]),
  );
  const finalFor = (faculty, department) => {
    const k = deptKey(faculty, department);
    if (overrides.get(k)) return overrides.get(k);
    const configured = levelNumber(cal.finalLevel) || 400;
    return Math.max(configured, observed.get(k) || 0);
  };

  const byDept = new Map();

  for (const u of users) {
    const p = u.profile || {};

    // Already handled for this session (a retry, or a double run)
    if (p.promotedSession === cal.session) {
      stats.skippedAlready++;
      continue;
    }

    const change = {
      user: u._id,
      prevSession: p.promotedSession || '',
      levelFrom: '',
      levelTo: '',
      graduated: false,
      scopeAction: '',
      scopeFrom: undefined,
      scopeTo: '',
    };
    let touched = false;

    // ── Student side ────────────────────────────────────────────────────
    const n = levelNumber(p.level);
    if (p.graduated) {
      // already graduated: nothing to do for the student part
    } else if (n === null) {
      stats.skippedLevel++; // level not in the 100–900 format; leave alone
    } else {
      // The student's own last level wins; otherwise the department's.
      const own = levelNumber(p.finalLevel);
      const final = own && own >= n ? own : finalFor(p.faculty, p.department);
      const outcome = n >= final ? 'graduate' : 'promote';

      const key = deptKey(p.faculty, p.department);
      const dept = byDept.get(key) || {
        faculty: p.faculty || '',
        department: p.department || '',
        finalLevel: String(finalFor(p.faculty, p.department)),
        levels: {},
      };
      // one row per level and outcome (students at one level can differ)
      const rowKey = `${p.level}|${outcome}`;
      const lvl = dept.levels[rowKey] || { level: p.level, count: 0, outcome };
      lvl.count++;
      dept.levels[rowKey] = lvl;
      byDept.set(key, dept);

      change.levelFrom = p.level;
      if (outcome === 'graduate') {
        change.graduated = true;
        stats.graduated++;
      } else {
        change.levelTo = String(n + 100);
        stats.promoted++;
      }
      touched = true;
    }

    // ── Course rep side (their verified class moves with the cohort) ────
    const s = u.adminScope;
    if (u.isAdmin && s && s.school && s.faculty && s.department && s.level) {
      const sn = levelNumber(s.level);
      if (sn !== null) {
        change.scopeFrom = {
          school: s.school,
          faculty: s.faculty,
          department: s.department,
          level: s.level,
        };
        const ownRep = levelNumber(p.finalLevel);
        const repFinal =
          ownRep && ownRep >= sn ? ownRep : finalFor(s.faculty, s.department);
        if (sn >= repFinal) {
          change.scopeAction = 'revoke'; // their class graduated
          stats.repsEnded++;
        } else {
          change.scopeAction = 'promote';
          change.scopeTo = String(sn + 100);
          stats.repsMoved++;
        }
        touched = true;
      }
    }

    if (touched) plan.changes.push(change);
  }

  plan.departments = [...byDept.values()]
    .map((d) => ({
      faculty: d.faculty,
      department: d.department,
      finalLevel: d.finalLevel,
      levels: Object.values(d.levels)
        .sort(
          (a, b) =>
            Number(a.level) - Number(b.level) ||
            a.outcome.localeCompare(b.outcome),
        )
        .map((v) => ({ level: v.level, count: v.count, outcome: v.outcome })),
    }))
    .sort(
      (a, b) =>
        a.faculty.localeCompare(b.faculty) ||
        a.department.localeCompare(b.department),
    );

  return plan;
}

// ════════════════════════════════════════════════════════════════════════════
//  APPLY
// ════════════════════════════════════════════════════════════════════════════

function buildUpdateOp(c, session) {
  const set = { 'profile.promotedSession': session };
  const unset = {};

  if (c.levelTo) set['profile.level'] = c.levelTo;
  if (c.graduated) set['profile.graduated'] = true;
  if (c.scopeAction === 'promote') set['adminScope.level'] = c.scopeTo;
  if (c.scopeAction === 'revoke') {
    set.isAdmin = false;
    unset.adminScope = '';
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  return {
    updateOne: {
      // The guard that makes a second run harmless
      filter: { _id: c.user, 'profile.promotedSession': { $ne: session } },
      update,
    },
  };
}

/**
 * After users change, bring the things copied from them back in line,
 * based on what the users actually look like now:
 *   - the notification scope (school / department / level) on their device token
 *   - the course rep's approved request (so its class stays correct)
 */
async function syncAfter(changes) {
  for (let i = 0; i < changes.length; i += CHUNK) {
    const slice = changes.slice(i, i + CHUNK);
    const users = await User.find({ _id: { $in: slice.map((c) => c.user) } })
      .select('profile isAdmin adminScope')
      .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    const tokenOps = [];
    const requestOps = [];

    for (const c of slice) {
      const u = byId.get(String(c.user));
      if (!u) continue;
      const p = u.profile || {};

      tokenOps.push({
        updateOne: {
          filter: { user: u._id },
          update: { $set: { level: p.graduated ? '' : p.level || '' } },
        },
      });

      if (u.isAdmin && u.adminScope && u.adminScope.level) {
        requestOps.push({
          updateOne: {
            filter: { user: u._id, status: 'approved' },
            update: { $set: { level: u.adminScope.level } },
          },
        });
      } else if (c.scopeAction === 'revoke' && !u.isAdmin) {
        requestOps.push({
          updateOne: {
            filter: { user: u._id, status: 'approved' },
            update: { $set: { status: 'resigned', updatedAt: new Date() } },
          },
        });
      }
    }

    if (tokenOps.length) await FcmToken.bulkWrite(tokenOps, { ordered: false });
    if (requestOps.length) {
      await AdminRequest.bulkWrite(requestOps, { ordered: false });
    }
  }
}

async function notifySuperAdmins(title, body) {
  const admins = await User.find({ isSuperAdmin: true }).select('_id').lean();
  if (admins.length === 0) return;
  const docs = await FcmToken.find({
    user: { $in: admins.map((a) => a._id) },
    $or: [{ enabled: true }, { enabled: { $exists: false } }],
  })
    .select('token')
    .lean();
  const tokens = docs.map((d) => d.token).filter(Boolean);
  if (tokens.length) {
    await sendToTokens(tokens, title, body, { type: 'promotion_done' });
  }
}

/**
 * Promote one session. [mode] is 'auto' (the daily check) or 'manual'.
 * Returns { skipped: true, reason } or { skipped: false, runId, stats }.
 */
async function executePromotion(cal, { mode, userId = null }) {
  assertSchemaReady();

  // Claim the session so two runs can never overlap.
  const claimed = await AcademicCalendar.findOneAndUpdate(
    {
      _id: cal._id,
      promotedAt: null,
      $or: [
        { promotionLock: null },
        { promotionLock: { $lt: new Date(Date.now() - LOCK_MS) } },
      ],
    },
    { $set: { promotionLock: new Date() } },
    { new: true },
  );
  if (!claimed) {
    return {
      skipped: true,
      reason: 'This session was already promoted, or another run is in progress.',
    };
  }

  const release = () =>
    AcademicCalendar.updateOne(
      { _id: claimed._id },
      { $set: { promotionLock: null } },
    ).catch(() => {});

  try {
    const plan = await planPromotion(claimed);

    // Nobody matched: don't lock the session, something is off (usually the
    // school name differs from what students entered).
    if (plan.stats.total === 0) {
      await release();
      return {
        skipped: true,
        reason:
          'No students were found for this school. Check that the school name matches what students entered.',
      };
    }

    // Everyone was already handled: just close the session.
    if (plan.changes.length === 0) {
      await AcademicCalendar.updateOne(
        { _id: claimed._id },
        { $set: { promotedAt: new Date(), promotionLock: null } },
      );
      return { skipped: false, runId: null, stats: plan.stats };
    }

    // Record first, so even a crash half-way leaves an undo trail.
    const run = await PromotionRun.create({
      calendar: claimed._id,
      school: claimed.school,
      session: claimed.session,
      mode,
      triggeredBy: userId,
      stats: plan.stats,
      changes: plan.changes,
      status: 'running',
    });

    for (let i = 0; i < plan.changes.length; i += CHUNK) {
      const ops = plan.changes
        .slice(i, i + CHUNK)
        .map((c) => buildUpdateOp(c, claimed.session));
      await User.bulkWrite(ops, { ordered: false });
    }
    await syncAfter(plan.changes);

    run.status = 'done';
    await run.save();
    await AcademicCalendar.updateOne(
      { _id: claimed._id },
      { $set: { promotedAt: new Date(), promotionLock: null } },
    );

    notifySuperAdmins(
      '🎓 Session promotion complete',
      `${claimed.school} ${claimed.session}: ${plan.stats.promoted} moved up, ${plan.stats.graduated} graduated. Open the Admin panel to review or undo.`,
    ).catch((err) => console.error('Promotion notify failed:', err));

    return { skipped: false, runId: run._id, stats: plan.stats };
  } catch (err) {
    await release();
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  UNDO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reverses a promotion run. Only people who are still exactly as the run left
 * them are reverted, so anyone who corrected their level afterwards keeps it.
 * Returns { error } or { reverted }.
 */
async function undoRun(runId) {
  const run = await PromotionRun.findById(runId);
  if (!run) return { error: 'Promotion run not found.' };
  if (run.undoneAt) return { error: 'This promotion was already undone.' };
  if (Date.now() - run.createdAt.getTime() > UNDO_DAYS * DAY) {
    return { error: `Promotions can only be undone within ${UNDO_DAYS} days.` };
  }

  const newer = await PromotionRun.exists({
    school: run.school,
    createdAt: { $gt: run.createdAt },
    undoneAt: null,
  });
  if (newer) {
    return { error: 'A later promotion exists for this school. Undo that one first.' };
  }

  let reverted = 0;

  for (let i = 0; i < run.changes.length; i += CHUNK) {
    const slice = run.changes.slice(i, i + CHUNK);
    const repOps = [];
    const profileOps = [];
    const revokedIds = [];

    for (const c of slice) {
      // Course rep side
      if (c.scopeAction === 'promote' && c.scopeFrom) {
        repOps.push({
          updateOne: {
            filter: { _id: c.user, 'adminScope.level': c.scopeTo },
            update: { $set: { 'adminScope.level': c.scopeFrom.level } },
          },
        });
      }
      if (c.scopeAction === 'revoke' && c.scopeFrom) {
        repOps.push({
          updateOne: {
            filter: {
              _id: c.user,
              isAdmin: false,
              adminScope: { $exists: false },
            },
            update: {
              $set: {
                isAdmin: true,
                adminScope: {
                  school: c.scopeFrom.school,
                  faculty: c.scopeFrom.faculty,
                  department: c.scopeFrom.department,
                  level: c.scopeFrom.level,
                },
              },
            },
          },
        });
        revokedIds.push(c.user);
      }

      // Student side
      const filter = { _id: c.user, 'profile.promotedSession': run.session };
      const set = { 'profile.promotedSession': c.prevSession };
      if (c.levelTo) {
        filter['profile.level'] = c.levelTo;
        set['profile.level'] = c.levelFrom;
      }
      if (c.graduated) {
        filter['profile.graduated'] = true;
        set['profile.graduated'] = false;
      }
      profileOps.push({ updateOne: { filter, update: { $set: set } } });
    }

    if (repOps.length) await User.bulkWrite(repOps, { ordered: false });
    if (profileOps.length) {
      const res = await User.bulkWrite(profileOps, { ordered: false });
      reverted += res.modifiedCount || 0;
    }

    // Reps who got their admin rights back also get their request back
    if (revokedIds.length) {
      const back = await User.find({ _id: { $in: revokedIds }, isAdmin: true })
        .select('_id')
        .lean();
      const ops = back.map((u) => ({
        updateOne: {
          filter: { user: u._id, status: 'resigned' },
          update: { $set: { status: 'approved' } },
        },
      }));
      if (ops.length) await AdminRequest.bulkWrite(ops, { ordered: false });
    }
  }

  await syncAfter(run.changes);

  run.undoneAt = new Date();
  await run.save();
  await AcademicCalendar.updateOne(
    { _id: run.calendar },
    { $set: { promotedAt: null, promotionLock: null } },
  );

  return { reverted };
}

// ════════════════════════════════════════════════════════════════════════════
//  DAILY CHECK
// ════════════════════════════════════════════════════════════════════════════

/** Promotes sessions that ended, have auto-promote on, and are inside the window. */
async function runDuePromotions(now = new Date()) {
  const calendars = await AcademicCalendar.find({
    autoPromote: true,
    promotedAt: null,
  });

  for (const cal of calendars) {
    const from = dueFrom(cal);
    if (now.getTime() < from) continue;

    if (now.getTime() > from + AUTO_WINDOW_DAYS * DAY) {
      console.log(
        `Promotion: ${cal.school} ${cal.session} ended too long ago to run automatically. Run it from the Admin panel.`,
      );
      continue;
    }

    try {
      const r = await executePromotion(cal, { mode: 'auto' });
      console.log(
        r.skipped
          ? `Promotion skipped for ${cal.school} ${cal.session}: ${r.reason}`
          : `Promotion done for ${cal.school} ${cal.session}: ${JSON.stringify(r.stats)}`,
      );
    } catch (err) {
      console.error(`Promotion failed for ${cal.school} ${cal.session}:`, err);
    }
  }
}

module.exports = {
  planPromotion,
  executePromotion,
  undoRun,
  runDuePromotions,
  sessionEnd,
  dueFrom,
  UNDO_DAYS,
};
