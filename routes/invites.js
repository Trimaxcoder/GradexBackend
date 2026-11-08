// routes/invites.js
//
// GET /api/invites/:code  ->  the group name and size for an invite code.
//
// This route is public (no login) on purpose: a student who taps an invite
// link has no account yet, and the app wants to say "You're invited to join
// Visionaries" before asking them to sign up. It only reveals the group name,
// description and member count to someone who already holds the code, and it
// is rate limited so codes cannot be guessed in bulk.

const express   = require('express');
const rateLimit = require('express-rate-limit');

const Class = require('../models/Class');

const router = express.Router();

const inviteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many tries. Please wait a minute.' },
});

router.get('/:code', inviteLimiter, async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return res
        .status(400)
        .json({ success: false, message: 'This invite link is not valid.' });
    }

    // Private chats and closed classes cannot be joined with a code
    const cls = await Class.findOne({
      joinCode: code,
      archived: false,
      kind: { $ne: 'dm' },
    }).select('name description requireApproval members.status');

    if (!cls) {
      return res
        .status(404)
        .json({ success: false, message: 'This invite link is no longer valid.' });
    }

    const memberCount = cls.members.filter((m) => m.status === 'active').length;

    res.json({
      success: true,
      invite: {
        code,
        name: cls.name,
        description: cls.description || '',
        requireApproval: !!cls.requireApproval,
        memberCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;