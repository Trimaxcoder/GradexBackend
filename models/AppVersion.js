// models/AppVersion.js
const mongoose = require('mongoose');

// Single-document collection — there's only ever one "current version" record.
const AppVersionSchema = new mongoose.Schema(
  {
    // Semantic version of the latest APK, e.g. "1.4.2"
    latestVersion: { type: String, required: true },

    // Matches Flutter's buildNumber (the int after the + in pubspec version),
    // used for reliable numeric comparison instead of parsing semver strings.
    latestBuildNumber: { type: Number, required: true },

    // Relative path the Flutter app + web page will download from
    apkUrl: { type: String, required: true, default: '/downloads/gradex.apk' },

    // Shown in the update dialog
    changelog: { type: String, default: '' },

    // If true, the app should block usage until updated (optional, off by default)
    forceUpdate: { type: Boolean, default: false },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AppVersion', AppVersionSchema);