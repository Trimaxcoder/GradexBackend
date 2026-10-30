// scripts/backfillAdminScope.js
// Run ONCE after adding adminScope to the User model:
//   node scripts/backfillAdminScope.js
//
// Copies each existing admin's current profile class into adminScope.
// Safe to re-run: it only touches admins that have no adminScope yet.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

(async () => {
  // Use the same env variable your server connects with
  await mongoose.connect(process.env.MONGO_URI);

  const admins = await User.find({
    isAdmin: true,
    adminScope: { $exists: false },
  });

  let updated = 0;
  let skipped = 0;

  for (const u of admins) {
    const { school, faculty, department, level } = u.profile || {};

    if (!school || !faculty || !department || !level) {
      console.log(`SKIPPED (incomplete profile): ${u.email}`);
      skipped++;
      continue;
    }

    await User.updateOne(
      { _id: u._id },
      { adminScope: { school, faculty, department, level } },
    );
    updated++;
  }

  console.log(`Done. Updated: ${updated}, skipped: ${skipped}`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});