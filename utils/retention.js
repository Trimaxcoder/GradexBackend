// Frees storage. Runs in the background every 30 minutes.
//
// A message is really deleted (from MongoDB, and its photo / file / voice note
// from Cloudinary) only when EVERY active member of the class has already
// hidden it: by clearing their chat, or because it is older than their
// "disappearing messages" setting. If even one member still sees it, it stays.

const Class        = require('../models/Class');
const ClassMessage = require('../models/ClassMessage');
const { destroyAsset } = require('./cloudinary');
const { hideBeforeOf } = require('./visibility');

const EVERY_MS = 30 * 60 * 1000;
const BATCH    = 200; // messages per class per run

let running = false;

async function purgeOnce() {
  if (running) return;
  running = true;

  try {
    // Only classes where no active member is still keeping everything
    const classes = await Class.find({
      archived: false,
      members: {
        $not: {
          $elemMatch: {
            status:         'active',
            clearedAt:      null,
            disappearAfter: { $in: [0, null] },
          },
        },
      },
    }).select('members');

    for (const cls of classes) {
      const active = cls.members.filter((m) => m.status === 'active');
      if (!active.length) continue;

      const cutoffs = active.map((m) => hideBeforeOf(m));
      if (cutoffs.some((c) => !c)) continue;

      const cutoff = new Date(Math.min(...cutoffs.map((c) => c.getTime())));

      const old = await ClassMessage.find({
        class:     cls._id,
        createdAt: { $lte: cutoff },
      })
        .select('attachment')
        .limit(BATCH);
      if (!old.length) continue;

      for (const m of old) {
        if (m.attachment && m.attachment.url) await destroyAsset(m.attachment.url);
      }
      await ClassMessage.deleteMany({ _id: { $in: old.map((m) => m._id) } });
    }
  } catch (err) {
    console.error('retention job failed:', err.message);
  } finally {
    running = false;
  }
}

function startRetentionJob() {
  setTimeout(purgeOnce, 60 * 1000).unref();
  setInterval(purgeOnce, EVERY_MS).unref();
}

module.exports = { startRetentionJob, purgeOnce };