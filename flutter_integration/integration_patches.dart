// ═══════════════════════════════════════════════════════════════════════════
//  FLUTTER INTEGRATION PATCHES  —  main.dart changes
//
//  This file shows EXACTLY which methods in your existing main.dart to change
//  and what to replace them with. Copy each section into your code.
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
//  1. pubspec.yaml  — add one dependency
// ───────────────────────────────────────────────────────────────────────────
/*
dependencies:
  http: ^1.2.1          # ← add this line
  # keep all your existing dependencies unchanged
*/

// ───────────────────────────────────────────────────────────────────────────
//  2. Add import at top of main.dart
// ───────────────────────────────────────────────────────────────────────────
/*
import 'services/api_service.dart';
*/

// ───────────────────────────────────────────────────────────────────────────
//  3. _LoginScreenState — replace _submit() with this version
//     Registers on the server AND saves profile to SharedPreferences.
//     Falls back gracefully if offline.
// ───────────────────────────────────────────────────────────────────────────

/*
Future<void> _submit() async {
  if (!_fk.currentState!.validate()) return;
  setState(() => _loading = true);

  final profileData = {
    'name':         _nameC.text.trim(),
    'email':        _emailC.text.trim(),
    'matricNumber': _matricC.text.trim(),
    'school':       _schoolC.text.trim(),
    'faculty':      _facC.text.trim(),
    'department':   _deptC.text.trim(),
  };

  // ── Save locally first (instant, works offline) ──────────────────────────
  final profile = StudentProfile(
    name:         profileData['name']!,
    email:        profileData['email']!,
    matricNumber: profileData['matricNumber']!,
    school:       profileData['school']!,
    faculty:      profileData['faculty']!,
    department:   profileData['department']!,
  );
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('profile', jsonEncode(profile.toMap()));

  // ── Register on server (show error but don't block if offline) ───────────
  try {
    // Use matric number as password (user can change later in settings)
    // OR prompt for a password field in your login form
    await AuthService().register(
      email:    profileData['email']!,
      password: _matricC.text.trim(),   // default password = matric number
      profile:  profileData,
    );
  } on ApiException catch (e) {
    // 409 = already registered, that's fine
    if (e.statusCode != 409) {
      debugPrint('Server register warning: ${e.message}');
    }
    // Try logging in if already exists
    try {
      await AuthService().login(
        email:    profileData['email']!,
        password: _matricC.text.trim(),
      );
    } catch (_) {}
  } catch (_) {
    // Offline — app works locally, will sync on next launch
  }

  if (!mounted) return;
  setState(() => _loading = false);
  Navigator.of(context).pushReplacement(
    PageRouteBuilder(
      transitionDuration: Duration.zero,
      pageBuilder: (_, __, ___) => _PreloaderScreen(),
    ),
  );
}
*/

// ───────────────────────────────────────────────────────────────────────────
//  4. SplashScreen — auto-login on app launch (_SplashScreenState.initState)
//     Replace the Future.delayed block with this version:
// ───────────────────────────────────────────────────────────────────────────
/*
Future.delayed(const Duration(seconds: 2), () async {
  if (!mounted) return;
  final prefs   = await SharedPreferences.getInstance();
  final hasProf = (prefs.getString('profile') ?? '').isNotEmpty;

  if (hasProf) {
    // Try silent login with stored tokens
    try {
      await AuthService().getMe();   // validates token
    } on UnauthorizedException {
      // Token expired → attempt re-login with saved credentials
      // (If you store password: attempt; otherwise just continue offline)
    } catch (_) {
      // Offline — proceed to HomeScreen with local data
    }
  }

  if (!mounted) return;
  Navigator.of(context).pushReplacement(
    _fade_(hasProf ? const HomeScreen() : const LoginScreen()),
  );
});
*/

// ───────────────────────────────────────────────────────────────────────────
//  5. _HomeScreenState — replace _loadData() to sync from server on startup
// ───────────────────────────────────────────────────────────────────────────
/*
Future<void> _loadData() async {
  final prefs = await SharedPreferences.getInstance();

  // Load local cache first (instant)
  final raw = prefs.getStringList('courses');
  if (raw != null) {
    courses = raw.map((e) => Course.fromMap(jsonDecode(e))).toList();
  }
  final pd = prefs.getString('profile');
  if (pd != null) profile = StudentProfile.fromMap(jsonDecode(pd));
  final gd = prefs.getString('grading');
  if (gd != null) grading = GradingModel.fromJson(gd);
  setState(() {});

  // Then sync with server in background
  _syncWithServer();

  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (_pageCtrl.hasClients) _pageCtrl.jumpToPage(currentPage);
  });
}

Future<void> _syncWithServer() async {
  try {
    final localList = courses
        .map((c) => c.toMap())
        .toList();

    final serverCourses = await CourseService().syncCourses(localList);

    // Convert server response to Course objects
    final merged = serverCourses.map((m) => Course.fromServerMap(m)).toList();
    setState(() => courses = merged);
    await _saveCourses();

    // Also sync profile/grading
    final userData = await AuthService().getMe();
    if (userData['profile'] != null) {
      profile = StudentProfile.fromMap(
        Map<String, dynamic>.from(userData['profile'] as Map),
      );
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('profile', jsonEncode(profile.toMap()));
    }
    if (userData['grading'] != null) {
      final gData = Map<String, dynamic>.from(userData['grading'] as Map);
      if (gData['rules'] != null) {
        grading = GradingModel.fromJson(jsonEncode(gData));
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('grading', grading.toJson());
      }
    }
    setState(() {});
  } on UnauthorizedException {
    // Session expired — navigate to login
    if (mounted) {
      Navigator.of(context)
          .pushAndRemoveUntil(_fade_(const LoginScreen()), (_) => false);
    }
  } catch (e) {
    debugPrint('Sync skipped (offline?): $e');
  }
}
*/

// ───────────────────────────────────────────────────────────────────────────
//  6. _HomeScreenState — replace _saveCourses() to also push to server
// ───────────────────────────────────────────────────────────────────────────
/*
Future<void> _saveCourses() async {
  // Always save locally first
  final prefs = await SharedPreferences.getInstance();
  await prefs.setStringList(
    'courses',
    courses.map((e) => jsonEncode(e.toMap())).toList(),
  );
}
// Note: individual add/edit/delete methods call the API directly (see §7–9).
// _saveCourses() stays as local-only cache update.
*/

// ───────────────────────────────────────────────────────────────────────────
//  7. Adding a single course — after _addCourse() calls setState & _saveCourses
//     append this background push:
// ───────────────────────────────────────────────────────────────────────────
/*
// Inside _addCourse(), after: _saveCourses();
CourseService().addCourse(
  name:     name,
  title:    '',
  score:    score,
  unit:     unit,
  year:     _selYear,
  semester: _selSem,
  clientId: courses.last.id,
).then((serverCourse) {
  // Optionally store the MongoDB _id in the Course for future edits/deletes
  debugPrint('Course saved on server: ${serverCourse['_id']}');
}).catchError((e) {
  debugPrint('Server save failed (will sync later): $e');
});
*/

// ───────────────────────────────────────────────────────────────────────────
//  8. Editing a course — after saving locally, call:
// ───────────────────────────────────────────────────────────────────────────
/*
// Inside _addCourse() when _editingCourse != null, after _saveCourses():
// You need the MongoDB _id stored on the Course. Add a `serverId` field
// to your Course class (see §11 below), then:
if (_editingCourse?.serverId != null) {
  CourseService().updateCourse(
    id:       _editingCourse!.serverId!,
    name:     name,
    score:    score,
    unit:     unit,
    year:     _selYear,
    semester: _selSem,
  ).catchError((e) => debugPrint('Server update failed: $e'));
}
*/

// ───────────────────────────────────────────────────────────────────────────
//  9. Deleting a course — after the local setState in _deleteCourse():
// ───────────────────────────────────────────────────────────────────────────
/*
// Inside _deleteCourse(), after setState():
if (c.serverId != null) {
  CourseService().deleteCourse(c.serverId!).catchError(
    (e) => debugPrint('Server delete failed: $e'),
  );
}
*/

// ───────────────────────────────────────────────────────────────────────────
//  10. Clear all — replace _clearAll() body:
// ───────────────────────────────────────────────────────────────────────────
/*
void _clearAll() async {
  final ok = await _confirm(
    'Clear All Courses',
    'This will permanently delete ALL saved courses.',
    'Clear All',
  );
  if (ok) {
    setState(() { courses.clear(); currentPage = 0; });
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('courses');
    if (_pageCtrl.hasClients) _pageCtrl.jumpToPage(0);

    // Also clear on server
    CourseService().deleteAllCourses().catchError(
      (e) => debugPrint('Server clear failed: $e'),
    );

    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('All courses cleared')));
    }
  }
}
*/

// ───────────────────────────────────────────────────────────────────────────
//  11. DELETE ACCOUNT — replace _deleteAccount() body:
// ───────────────────────────────────────────────────────────────────────────
/*
void _deleteAccount() async {
  final ok = await _confirm(
    'Delete Account',
    'This permanently deletes your profile and ALL course data. Cannot be undone.',
    'Delete Account',
    destructive: true,
  );
  if (ok) {
    try {
      await ProfileService().deleteAccount();   // deletes from server + clears tokens
    } catch (_) {}
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    if (!mounted) return;
    Navigator.of(context)
        .pushAndRemoveUntil(_fade_(const LoginScreen()), (_) => false);
  }
}
*/

// ───────────────────────────────────────────────────────────────────────────
//  12. Edit Profile — replace the onPressed save in _showEditProfile():
// ───────────────────────────────────────────────────────────────────────────
/*
onPressed: () async {
  if (!fk.currentState!.validate()) return;
  final updated = StudentProfile(
    name:         nameC.text.trim(),
    email:        emailC.text.trim(),
    matricNumber: matricC.text.trim(),
    school:       schoolC.text.trim(),
    faculty:      facC.text.trim(),
    department:   deptC.text.trim(),
  );
  setState(() => profile = updated);
  _saveProfile();       // local
  Navigator.pop(ctx);

  // Push to server in background
  ProfileService().updateProfile(updated.toMap()).then((_) {
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Profile updated ✓')));
  }).catchError((e) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('Local saved; server: $e')));
  });
},
*/

// ───────────────────────────────────────────────────────────────────────────
//  13. GradingModel save — in _showGradingSettings() after setState:
// ───────────────────────────────────────────────────────────────────────────
/*
// After: _saveGrading(); Navigator.pop(ctx);
ProfileService().updateGrading(
  grading.rules.map((r) => {
    'grade':      r.grade,
    'minScore':   r.minScore,
    'gradePoint': r.gradePoint,
  }).toList(),
).catchError((e) => debugPrint('Grading server save failed: $e'));
*/

// ───────────────────────────────────────────────────────────────────────────
//  14. Add `serverId` to the Course class in main.dart
//      (needed for edit/delete to find the MongoDB document)
// ───────────────────────────────────────────────────────────────────────────
/*
class Course {
  String  id;           // local Flutter ID (unchanged)
  String? serverId;     // ← ADD THIS: MongoDB _id from server
  String  name;
  String  title;
  int     score, unit, year, semester;

  // ... keep existing constructors unchanged ...

  // Add a factory to build from the server JSON response:
  factory Course.fromServerMap(Map<String, dynamic> m) => Course.withId(
    m['clientId'] as String? ?? '',        // restore Flutter clientId
    m['name']     as String? ?? '',
    m['title']    as String? ?? '',
    (m['score']   as num).toInt(),
    (m['unit']    as num).toInt(),
    (m['year']    as num).toInt(),
    (m['semester']as num).toInt(),
  )..serverId = m['_id'] as String?;

  // Update toMap() to include serverId:
  Map<String, dynamic> toMap() => {
    'id':       id,
    'serverId': serverId,
    'name':     name,
    'title':    title,
    'score':    score,
    'unit':     unit,
    'year':     year,
    'semester': semester,
  };

  // Update fromMap() to restore serverId:
  factory Course.fromMap(Map<String, dynamic> m) {
    final c = Course.withId(
      m['id'] ?? '${DateTime.now().microsecondsSinceEpoch}_${(m['name']??'').hashCode}',
      m['name']     ?? '',
      m['title']    ?? '',
      m['score']    ?? 0,
      m['unit']     ?? 1,
      m['year']     ?? 1,
      m['semester'] ?? 1,
    );
    c.serverId = m['serverId'] as String?;
    return c;
  }
}
*/
