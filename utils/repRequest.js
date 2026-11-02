// utils/repRequest.js
//
// The rules for who may apply to become a class rep. Kept apart from the
// route so they are easy to test and reuse.

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const normMatric = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, '');

/** "300" -> 300 for levels 100–700, anything else -> null */
function levelNum(level) {
  const m = /^([1-7])00$/.exec(String(level ?? '').trim());
  return m ? Number(m[1]) * 100 : null;
}

/** Same school, faculty, department and level (tolerant of spelling/spacing). */
function sameClass(a, b) {
  return (
    norm(a.school) === norm(b.school) &&
    norm(a.faculty) === norm(b.faculty) &&
    norm(a.department) === norm(b.department) &&
    norm(a.level) === norm(b.level)
  );
}

/**
 * Checks what the student typed against their profile.
 * Returns { error } or { values } (cleaned values ready to store).
 */
function validateRepRequest(profile, body) {
  const p = profile || {};
  const b = body || {};

  if (!p.school || !p.faculty || !p.department || !p.level) {
    return {
      error:
        'Please complete your profile (school, faculty, department, level) before requesting admin access.',
    };
  }
  if (p.graduated) {
    return { error: 'Graduated students cannot become class reps.' };
  }
  if (!p.name || !p.matricNumber) {
    return {
      error: 'Please add your full name and matric number to your profile first.',
    };
  }
  if (norm(b.fullName) !== norm(p.name)) {
    return {
      error: `The full name must match your profile name ("${p.name}"). Update your profile first if it is wrong.`,
    };
  }
  if (normMatric(b.matricNumber) !== normMatric(p.matricNumber)) {
    return {
      error:
        'The matric number must match the one in your profile. Update your profile first if it is wrong.',
    };
  }

  const current = levelNum(p.level);
  if (current === null) {
    return {
      error:
        'Your profile level must be 100, 200 … up to 700 before you can apply.',
    };
  }
  if (levelNum(b.level) !== current) {
    return {
      error: `Your profile says you are in ${p.level} level. Update your profile first if it is wrong.`,
    };
  }

  const semester = Number(b.semester);
  if (![1, 2].includes(semester)) {
    return { error: 'Choose your current semester (1 or 2).' };
  }

  const final = levelNum(b.finalLevel);
  if (final === null || final < current) {
    return {
      error:
        'The last level before graduation must be your current level or higher (up to 700).',
    };
  }

  return {
    values: {
      fullName: String(b.fullName).trim().slice(0, 120),
      matricNumber: String(b.matricNumber).trim().slice(0, 60),
      level: String(p.level).trim(),
      semester,
      finalLevel: String(final),
      reason: typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '',
    },
  };
}

module.exports = { norm, normMatric, levelNum, sameClass, validateRepRequest };
