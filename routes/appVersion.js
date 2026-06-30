// routes/appVersion.js
const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');
const AppVersion = require('../models/AppVersion');

// ── GET /api/app-version  (public — no auth needed, app checks on launch) ───
router.get('/', async (req, res, next) => {
  try {
    const version = await AppVersion.findOne().sort({ createdAt: -1 });

    if (!version) {
      // No version record yet — nothing to compare against
      return res.json({
        latestVersion: null,
        latestBuildNumber: 0,
        apkUrl: null,
        changelog: '',
        forceUpdate: false,
      });
    }

    res.json({
      latestVersion:     version.latestVersion,
      latestBuildNumber: version.latestBuildNumber,
      apkUrl:             version.apkUrl,
      changelog:          version.changelog,
      forceUpdate:        version.forceUpdate,
    });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/app-version  (super admin only — call this after each release) ─
router.put('/', auth, async (req, res, next) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { latestVersion, latestBuildNumber, apkUrl, changelog, forceUpdate } =
      req.body;

    if (!latestVersion || latestBuildNumber === undefined) {
      return res.status(400).json({
        message: 'latestVersion and latestBuildNumber are required',
      });
    }

    // Upsert the single version document
    const version = await AppVersion.findOneAndUpdate(
      {},
      {
        latestVersion,
        latestBuildNumber,
        ...(apkUrl !== undefined && { apkUrl }),
        ...(changelog !== undefined && { changelog }),
        ...(forceUpdate !== undefined && { forceUpdate }),
        updatedBy: req.user._id,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ message: 'App version updated', version });
  } catch (err) {
    next(err);
  }
});

module.exports = router;