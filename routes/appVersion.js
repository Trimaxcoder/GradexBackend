// routes/appVersion.js
const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');
const AppVersion = require('../models/AppVersion');

// The APK lives in the public "schoollife-releases" GitHub repo.
// "latest/download" always points at the newest published release,
// as long as the uploaded file is named gradex.apk.
const DEFAULT_APK_URL =
  'https://github.com/Trimaxcoder/schoollife-releases/releases/latest/download/gradex.apk';

// Old records may still hold a relative link like '/downloads/gradex.apk'
// (from when the APK was served by this backend). Anything that is not a
// full http(s) link is replaced by the GitHub link, so the app never
// receives a broken download URL.
const fullApkUrl = (url) =>
  typeof url === 'string' && url.startsWith('http') ? url : DEFAULT_APK_URL;

// ── GET /api/app-version  (public — no auth needed, app checks on launch) ───
router.get('/', async (req, res, next) => {
  try {
    const version = await AppVersion.findOne().sort({ createdAt: -1 });

    if (!version) {
      // No version record yet — nothing to compare against
      return res.json({
        latestVersion: null,
        latestBuildNumber: 0,
        apkUrl: DEFAULT_APK_URL,
        changelog: '',
        forceUpdate: false,
      });
    }

    res.json({
      latestVersion:     version.latestVersion,
      latestBuildNumber: version.latestBuildNumber,
      apkUrl:            fullApkUrl(version.apkUrl),
      changelog:         version.changelog,
      forceUpdate:       version.forceUpdate,
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