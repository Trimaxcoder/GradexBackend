// The name other people see for a user inside classes.
// If the user has set a username, that is shown. Otherwise their full name.

const displayName = (user, fallback = 'Student') => {
  if (!user) return fallback;
  if (user.username) return user.username;
  return (user.profile && user.profile.name) || fallback;
};

module.exports = { displayName };