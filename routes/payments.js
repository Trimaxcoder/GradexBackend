// routes/payments.js
//
// Rules this file follows (money code, so no shortcuts):
//  1. The amount is ALWAYS worked out on the server. The app never sends one.
//  2. A payment is only "paid" after Paystack itself confirms it (settlePayment.js).
//  3. SchoolLife never holds the money. It goes to the rep's own bank account.
//  4. Bank account numbers are never stored, only the last 4 digits.

const express   = require('express');
const mongoose  = require('mongoose');
const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { protect }        = require('../middleware/auth');
const User               = require('../models/User');
const Form               = require('../models/Form');
const FormSubmission     = require('../models/FormSubmission');
const FormPayment        = require('../models/FormPayment');
const PayoutAccount      = require('../models/PayoutAccount');
const paystack           = require('../utils/paystack');
const { quoteFor }       = require('../utils/charges');
const { settleByReference } = require('../utils/settlePayment');

const router = express.Router();

const MAX_ACCOUNTS_PER_USER = 3;
const isId = mongoose.isValidObjectId;

// ── Small helpers ─────────────────────────────────────────────────────────────
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message });

// Friendly error for problems talking to Paystack (the real reason is only logged)
const providerFail = (res, err, fallback) => {
  if (err && err.status === 503 && !err.provider) return fail(res, 503, err.message);
  console.error('[payments] provider error:', err && err.message);
  return fail(res, 502, fallback);
};

const formLinkBase = () => process.env.FORM_LINK_BASE || 'https://schoolife.web.app/f';

const isOpen = (form) =>
  form.status === 'open' && (!form.closesAt || form.closesAt.getTime() > Date.now());

// Like `protect`, but never rejects
const optionalAuth = async (req, _res, next) => {
  try {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) {
      const decoded = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password -refreshToken');
      if (user) req.user = user;
    }
  } catch (_) {}
  next();
};

const byUser = (req) => String(req.user && req.user._id);

const accountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: byUser,
  validate: false,
  message: { success: false, message: 'Too many attempts. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const initLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { success: false, message: 'Too many payment attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many requests. Try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Name check ────────────────────────────────────────────────────────────────
// The bank's account name must match the name on the user's profile. Nigerian
// names come in any order (EMMANUEL CHUKWU = Chukwu Emmanuel), so we compare
// the words, not the order: at least two words must match (or all of them for
// a short name).
const words = (s) =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

const namesMatch = (a, b) => {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  const [small, big] = x.length <= y.length ? [x, y] : [y, x];
  const hits = small.filter((w) => big.includes(w)).length;
  return hits >= Math.min(2, small.length);
};

const fingerprintOf = (bankCode, accountNumber) =>
  crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'schoollife')
    .update(`${bankCode}:${accountNumber}`)
    .digest('hex');

const accountOut = (a) => ({
  id: String(a._id),
  bankName: a.bankName,
  accountLast4: a.accountLast4,
  accountName: a.accountName,
  status: a.status,
});

// ══════════════════════════════════════════════════════════════════════════════
//  PAYOUT ACCOUNTS (where the money goes)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/payments/banks
router.get('/banks', protect, wrap(async (req, res) => {
  try {
    res.json({ success: true, banks: await paystack.listBanks() });
  } catch (err) {
    return providerFail(res, err, 'Could not load the list of banks. Try again.');
  }
}));

// GET /api/payments/payout-accounts   → mine
router.get('/payout-accounts', protect, wrap(async (req, res) => {
  const rows = await PayoutAccount.find({
    owner: req.user._id,
    status: { $ne: 'removed' },
  }).sort({ createdAt: -1 });
  res.json({ success: true, accounts: rows.map(accountOut) });
}));

// POST /api/payments/payout-accounts   body: { bankCode, accountNumber }
router.post('/payout-accounts', protect, accountLimiter, wrap(async (req, res) => {
  const bankCode = String(req.body.bankCode || '');
  const accountNumber = String(req.body.accountNumber || '').trim();

  if (!/^\d{10}$/.test(accountNumber)) {
    return fail(res, 400, 'Enter the 10-digit account number.');
  }

  const profileName = String((req.user.profile && req.user.profile.name) || '').trim();
  if (!profileName) {
    return fail(res, 400, 'Add your full name to your profile first. It must match your bank account name.');
  }

  const active = await PayoutAccount.countDocuments({ owner: req.user._id, status: 'active' });
  if (active >= MAX_ACCOUNTS_PER_USER) {
    return fail(res, 400, `You can have up to ${MAX_ACCOUNTS_PER_USER} bank accounts. Remove one first.`);
  }

  let bank;
  let accountName;
  try {
    const banks = await paystack.listBanks();
    bank = banks.find((b) => b.code === bankCode);
    if (!bank) return fail(res, 400, 'Choose your bank from the list.');

    try {
      accountName = await paystack.resolveAccount(accountNumber, bankCode);
    } catch (err) {
      if (err.provider) return fail(res, 400, 'We could not find that account. Check the bank and the number.');
      throw err;
    }
  } catch (err) {
    return providerFail(res, err, 'Could not check the account right now. Try again.');
  }

  if (!accountName) return fail(res, 400, 'We could not read the name on that account.');

  // Do not reveal the account name when it does not match
  if (!namesMatch(accountName, profileName)) {
    return fail(
      res,
      400,
      'The name on this bank account does not match the name on your profile. Use your own account, or correct your profile name.',
    );
  }

  const fingerprint = fingerprintOf(bankCode, accountNumber);
  const existing = await PayoutAccount.findOne({ owner: req.user._id, fingerprint });
  if (existing) {
    if (existing.status === 'frozen') return fail(res, 403, 'This account is blocked. Contact support.');
    if (existing.status === 'removed') {
      existing.status = 'active';
      await existing.save();
    }
    return res.json({ success: true, account: accountOut(existing) });
  }

  let subaccountCode;
  try {
    subaccountCode = await paystack.createSubaccount({
      businessName: accountName.slice(0, 100),
      bankCode,
      accountNumber,
    });
  } catch (err) {
    return providerFail(res, err, 'Could not set up this account right now. Try again.');
  }

  const account = await PayoutAccount.create({
    owner: req.user._id,
    bankCode,
    bankName: bank.name,
    accountLast4: accountNumber.slice(-4),
    accountName,
    subaccountCode,
    fingerprint,
  });

  res.status(201).json({ success: true, account: accountOut(account) });
}));

// DELETE /api/payments/payout-accounts/:id
router.delete('/payout-accounts/:id', protect, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, 'Invalid id.');
  const account = await PayoutAccount.findOne({ _id: req.params.id, owner: req.user._id });
  if (!account) return fail(res, 404, 'Account not found.');

  const inUse = await Form.exists({
    'payment.payoutAccount': account._id,
    status: 'open',
  });
  if (inUse) {
    return fail(res, 409, 'This account is used by a form that is still open. Collect or delete that form first.');
  }

  if (account.status !== 'frozen') {
    account.status = 'removed';
    await account.save();
  }
  res.json({ success: true });
}));

// POST /api/payments/payout-accounts/:id/freeze   body: { frozen: true|false }
// SchoolLife super admins only. Use it after a scam report: no new payment can
// start for this account while it is frozen.
router.post('/payout-accounts/:id/freeze', protect, wrap(async (req, res) => {
  if (!req.user.isSuperAdmin) return fail(res, 403, 'Not allowed.');
  if (!isId(req.params.id)) return fail(res, 400, 'Invalid id.');

  const account = await PayoutAccount.findById(req.params.id);
  if (!account) return fail(res, 404, 'Account not found.');

  account.status = req.body.frozen === false ? 'active' : 'frozen';
  await account.save();
  res.json({ success: true, account: accountOut(account) });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  PAYING (students and guests)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/payments/initialize
// body: { publicId, submissionId, email?, editToken? }
// The student has already submitted the form (their name, matric number, ...).
// Returns a Paystack checkout link that works on phone and web.
router.post('/initialize', initLimiter, optionalAuth, wrap(async (req, res) => {
  const publicId = String(req.body.publicId || '').slice(0, 20);
  const { submissionId } = req.body;
  if (!publicId || !isId(submissionId)) return fail(res, 400, 'Missing details.');

  const form = await Form.findOne({ publicId });
  if (!form || !form.payment || !form.payment.enabled) {
    return fail(res, 404, 'This form does not take payments.');
  }
  if (!isOpen(form)) return fail(res, 403, 'This form is closed, so it no longer takes payments.');

  const sub = await FormSubmission.findOne({ _id: submissionId, form: form._id })
    .select('+editTokenHash');
  if (!sub) return fail(res, 404, 'We could not find your response.');

  // Whose response is it? Logged-in owner, or a guest holding the edit token.
  const isOwner = req.user && sub.user && String(sub.user) === String(req.user._id);
  const token = req.body.editToken;
  const isGuestOwner =
    !sub.user &&
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= 100 &&
    sub.editTokenHash === FormSubmission.hashToken(token);
  if (!isOwner && !isGuestOwner) return fail(res, 403, 'This response is not yours.');

  if (sub.paymentStatus === 'paid' || sub.paymentStatus === 'cash') {
    return fail(res, 409, 'This response is already paid.');
  }

  const account = await PayoutAccount.findById(form.payment.payoutAccount);
  if (!account || account.status !== 'active') {
    return fail(res, 403, 'Payments for this form are paused. Contact the person who created it.');
  }

  // Paystack needs an email for the receipt
  const email = String((req.user && req.user.email) || req.body.email || '')
    .trim()
    .toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) {
    return fail(res, 400, 'Enter a valid email address for your receipt.');
  }

  // Amounts come ONLY from the server
  const quote = quoteFor(form.payment.amountKobo);
  const reference = `SL${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`.toUpperCase();

  const payment = await FormPayment.create({
    form: form._id,
    submission: sub._id,
    payoutAccount: account._id,
    subaccountCode: account.subaccountCode,
    payer: req.user ? req.user._id : null,
    payerEmail: email,
    reference,
    dueKobo: quote.dueKobo,
    serviceKobo: quote.serviceKobo,
    totalKobo: quote.totalKobo,
  });

  try {
    const init = await paystack.initialize({
      email,
      amountKobo: quote.totalKobo,
      chargeKobo: quote.totalKobo - quote.dueKobo,
      reference,
      subaccount: account.subaccountCode,
      callbackUrl: `${formLinkBase()}/${form.publicId}?pay_ref=${reference}`,
      metadata: {
        formId: String(form._id),
        submissionId: String(sub._id),
        // shown in the Paystack dashboard
        custom_fields: [{ display_name: 'Form', variable_name: 'form', value: form.title.slice(0, 80) }],
      },
    });

    res.json({
      success: true,
      authorizationUrl: init.authorization_url,
      reference,
      dueKobo: quote.dueKobo,
      totalKobo: quote.totalKobo,
    });
  } catch (err) {
    await FormPayment.updateOne({ _id: payment._id }, { status: 'failed' });
    return providerFail(res, err, 'Could not start the payment. Please try again.');
  }
}));

// POST /api/payments/verify   body: { reference }
// The app calls this when the student comes back from the checkout page. It
// works even if the webhook has not arrived yet.
router.post('/verify', verifyLimiter, wrap(async (req, res) => {
  const reference = String(req.body.reference || '').slice(0, 80);
  if (!reference) return fail(res, 400, 'Missing reference.');

  let result;
  try {
    result = await settleByReference(reference);
  } catch (err) {
    return providerFail(res, err, 'We could not confirm the payment yet. Please try again in a moment.');
  }
  if (!result.found) return fail(res, 404, 'Payment not found.');

  const p = result.payment;
  const form = await Form.findById(p.form).select('publicId title');

  res.json({
    success: true,
    state: result.state, // success | pending | failed | mismatch
    publicId: form ? form.publicId : null,
    payment: {
      reference: p.reference,
      dueKobo: p.dueKobo,
      totalKobo: p.totalKobo,
      paidAt: p.paidAt,
      channel: p.channel,
    },
  });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  FORM OWNER
// ══════════════════════════════════════════════════════════════════════════════

const getOwnedForm = async (req, res) => {
  if (!isId(req.params.formId)) { fail(res, 400, 'Invalid form id.'); return null; }
  const form = await Form.findById(req.params.formId);
  if (!form) { fail(res, 404, 'Form not found.'); return null; }
  if (String(form.owner) !== String(req.user._id)) {
    fail(res, 403, 'Only the person who created this form can do this.');
    return null;
  }
  return form;
};

// POST /api/payments/forms/:formId/submissions/:sid/cash   body: { paid, note? }
// For people who pay the rep by hand. Only for responses that are not paid online.
router.post('/forms/:formId/submissions/:sid/cash', protect, wrap(async (req, res) => {
  const form = await getOwnedForm(req, res);
  if (!form) return;
  if (!form.payment || !form.payment.enabled) return fail(res, 400, 'This form has no payment.');
  if (!isId(req.params.sid)) return fail(res, 400, 'Invalid id.');

  const sub = await FormSubmission.findOne({ _id: req.params.sid, form: form._id });
  if (!sub) return fail(res, 404, 'Response not found.');

  if (req.body.paid === false) {
    if (sub.paymentStatus !== 'cash') return fail(res, 409, 'Only cash payments can be undone here.');
    sub.paymentStatus = 'unpaid';
    sub.paidAt = null;
    sub.cashNote = '';
  } else {
    if (sub.paymentStatus !== 'unpaid') return fail(res, 409, 'This response is already paid.');
    sub.paymentStatus = 'cash';
    sub.paidAt = new Date();
    sub.cashNote = String(req.body.note || '').trim().slice(0, 200);
  }
  await sub.save();

  res.json({ success: true, paymentStatus: sub.paymentStatus, paidAt: sub.paidAt });
}));

// GET /api/payments/forms/:formId/summary   → numbers for the dashboard
router.get('/forms/:formId/summary', protect, wrap(async (req, res) => {
  const form = await getOwnedForm(req, res);
  if (!form) return;

  const [byStatus, online, duplicates] = await Promise.all([
    FormSubmission.aggregate([
      { $match: { form: form._id } },
      { $group: { _id: '$paymentStatus', n: { $sum: 1 } } },
    ]),
    FormPayment.aggregate([
      { $match: { form: form._id, status: 'success' } },
      { $group: { _id: null, n: { $sum: 1 }, dueKobo: { $sum: '$dueKobo' } } },
    ]),
    FormPayment.countDocuments({ form: form._id, status: 'success', duplicate: true }),
  ]);

  const count = (s) => (byStatus.find((r) => r._id === s) || { n: 0 }).n;
  res.json({
    success: true,
    summary: {
      paid: count('paid'),
      cash: count('cash'),
      unpaid: count('unpaid'),
      // what the rep receives from online payments (before the bank's own delay)
      onlineReceivedKobo: online[0] ? online[0].dueKobo : 0,
      // payments that arrived twice and need a refund on the Paystack dashboard
      duplicatesToRefund: duplicates,
    },
  });
}));

// ══════════════════════════════════════════════════════════════════════════════
//  EARNINGS (SchoolLife super admins only: the app developer's income)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/payments/earnings
// "serviceKobo" is SchoolLife's service fee on each successful online payment.
// The real money sits in your Paystack balance and Paystack pays it to your own
// bank account (its next working day settlement), so always compare with the
// Paystack dashboard. Payments that arrived twice (and get refunded) are left out.
router.get('/earnings', protect, wrap(async (req, res) => {
  if (!req.user.isSuperAdmin) return fail(res, 403, 'Not allowed.');

  const base = { status: 'success', duplicate: { $ne: true } };
  const sum = {
    payments: { $sum: 1 },
    serviceKobo: { $sum: '$serviceKobo' },
    collectedKobo: { $sum: '$dueKobo' },
  };

  const now = new Date();
  const days = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  const [all, last30, last7, months] = await Promise.all([
    FormPayment.aggregate([{ $match: base }, { $group: { _id: null, ...sum } }]),
    FormPayment.aggregate([
      { $match: { ...base, paidAt: { $gte: days(30) } } },
      { $group: { _id: null, ...sum } },
    ]),
    FormPayment.aggregate([
      { $match: { ...base, paidAt: { $gte: days(7) } } },
      { $group: { _id: null, ...sum } },
    ]),
    FormPayment.aggregate([
      { $match: { ...base, paidAt: { $ne: null } } },
      {
        $group: {
          _id: {
            y: { $year: { date: '$paidAt', timezone: 'Africa/Lagos' } },
            m: { $month: { date: '$paidAt', timezone: 'Africa/Lagos' } },
          },
          ...sum,
        },
      },
      { $sort: { '_id.y': -1, '_id.m': -1 } },
      { $limit: 12 },
    ]),
  ]);

  const pick = (r) => ({
    payments: r[0] ? r[0].payments : 0,
    serviceKobo: r[0] ? r[0].serviceKobo : 0,
    collectedKobo: r[0] ? r[0].collectedKobo : 0,
  });

  res.json({
    success: true,
    allTime: pick(all),
    last30Days: pick(last30),
    last7Days: pick(last7),
    months: months.map((m) => ({
      year: m._id.y,
      month: m._id.m,
      payments: m.payments,
      serviceKobo: m.serviceKobo,
      collectedKobo: m.collectedKobo,
    })),
  });
}));

module.exports = router;