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

const MAX_FORMS_PER_USER = 200;
const MAX_RESPONSES      = 3000;

const isId = mongoose.isValidObjectId;

// ── Small helpers ─────────────────────────────────────────────────────────────
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message });

// Set FORM_LINK_BASE in .env to change the public link.
const formLink = (publicId) =>
  `${process.env.FORM_LINK_BASE || 'https://schoolife.web.app/f'}/${publicId}`;

// Like `protect`, but never rejects. If a valid token is sent, req.user is set.
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

// ── Open / closed ─────────────────────────────────────────────────────────────
// A form accepts responses only while it is "open" and its deadline (if any)
// has not passed.
const isOpen = (form) =>
  form.status === 'open' && (!form.closesAt || form.closesAt.getTime() > Date.now());

// 'open' | 'collected' | 'expired' (deadline passed)
const effectiveStatus = (form) =>
  form.status === 'collected' ? 'collected' : isOpen(form) ? 'open' : 'expired';

const closedMessage = (form) =>
  effectiveStatus(form) === 'expired'
    ? 'The deadline for this form has passed.'
    : 'This form is closed. It is no longer collecting responses.';

// Returns { value } or { error }. `current` is the saved deadline (a Date or null).
const parseDeadline = (raw, current) => {
  if (raw === null || raw === '') return { value: null };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { error: 'Choose a valid deadline.' };
  // unchanged deadline is always fine, even if it has passed
  if (current && current.getTime() === d.getTime()) return { value: d };
  if (d.getTime() <= Date.now()) return { error: 'The deadline must be in the future.' };
  return { value: d };
};

// ── Validation ────────────────────────────────────────────────────────────────
const CHOICE_TYPES = ['dropdown', 'radio', 'checkbox'];
// Answer types that can be used to stop duplicates
const UNIQUE_TYPES = ['text', 'number', 'email', 'phone'];

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

// Cleans the table settings sent by the owner. Anything unknown falls back to a default.
const CASES = ['none', 'upper', 'lower', 'sentence', 'title', 'camel'];

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

const cleanList = (v, max, len) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))]
    .slice(0, max)
    .map((x) => x.slice(0, len));

const sanitizeSettings = (raw, form) => {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ids = new Set(form.fields.map((f) => f.id));

  return {
    numbered: r.numbered !== false,
    numberLabel: String(r.numberLabel ?? 'S/N').trim().slice(0, 12) || 'S/N',
    showSubmitter: r.showSubmitter === true,
    align: pick(r.align, ['left', 'center', 'right'], 'left'),
    headerCase: pick(r.headerCase, CASES, 'none'),
    cellCase: pick(r.cellCase, CASES, 'none'),
    fontSize: pick(r.fontSize, ['small', 'normal', 'large'], 'normal'),
    orientation: pick(r.orientation, ['portrait', 'landscape'], 'landscape'),
    blankRows: Math.min(Math.max(parseInt(r.blankRows) || 0, 0), 100),
    blankColumns: cleanList(r.blankColumns, 5, 30),
    hiddenFieldIds: (Array.isArray(r.hiddenFieldIds) ? r.hiddenFieldIds : [])
      .map(String)
      .filter((id) => ids.has(id)),
    firstFieldId: ids.has(String(r.firstFieldId)) ? String(r.firstFieldId) : '',
    sortFieldId: ids.has(String(r.sortFieldId)) ? String(r.sortFieldId) : '',
    sortDir: pick(r.sortDir, ['asc', 'desc'], 'asc'),
    signatories: cleanList(r.signatories, 4, 40),
  };
};

// Which question must be unique. Uses the position in `fields` when the fields
// were just sent (their ids can change), or the id when only settings changed.
const resolveUniqueId = (form, body) => {
  let id = '';
  if (body.uniqueFieldIndex !== undefined) {
    const i = parseInt(body.uniqueFieldIndex);
    if (Number.isInteger(i) && i >= 0 && i < form.fields.length) id = form.fields[i].id;
  } else {
    id = String(body.uniqueFieldId || '');
  }
  const f = form.fields.find((x) => x.id === id);
  return f && UNIQUE_TYPES.includes(f.type) ? id : '';
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

// If the form stops duplicates, returns an error message when another response
// already has the same value (ignores spaces and upper/lower case). Else null.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const duplicateMessage = async (form, answers, selfId) => {
  if (!form.uniqueFieldId) return null;
  const a = answers.find((x) => x.fieldId === form.uniqueFieldId);
  if (!a || a.value === '' || a.value === null || a.value === undefined) return null;

  const match = typeof a.value === 'string'
    ? new RegExp(`^\\s*${escapeRe(a.value.trim())}\\s*$`, 'i')
    : a.value;

  const filter = {
    form: form._id,
    answers: { $elemMatch: { fieldId: form.uniqueFieldId, value: match } },
  };
  if (selfId) filter._id = { $ne: selfId };

  const taken = await FormSubmission.exists(filter);
  if (!taken) return null;

  const f = form.fields.find((x) => x.id === form.uniqueFieldId);
  return `A response with this ${f ? f.label : 'value'} has already been submitted.`;
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

// What the public (fill) screen needs. Nothing about the owner.
const publicForm = (form) => ({
  publicId:    form.publicId,
  title:       form.title,
  description: form.description,
  logoUrl:     form.logoUrl,
  status:      isOpen(form) ? 'open' : 'collected',
  expired:     effectiveStatus(form) === 'expired',
  closesAt:    form.closesAt,
  fields:      form.fields.map(fieldOut),
});

const formOut = (form, extra = {}) => ({
  id:              String(form._id),
  classId:         form.classId ? String(form.classId) : null,
  publicId:        form.publicId,
  link:            formLink(form.publicId),
  title:           form.title,
  description:     form.description,
  logoUrl:         form.logoUrl,
  status:          form.status,
  effectiveStatus: effectiveStatus(form),
  collectedAt:     form.collectedAt,
  closesAt:        form.closesAt,
  uniqueFieldId:   form.uniqueFieldId || '',
  tableSettings:   form.tableSettings && form.tableSettings.toObject
    ? form.tableSettings.toObject()
    : {},
  fields:          form.fields.map(fieldOut),
  createdAt:       form.createdAt,
  updatedAt:       form.updatedAt,
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

// ── Owner helpers ─────────────────────────────────────────────────────────────

// Loads :id and checks the caller created the form.
// Sends the error response itself and returns null when not allowed.
const getOwnedForm = async (req, res) => {
  if (!isId(req.params.id)) { fail(res, 400, 'Invalid form id.'); return null; }
  const form = await Form.findById(req.params.id);
  if (!form) { fail(res, 404, 'Form not found.'); return null; }
  if (String(form.owner) !== String(req.user._id)) {
    fail(res, 403, 'Only the person who created this form can do this.');
    return null;
  }
  return form;
};

// A form can be shared with a class the creator belongs to (optional).
// Returns { id } (id may be null) or { status, error }.
const resolveClass = async (classId, userId) => {
  if (!classId) return { id: null };
  if (!isId(classId)) return { status: 400, error: 'Invalid class.' };
  const cls = await Class.findById(classId);
  if (!cls || cls.kind === 'dm' || cls.archived) return { status: 404, error: 'Class not found.' };
  if (!cls.isActiveMember(userId)) {
    return { status: 403, error: 'You can only share a form with a class you belong to.' };
  }
  return { id: cls._id };
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
  if (!isOpen(form)) return fail(res, 403, closedMessage(form));

  const { answers, error } = cleanAnswers(form, req.body.answers);
  if (error) return fail(res, 400, error);

  if (req.user) {
    const existing = await FormSubmission.findOne({ form: form._id, user: req.user._id });
    if (existing) {
      const dup = await duplicateMessage(form, answers, existing._id);
      if (dup) return fail(res, 409, dup);
      existing.answers = answers;
      await existing.save();
      return res.json({ success: true, submission: subOut(existing) });
    }
  }

  const total = await FormSubmission.countDocuments({ form: form._id });
  if (total >= MAX_RESPONSES) return fail(res, 400, 'This form has reached its response limit.');

  const dup = await duplicateMessage(form, answers, null);
  if (dup) return fail(res, 409, dup);

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
router.post('/public/:publicId/my-submission', publicReadLimiter, wrap(async (req, res) => {
  const form = await Form.findOne({ publicId: String(req.params.publicId || '').slice(0, 20) });
  if (!form) return fail(res, 404, 'Form not found.');

  const sub = await findByToken(form._id, req.body.editToken);
  if (!sub) return fail(res, 404, 'We could not find your response.');
  res.json({ success: true, form: publicForm(form), submission: subOut(sub) });
}));

// PUT /api/forms/public/:publicId/submission   body: { editToken, answers }
router.put('/public/:publicId/submission', publicWriteLimiter, wrap(async (req, res) => {
  const form = await Form.findOne({ publicId: String(req.params.publicId || '').slice(0, 20) });
  if (!form) return fail(res, 404, 'Form not found.');
  if (!isOpen(form)) return fail(res, 403, closedMessage(form));

  const sub = await findByToken(form._id, req.body.editToken);
  if (!sub) return fail(res, 404, 'We could not find your response.');

  const { answers, error } = cleanAnswers(form, req.body.answers);
  if (error) return fail(res, 400, error);

  const dup = await duplicateMessage(form, answers, sub._id);
  if (dup) return fail(res, 409, dup);

  sub.answers = answers;
  await sub.save();
  res.json({ success: true, submission: subOut(sub) });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  OWNER  (any logged-in user can create forms)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/forms/upload-signature
// Short-lived permission to upload a logo / letterhead straight to Cloudinary.
router.post('/upload-signature', protect, uploadLimiter, wrap(async (req, res) => {
  if (!isConfigured()) return fail(res, 503, 'File uploads are not set up yet.');
  res.json({ success: true, upload: signUpload(`forms-${req.user._id}`) });
}));

// POST /api/forms
// body: { title, description, logoUrl, fields, classId?, closesAt?, uniqueFieldIndex? }
router.post('/', protect, wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  if (title.length < 2 || title.length > 150) return fail(res, 400, 'Title must be 2 to 150 characters.');
  if (description.length > 2000) return fail(res, 400, 'Description can be at most 2000 characters.');

  const logoUrl = cleanLogo(req.body.logoUrl);
  if (logoUrl === null) return fail(res, 400, 'Upload the logo again.');

  const { fields, error } = sanitizeFields(req.body.fields);
  if (error) return fail(res, 400, error);

  const cls = await resolveClass(req.body.classId, req.user._id);
  if (cls.error) return fail(res, cls.status, cls.error);

  const deadline = parseDeadline(req.body.closesAt, null);
  if (deadline.error) return fail(res, 400, deadline.error);

  const count = await Form.countDocuments({ owner: req.user._id });
  if (count >= MAX_FORMS_PER_USER) {
    return fail(res, 400, `You can have up to ${MAX_FORMS_PER_USER} forms. Delete old ones first.`);
  }

  const form = new Form({
    owner: req.user._id,
    classId: cls.id,
    title,
    description,
    logoUrl,
    fields,
    closesAt: deadline.value,
  });
  form.uniqueFieldId = resolveUniqueId(form, req.body);
  await form.save();

  res.status(201).json({ success: true, form: formOut(form, { responseCount: 0 }) });
}));

// GET /api/forms/mine  → forms I created, with response counts
router.get('/mine', protect, wrap(async (req, res) => {
  const forms = await Form.find({ owner: req.user._id })
    .sort({ createdAt: -1 })
    .limit(MAX_FORMS_PER_USER);

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

// GET /api/forms/class/:classId
// Open forms that people shared with this class (class members only).
router.get('/class/:classId', protect, wrap(async (req, res) => {
  if (!isId(req.params.classId)) return fail(res, 400, 'Invalid class id.');

  const cls = await Class.findById(req.params.classId);
  if (!cls || !cls.isActiveMember(req.user._id)) {
    return fail(res, 403, 'You are not a member of this class.');
  }

  const forms = await Form.find({
    classId: cls._id,
    status: 'open',
    $or: [{ closesAt: null }, { closesAt: { $gt: new Date() } }],
  })
    .sort({ createdAt: -1 })
    .limit(100);

  res.json({
    success: true,
    forms: forms.map((f) => ({
      publicId:    f.publicId,
      title:       f.title,
      description: f.description,
      logoUrl:     f.logoUrl,
      closesAt:    f.closesAt,
      createdAt:   f.createdAt,
    })),
  });
}));

// GET /api/forms/:id   (owner: full form, for editing)
router.get('/:id', protect, wrap(async (req, res) => {
  const form = await getOwnedForm(req, res);
  if (!form) return;
  const responseCount = await FormSubmission.countDocuments({ form: form._id });
  res.json({ success: true, form: formOut(form, { responseCount }) });
}));

// PUT /api/forms/:id
// body: any of { title, description, logoUrl, fields, classId, closesAt,
//                uniqueFieldIndex | uniqueFieldId, tableSettings }
// Fields can only change while nobody has responded yet, because changing them
// would break answers that are already saved.
router.put('/:id', protect, wrap(async (req, res) => {
  const form = await getOwnedForm(req, res);
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
  if (req.body.classId !== undefined) {
    const cls = await resolveClass(req.body.classId, req.user._id);
    if (cls.error) return fail(res, cls.status, cls.error);
    form.classId = cls.id;
  }
  if (req.body.closesAt !== undefined) {
    const deadline = parseDeadline(req.body.closesAt, form.closesAt);
    if (deadline.error) return fail(res, 400, deadline.error);
    form.closesAt = deadline.value;
  }
  if (fields !== undefined) {
    const responses = await FormSubmission.countDocuments({ form: form._id });
    if (responses > 0) {
      return fail(res, 409, 'Questions cannot be changed after people have responded.');
    }
    const clean = sanitizeFields(fields);
    if (clean.error) return fail(res, 400, clean.error);
    form.fields = clean.fields;
  }
  if (req.body.uniqueFieldIndex !== undefined || req.body.uniqueFieldId !== undefined) {
    form.uniqueFieldId = resolveUniqueId(form, req.body);
  } else if (fields !== undefined) {
    form.uniqueFieldId = '';
  }
  if (req.body.tableSettings !== undefined) {
    form.tableSettings = sanitizeSettings(req.body.tableSettings, form);
  }

  await form.save();
  const responseCount = await FormSubmission.countDocuments({ form: form._id });
  res.json({ success: true, form: formOut(form, { responseCount }) });
}));

// POST /api/forms/:id/collect  → close the form and lock all responses
router.post('/:id/collect', protect, wrap(async (req, res) => {
  const form = await getOwnedForm(req, res);
  if (!form) return;
  form.status = 'collected';
  form.collectedAt = new Date();
  await form.save();
  res.json({ success: true, form: formOut(form) });
}));

// POST /api/forms/:id/reopen  → people can submit and edit again.
// If the deadline has already passed, it is removed so the form really opens.
router.post('/:id/reopen', protect, wrap(async (req, res) => {
  const form = await getOwnedForm(req, res);
  if (!form) return;
  form.status = 'open';
  form.collectedAt = null;
  if (form.closesAt && form.closesAt.getTime() <= Date.now()) form.closesAt = null;
  await form.save();
  res.json({ success: true, form: formOut(form) });
}));

// GET /api/forms/:id/responses
router.get('/:id/responses', protect, wrap(async (req, res) => {
  const form = await getOwnedForm(req, res);
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
  const form = await getOwnedForm(req, res);
  if (!form) return;
  await FormSubmission.deleteMany({ form: form._id });
  await form.deleteOne();
  res.json({ success: true });
}));

module.exports = router;