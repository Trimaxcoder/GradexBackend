// routes/guestAuth.js
//
// POST /api/guest/google   body: { idToken?, accessToken? }
//
// Turns a Google sign-in into a short "guest token" so a person with no
// SchoolLife account can create and manage forms and polls with their Gmail.
// It does NOT create a user and stores nothing in the database.
//
// We ask Google itself whether the token is real, was made for OUR app, and
// belongs to a verified email address.

const express   = require('express');
const https     = require('https');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Google client IDs allowed to sign people in here. Defaults to the web client
// your app already uses. If Gmail sign-in works on web but fails on Android with
// "not made for this app", add the Android client ID, comma separated, in the
// GOOGLE_CLIENT_IDS setting on Render.
const allowedClientIds = () =>
  (process.env.GOOGLE_CLIENT_IDS ||
    '36781799836-2vi1s0vj9r5sai75ujebr7q534uek74n.apps.googleusercontent.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many sign-in attempts. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Small GET that returns { status, json }
const getJson = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 10000 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Google took too long to answer.')));
    req.on('error', reject);
  });

// Returns { email, name } if Google confirms the token, else null
const verifyWithGoogle = async ({ idToken, accessToken }) => {
  const query = idToken
    ? `id_token=${encodeURIComponent(idToken)}`
    : `access_token=${encodeURIComponent(accessToken)}`;

  const { status, json } = await getJson(`https://oauth2.googleapis.com/tokeninfo?${query}`);
  if (status !== 200 || !json) return null;

  // Was this token made for OUR app?
  if (!allowedClientIds().includes(String(json.aud))) return null;

  // Only verified email addresses
  const verified = json.email_verified === true || json.email_verified === 'true';
  const email = String(json.email || '').trim().toLowerCase();
  if (!verified || !/^\S+@\S+\.\S+$/.test(email)) return null;

  let name = String(json.name || '').trim();
  if (!name && accessToken) {
    // access tokens do not carry the name, so ask Google for the profile
    try {
      const me = await getJson('https://www.googleapis.com/oauth2/v3/userinfo', {
        Authorization: `Bearer ${accessToken}`,
      });
      if (me.status === 200 && me.json) name = String(me.json.name || '').trim();
    } catch (_) {}
  }

  return { email, name: name.slice(0, 100) };
};

router.post('/google', limiter, wrap(async (req, res) => {
  const idToken = typeof req.body.idToken === 'string' ? req.body.idToken : '';
  const accessToken = typeof req.body.accessToken === 'string' ? req.body.accessToken : '';
  if (!idToken && !accessToken) {
    return res.status(400).json({ success: false, message: 'Google sign-in details are missing.' });
  }

  let who;
  try {
    who = await verifyWithGoogle({ idToken, accessToken });
  } catch (err) {
    console.error('[guest] Google check failed:', err && err.message);
    return res.status(502).json({ success: false, message: 'Could not reach Google. Please try again.' });
  }
  if (!who) {
    return res.status(401).json({
      success: false,
      message: 'We could not verify your Google sign-in. Please try again.',
    });
  }

  const guestToken = jwt.sign(
    { type: 'guest', email: who.email, name: who.name },
    process.env.JWT_SECRET,
    { expiresIn: '30d' },
  );

  res.json({ success: true, guestToken, email: who.email, name: who.name });
}));

module.exports = router;