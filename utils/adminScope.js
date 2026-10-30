// utils/adminScope.js
const User = require('../models/User');
const AdminRequest = require('../models/AdminRequest');

/**
 * Makes sure an admin has a verified class (adminScope).
 *
 * If it is missing (the backfill ran against another database, or the admin
 * was approved before adminScope existed), it is rebuilt from the request
 * the super admin APPROVED. Never from the user's editable profile.
 *
 * Safe to call on every request: it does nothing once adminScope is set,
 * and nothing for people who are not admins.
 */
async function ensureAdminScope(user) {
  if (!user || !user.isAdmin) return user;

  const s = user.adminScope;
  if (s && s.school && s.faculty && s.department && s.level) return user;

  const approved = await AdminRequest.findOne({
    user: user._id,
    status: 'approved',
  }).sort({ createdAt: -1 });
  if (!approved) return user;

  const scope = {
    school: approved.school,
    faculty: approved.faculty,
    department: approved.department,
    level: approved.level,
  };
  if (!scope.school || !scope.faculty || !scope.department || !scope.level) {
    return user;
  }

  await User.updateOne({ _id: user._id }, { adminScope: scope });
  user.adminScope = scope; // so the rest of this request sees it
  return user;
}

module.exports = { ensureAdminScope };