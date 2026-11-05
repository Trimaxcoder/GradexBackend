SchoolLife backend update
=========================

HOW TO INSTALL (5 minutes)

1. Unzip this into your backend folder (the one that contains server.js).
   Choose "Replace all" when asked. It adds or replaces files inside
   models, routes, utils, jobs and middleware. Nothing else is touched.

2. Open models/User.js. Inside StudentProfileSchema, right after the
   `level` line, add these three lines:

       graduated:       { type: Boolean, default: false },
       promotedSession: { type: String,  default: '' },
       finalLevel:      { type: String,  default: '' },

3. Open server.js and make sure this line exists with your other app.use
   lines (add it if it is missing):

       app.use('/api/academic', require('./routes/academic'));

   The others (/api/admin, /api/announcements, /api/timetable,
   /api/profile, /api/notifications) should already be there.

4. Run   node server.js   once on your computer. If it prints
   "Cannot find module ...", send me the name. Stop it with Ctrl+C.

5. git add .   then   git commit -m "Update"   then   git push
   Render redeploys by itself.

ALSO, ONE SMALL EDIT IN YOUR OWN routes/auth.js (so a signed-out phone stops
getting that user's notifications). See the chat message for the exact lines.

NOTHING HAPPENS BY ITSELF AT FIRST
- Auto-promotion stays OFF for every calendar until you switch it on.
- The new-semester notice only goes out on a semester start date you
  entered, once, and only to reps whose class has no timetable yet.

HEADS UP
- The old "Become an admin" form in the current app only sends a reason.
  The server now also needs full name, matric number, level, semester and
  last level, so that form will be refused until the new request screen is
  in the app. Everything else keeps working with the current app.

FILES IN THIS ZIP
  models/       Announcement, AcademicCalendar, AdminRequest, PromotionRun, Timetable
  middleware/   announcementPermissions
  routes/       academic, admin, announcements, notifications, profile, promotion, timetable
  utils/        academicTerm, adminScope, repRequest, timetableTerm
  jobs/         morningDigest, promotion, semesterStart
