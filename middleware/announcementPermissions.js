// middleware/announcementPermissions.js
//
// One place for every "who can do what" rule about announcements.
// Routes call these helpers; they never trust a target from req.body.

/**
 * Decide whether `user` may post, and exactly where it will go.
 *
 * - scope 'global' -> superadmin only, reaches everyone.
 * - anything else  -> treated as 'class': course reps only, and the target
 *   (school/faculty/department/level) comes from the rep's own adminScope.
 *
 * Returns { ok: true, target } or { ok: false, status, message }.
 */
function resolvePostTarget(user, requestedScope) {
  const scope = requestedScope === 'global' ? 'global' : 'class';

  if (scope === 'global') {
    if (!user.isSuperAdmin) {
      return {
        ok: false,
        status: 403,
        message: 'Only the super admin can post general announcements',
      };
    }
    return {
      ok: true,
      target: { scope: 'global', school: '', faculty: '', department: '', level: '' },
    };
  }

  if (!user.isAdmin) {
    return { ok: false, status: 403, message: 'Admin access required' };
  }

  const s = user.adminScope || {};
  if (!s.school || !s.faculty || !s.department || !s.level) {
    return {
      ok: false,
      status: 403,
      message: 'Your course rep class is not set. Please contact the super admin.',
    };
  }

  return {
    ok: true,
    target: {
      scope: 'class',
      school: s.school,
      faculty: s.faculty,
      department: s.department,
      level: s.level,
    },
  };
}

/**
 * May `user` edit or delete this announcement?
 * action: 'edit' | 'delete'
 *
 * - global: superadmin only
 * - class:  the rep who posted it (while still an admin);
 *           superadmin may also delete (moderation), but not edit
 */
function canModify(user, announcement, action) {
  if (announcement.scope === 'global') return !!user.isSuperAdmin;

  const isOwner = announcement.admin.toString() === user._id.toString();
  if (isOwner && user.isAdmin) return true;

  return action === 'delete' && !!user.isSuperAdmin;
}

/**
 * Mongo filter for what a student sees: every global announcement, plus
 * class announcements for their own exact class. Legacy department-wide
 * ('all') announcements no longer match.
 */
function feedFilter(user) {
  const { school, faculty, department, level } = user.profile || {};
  const or = [{ scope: 'global' }];

  if (school && faculty && department && level) {
    or.push({ scope: { $ne: 'global' }, school, faculty, department, level });
  }
  return { $or: or };
}

module.exports = { resolvePostTarget, canModify, feedFilter };