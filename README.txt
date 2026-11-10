SchoolLife backend update
=========================

HOW TO INSTALL (5 minutes)

1. Unzip this into your backend folder (the one that contains server.js).
   Choose "Replace all" when asked. It adds or replaces files inside
   models, routes, utils, jobs and middleware. Nothing else is touched.

2. Open models/User.js. Inside StudentProfileSchema, right after the
   `level` line, add these three lines (skip any you already added):

       graduated:       { type: Boolean, default: false },
       promotedSession: { type: String,  default: '' },
       finalLevel:      { type: String,  default: '' },

3. Open server.js and make sure these two lines exist with your other
   app.use lines (add any that are missing):

       app.use('/api/academic',  require('./routes/academic'));
       app.use('/api/carryover', require('./routes/carryover'));

   The others (/api/admin, /api/announcements, /api/timetable,
   /api/profile, /api/notifications) should already be there.

4. In your own routes/auth.js, so a signed-out phone stops getting that
   user's notifications (see the chat message for the exact lines):
   add   const FcmToken = require("../models/FcmToken");   at the top, and
   in the /logout route add   await FcmToken.deleteMany({ user: req.user._id });

5. Run   node server.js   once on your computer. If it prints
   "Cannot find module ...", send me the name. Stop it with Ctrl+C.

6. git add .   then   git commit -m "Update"   then   git push
   Render redeploys by itself.

NOTHING HAPPENS BY ITSELF AT FIRST
- Auto-promotion stays OFF for every calendar until you switch it on.
- The new-semester notice only goes out on a semester start date you
  entered, once, and only to reps whose class has no timetable yet.
- Carry-overs only exist once a student adds one.

HEADS UP
- The old "Become an admin" form in the current app only sends a reason.
  The server now also needs full name, matric number, level, semester and
  last level, so that form is refused until the new request screen is in
  the app.

FILES IN THIS ZIP
  models/       Announcement, AcademicCalendar, AdminRequest, Carryover, PromotionRun, Timetable
  middleware/   announcementPermissions
  routes/       academic, admin, announcements, carryover, notifications, profile, promotion, timetable
  utils/        academicTerm, adminScope, carryover, repRequest, timetableTerm
  jobs/         carryoverDigest, morningDigest, promotion, semesterStart
