const express   = require('express');
const mongoose  = require('mongoose');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { protect }      = require('../middleware/auth');
const User             = require('../models/User');
const Class            = require('../models/Class');
const Form             = require('../models/Form');
const FormSubmission   = require('../models/FormSubmission');
const { isConfigured, signUpload } = require('../utils/cloudinary');
const { displayName }  = require('../utils/displayName');

const router = express.Router();

const MAX_FORMS_PER_CLASS = 100;
const MAX_RESPONSES       = 3000;

const isId = mongoose.isValidObjectId;

// ── Small helpers ─────────────────────────────────────────────────────────────
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message });

// Set FORM_LINK_BASE in .env to change the public link.
// The Flutter web app must open /f/<publicId> as the fill screen.
const formLink = (publicId) =>
  `${process.env.FORM_LINK_BASE || 'https://schoolife.web.app/f'}/${publicId}`;

// Like `protect`, but never rejects. If a valid token is sent, req.user is set.
// Used on public routes so logged-in students get autofill and one response each.
const optionalAuth = async (req, _res, next) => {
  try {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) {
      const decoded = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password -refreshToken');
      if (user) req.user = user;
    }
  } catch (_) {
    // bad or expired token: treat the person as a guest
  }
  next();
};

const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many requests. Try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const publicWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many submissions. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.user && req.user._id),
  validate: false,
  message: { success: false, message: 'Too many uploads. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Validation ────────────────────────────────────────────────────────────────
const CHOICE_TYPES = ['dropdown', 'radio', 'checkbox'];

// Only images uploaded to your own Cloudinary are accepted as a logo
const cleanLogo = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.length > 500 || !/^https:\/\/res\.cloudinary\.com\//.test(s)) return null;
  return s;
};

// Returns { fields } or { error }. Ids are assigned here (f1, f2, ...).
const sanitizeFields = (raw) => {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) {
    return { error: 'A form needs between 1 and 50 fields.' };
  }

  const fields = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i] || {};
    const label = String(f.label || '').trim();
    if (!label || label.length > 200) {
      return { error: `Field ${i + 1}: give it a label (up to 200 characters).` };
    }

    const type = String(f.type || 'text');
    if (!Form.FIELD_TYPES.includes(type)) {
      return { error: `Field ${i + 1}: unknown field type.` };
    }

    let options = [];
    if (CHOICE_TYPES.includes(type)) {
      options = [...new Set(
        (Array.isArray(f.options) ? f.options : [])
          .map((o) => String(o).trim())
          .filter(Boolean)
      )];
      if (options.length < 2 || options.length > 30 || options.some((o) => o.length > 100)) {
        return { error: `Field ${i + 1}: add 2 to 30 options (up to 100 characters each).` };
      }
    }

    const profileKey = String(f.profileKey || '');
    if (profileKey && !Form.PROFILE_KEYS.includes(profileKey)) {
      return { error: `Field ${i + 1}: that profile field is not available.` };
    }

    fields.push({ id: `f${i + 1}`, label, type, required: !!f.required, options, profileKey });
  }
  return { fields };
};

// Checks a person's answers against the form. Returns { answers } or { error }.
const cleanAnswers = (form, raw) => {
  if (!Array.isArray(raw)) return { error: 'Answers are missing.' };

  const given = new Map();
  for (const a of raw) {
    if (a && typeof a.fieldId === 'string') given.set(a.fieldId, a);
  }

  const out = [];
  for (const f of form.fields) {
    const a = given.get(f.id);
    let v = a ? a.value : '';

    const empty =
      v === undefined || v === null ||
      (typeof v === 'string' && !v.trim()) ||
      (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) return { error: `"${f.label}" is required.` };
      continue;
    }

    const bad = (msg) => ({ error: `"${f.label}": ${msg}` });

    switch (f.type) {
      case 'text':
        v = String(v).trim();
        if (v.length > 300) return bad('too long (300 characters max).');
        break;
      case 'longtext':
        v = String(v).trim();
        if (v.length > 3000) return bad('too long (3000 characters max).');
        break;
      case 'email':
        v = String(v).trim();
        if (v.length > 200 || !/^\S+@\S+\.\S+$/.test(v)) return bad('enter a valid email.');
        break;
      case 'phone':
        v = String(v).trim();
        if (!/^[0-9+()\-\s]{5,20}$/.test(v)) return bad('enter a valid phone number.');
        break;
      case 'number':
        v = Number(v);
        if (!Number.isFinite(v)) return bad('enter a valid number.');
        break;
      case 'date': {
        v = String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(new Date(v).getTime())) {
          return bad('enter a valid date.');
        }
        v = v.slice(0, 10);
        break;
      }
      case 'dropdown':
      case 'radio':
        v = String(v);
        if (!f.options.includes(v)) return bad('pick one of the options.');
        break;
      case 'checkbox':
        if (!Array.isArray(v)) return bad('pick from the options.');
        v = [...new Set(v.map(String))];
        if (v.some((x) => !f.options.includes(x))) return bad('pick from the options.');
        break;
      default:
        return bad('unsupported field.');
    }

    out.push({ fieldId: f.id, value: v, fromProfile: !!(a && a.fromProfile && f.profileKey) });
  }
  return { answers: out };
};

// ── Output shapes ─────────────────────────────────────────────────────────────
const fieldOut = (f) => ({
  id: f.id,
  label: f.label,
  type: f.type,
  required: f.required,
  options: f.options,
  profileKey: f.profileKey,
});

// What the public (fill) screen needs. Nothing about the owner or class.
const publicForm = (form) => ({
  publicId:    form.publicId,
  title:       form.title,
  description: form.description,
  logoUrl:     form.logoUrl,
  status:      form.status,
  fields:      form.fields.map(fieldOut),
});

const formOut = (form, extra = {}) => ({
  id:          String(form._id),
  classId:     form.classId ? String(form.classId) : null,
  publicId:    form.publicId,
  link:        formLink(form.publicId),
  title:       form.title,
  description: form.description,
  logoUrl:     form.logoUrl,
  status:      form.status,
  collectedAt: form.collectedAt,
  fields:      form.fields.map(fieldOut),
  createdAt:   form.createdAt,
  updatedAt:   form.updatedAt,
  ...extra,
});

const subOut = (s) => ({
  id:        String(s._id),
  answers:   s.answers.map((a) => ({
    fieldId: a.fieldId,
    value: a.value,
    fromProfile: a.fromProfile,
  })),
  submittedAt: s.createdAt,
  updatedAt:   s.updatedAt,
});

// Profile values the student can use to autofill, keyed by field id
const prefillFor = (form, user) => {
  const p = user.profile || {};
  const out = {};
  for (const f of form.fields) {
    if (!f.profileKey) continue;
    let v = p[f.profileKey];
    if (!v && f.profileKey === 'email') v = user.email;
    if (v) out[f.id] = String(v);
  }
  return out;
};

// ── Admin helpers ─────────────────────────────────────────────────────────────
const CLOSED_MSG = 'This form is closed. It is no longer collecting responses.';

// Loads :id and checks the caller is an admin of the form's class.
// Sends the error response itself and returns null when not allowed.
const getManagedForm = async (req, res) => {
  if (!isId(req.params.id)) { fail(res, 400, 'Invalid form id.'); return null; }
  const form = await Form.findById(req.params.id);
  if (!form) { fail(res, 404, 'Form not found.'); return null; }

  const cls = form.classId ? await Class.findById(form.classId) : null;
  const allowed = cls
    ? cls.isAdmin(req.user._id)
    : String(form.owner) === String(req.user._id);
  if (!allowed) { fail(res, 403, 'Only a class admin can do this.'); return null; }
  return form;
};

// ══════════════════════════════════════════════════════════════════════════════
//  PUBLIC  (no account needed; a token is used only when the person is logged in)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/forms/public/:publicId
router.get('/public/:publicId', publicReadLimiter, optionalAuth, wrap(async (req, res) => {
  const publicId = String(req.params.publicId || '');
  if (!publicId || publicId.length > 20) return fail(res, 404, 'Form not found.');

  const form = await Form.findOne({ publicId });
  if (!form) return fail(res, 404, 'Form not found.');

  const out = { success: true, form: publicForm(form), loggedIn: !!req.user };
  if (req.user) {
    out.prefill = prefillFor(form, req.user);
    const mine = await FormSubmission.findOne({ form: form._id, user: req.user._id });
    out.mySubmission = mine ? subOut(mine) : null;
  }
  res.json(out);
}));

// POST /api/forms/public/:publicId/submit   body: { answers: [{fieldId, value, fromProfile}] }
// Logged-in: one response per person (submitting again updates it).
// Guest: creates a response and returns an editToken, shown only this once.
router.post('/public/:publicId/submit', publicWriteLimiter, optionalAuth, wrap(async (req, res) => {
  const form = await Form.findOne({ publicId: String(req.params.publicId || '').slice(0, 20) });
  if (!form) return fail(res, 404, 'Form not found.');
  if (form.status !== 'open') return fail(res, 403, CLOSED_MSG);

  const { answers, error } = cleanAnswers(form, req.body.answers);
  if (error) return fail(res, 400, error);

  if (req.user) {
    const existing = await FormSubmission.findOne({ form: form._id, user: req.user._id });
    if (existing) {
      existing.answers = answers;
      await existing.save();
      return res.json({ success: true, submission: subOut(existing) });
    }
  }

  const total = await FormSubmission.countDocuments({ form: form._id });
  if (total >= MAX_RESPONSES) return fail(res, 400, 'This form has reached its response limit.');

  if (req.user) {
    try {
      const sub = await FormSubmission.create({ form: form._id, user: req.user._id, answers });
      return res.status(201).json({ success: true, submission: subOut(sub) });
    } catch (err) {
      if (err.code === 11000) return fail(res, 409, 'You already submitted. Open the form again to edit.');
      throw err;
    }
  }

  const editToken = FormSubmission.newToken();
  const sub = await FormSubmission.create({
    form: form._id,
    answers,
    editTokenHash: FormSubmission.hashToken(editToken),
  });
  res.status(201).json({ success: true, submission: subOut(sub), editToken });
}));

// Finds a guest's submission from their edit token
const findByToken = async (formId, token) => {
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  return FormSubmission
    .findOne({ form: formId, editTokenHash: FormSubmission.hashToken(token) })
    .select('+editTokenHash');
};

// POST /api/forms/public/:publicId/my-submission   body: { editToken }
// A guest opens their edit link: returns their answers so they can change them.
router.post('/public/:publicId/my-submission', publicReadLimiter, wrap(async (req, res) => {
  const form = await Form.findOne({ publicId: String(req.params.publicId || '').slice(0, 20) });
  if (!form) return fail(res, 404, 'Form not found.');

  const sub = await findByToken(form._id, req.body.editToken);
  if (!sub) return fail(res, 404, 'We could not find your response.');
  res.json({ success: true, form: publicForm(form), submission: subOut(sub) });
}));

// PUT /api/forms/public/:publicId/submission   body: { editToken, answers }
// A guest edits their response, only while the form is open.
router.put('/public/:publicId/submission', publicWriteLimiter, wrap(async (req, res) => {
  const form = await Form.findOne({ publicId: String(req.params.publicId || '').slice(0, 20) });
  if (!form) return fail(res, 404, 'Form not found.');
  if (form.status !== 'open') return fail(res, 403, CLOSED_MSG);

  const sub = await findByToken(form._id, req.body.editToken);
  if (!sub) return fail(res, 404, 'We could not find your response.');

  const { answers, error } = cleanAnswers(form, req.body.answers);
  if (error) return fail(res, 400, error);

  sub.answers = answers;
  await sub.save();
  res.json({ success: true, submission: subOut(sub) });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  CLASS ADMIN  (login required)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/forms/upload-signature   body: { classId }
// Short-lived permission to upload a logo / letterhead straight to Cloudinary.
// Afterwards the app saves the returned image URL as logoUrl.
router.post('/upload-signature', protect, uploadLimiter, wrap(async (req, res) => {
  if (!isConfigured()) return fail(res, 503, 'File uploads are not set up yet.');
  const { classId } = req.body;
  if (!isId(classId)) return fail(res, 400, 'Invalid class id.');

  const cls = await Class.findById(classId);
  if (!cls || !cls.isAdmin(req.user._id)) return fail(res, 403, 'Only class admins can do this.');

  res.json({ success: true, upload: signUpload(String(cls._id)) });
}));

// POST /api/forms   body: { classId, title, description, logoUrl, fields }
router.post('/', protect, wrap(async (req, res) => {
  const { classId } = req.body;
  if (!isId(classId)) return fail(res, 400, 'Choose a class for this form.');

  const cls = await Class.findById(classId);
  if (!cls || cls.kind === 'dm' || cls.archived) return fail(res, 404, 'Class not found.');
  if (!cls.isAdmin(req.user._id)) return fail(res, 403, 'Only class admins can create forms.');

  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  if (title.length < 2 || title.length > 150) return fail(res, 400, 'Title must be 2 to 150 characters.');
  if (description.length > 2000) return fail(res, 400, 'Description can be at most 2000 characters.');

  const logoUrl = cleanLogo(req.body.logoUrl);
  if (logoUrl === null) return fail(res, 400, 'Upload the logo again.');

  const { fields, error } = sanitizeFields(req.body.fields);
  if (error) return fail(res, 400, error);

  const count = await Form.countDocuments({ classId: cls._id });
  if (count >= MAX_FORMS_PER_CLASS) {
    return fail(res, 400, `A class can have up to ${MAX_FORMS_PER_CLASS} forms. Delete old ones first.`);
  }

  const form = await Form.create({
    owner: req.user._id,
    classId: cls._id,
    title,
    description,
    logoUrl,
    fields,
  });

  res.status(201).json({ success: true, form: formOut(form, { responseCount: 0 }) });
}));

// GET /api/forms/class/:classId
// Members see the open forms of their class (so they can fill them in the app).
// Admins see every form with its response count.
router.get('/class/:classId', protect, wrap(async (req, res) => {
  if (!isId(req.params.classId)) return fail(res, 400, 'Invalid class id.');

  const cls = await Class.findById(req.params.classId);
  if (!cls || !cls.isActiveMember(req.user._id)) {
    return fail(res, 403, 'You are not a member of this class.');
  }

  const iAmAdmin = cls.isAdmin(req.user._id);
  const filter = { classId: cls._id };
  if (!iAmAdmin) filter.status = 'open';

  const forms = await Form.find(filter).sort({ createdAt: -1 }).limit(MAX_FORMS_PER_CLASS);

  if (!iAmAdmin) {
    return res.json({
      success: true,
      forms: forms.map((f) => ({
        publicId:    f.publicId,
        title:       f.title,
        description: f.description,
        logoUrl:     f.logoUrl,
        createdAt:   f.createdAt,
      })),
    });
  }

  const counts = await FormSubmission.aggregate([
    { $match: { form: { $in: forms.map((f) => f._id) } } },
    { $group: { _id: '$form', n: { $sum: 1 } } },
  ]);
  const countOf = new Map(counts.map((c) => [String(c._id), c.n]));

  res.json({
    success: true,
    forms: forms.map((f) => formOut(f, { responseCount: countOf.get(String(f._id)) || 0 })),
  });
}));

// GET /api/forms/:id   (admin: full form, for editing)
router.get('/:id', protect, wrap(async (req, res) => {
  const form = await getManagedForm(req, res);
  if (!form) return;
  const responseCount = await FormSubmission.countDocuments({ form: form._id });
  res.json({ success: true, form: formOut(form, { responseCount }) });
}));

// PUT /api/forms/:id   body: any of { title, description, logoUrl, fields }
// Fields can only change while nobody has responded yet, because changing them
// would break answers that are already saved.
router.put('/:id', protect, wrap(async (req, res) => {
  const form = await getManagedForm(req, res);
  if (!form) return;

  const { title, description, logoUrl, fields } = req.body;

  if (title !== undefined) {
    const t = String(title).trim();
    if (t.length < 2 || t.length > 150) return fail(res, 400, 'Title must be 2 to 150 characters.');
    form.title = t;
  }
  if (description !== undefined) {
    const d = String(description).trim();
    if (d.length > 2000) return fail(res, 400, 'Description can be at most 2000 characters.');
    form.description = d;
  }
  if (logoUrl !== undefined) {
    const l = cleanLogo(logoUrl);
    if (l === null) return fail(res, 400, 'Upload the logo again.');
    form.logoUrl = l;
  }
  if (fields !== undefined) {
    const responses = await FormSubmission.countDocuments({ form: form._id });
    if (responses > 0) {
      return fail(res, 409, 'Fields cannot be changed after people have responded. Duplicate the form instead.');
    }
    const clean = sanitizeFields(fields);
    if (clean.error) return fail(res, 400, clean.error);
    form.fields = clean.fields;
  }

  await form.save();
  const responseCount = await FormSubmission.countDocuments({ form: form._id });
  res.json({ success: true, form: formOut(form, { responseCount }) });
}));

// POST /api/forms/:id/collect  → close the form and lock all responses
router.post('/:id/collect', protect, wrap(async (req, res) => {
  const form = await getManagedForm(req, res);
  if (!form) return;
  form.status = 'collected';
  form.collectedAt = new Date();
  await form.save();
  res.json({ success: true, form: formOut(form) });
}));

// POST /api/forms/:id/reopen  → people can submit and edit again
router.post('/:id/reopen', protect, wrap(async (req, res) => {
  const form = await getManagedForm(req, res);
  if (!form) return;
  form.status = 'open';
  form.collectedAt = null;
  await form.save();
  res.json({ success: true, form: formOut(form) });
}));

// GET /api/forms/:id/responses  → everything the admin needs for the table / PDF / print
router.get('/:id/responses', protect, wrap(async (req, res) => {
  const form = await getManagedForm(req, res);
  if (!form) return;

  const rows = await FormSubmission.find({ form: form._id })
    .sort({ createdAt: 1 })
    .limit(MAX_RESPONSES)
    .populate({ path: 'user', select: 'profile.name username' });

  res.json({
    success: true,
    form: formOut(form),
    responses: rows.map((s) => ({
      ...subOut(s),
      respondent: s.user ? displayName(s.user, 'Student') : 'Guest',
      hasAccount: !!s.user,
    })),
  });
}));

// DELETE /api/forms/:id  → removes the form and all its responses
router.delete('/:id', protect, wrap(async (req, res) => {
  const form = await getManagedForm(req, res);
  if (!form) return;
  await FormSubmission.deleteMany({ form: form._id });
  await form.deleteOne();
  res.json({ success: true });
}));

module.exports = router;