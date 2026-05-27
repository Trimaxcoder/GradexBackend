# CGPA Calculator — Node.js + MongoDB Backend

Complete REST API with JWT authentication for the Flutter CGPA Calculator app.

---

## Project Structure

```
cgpa-backend/
├── server.js                        # Express entry point
├── package.json
├── .env.example                     # Copy to .env and fill values
├── config/
│   └── db.js                        # MongoDB connection
├── models/
│   ├── User.js                      # User + embedded profile/grading
│   └── Course.js                    # Course documents
├── middleware/
│   ├── auth.js                      # JWT protect middleware + token helpers
│   └── errorHandler.js              # Global error + 404 handler
├── routes/
│   ├── auth.js                      # Register / Login / Refresh / Logout / Me
│   ├── profile.js                   # Profile CRUD + grading + change-password
│   └── courses.js                   # Courses CRUD + bulk sync
└── flutter_integration/
    ├── api_service.dart             # Drop into lib/services/ in Flutter
    └── integration_patches.dart    # Step-by-step main.dart changes
```

---

## Quick Start

### 1. Install dependencies
```bash
cd cgpa-backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — set MONGO_URI and generate a strong JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Start the server
```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm start
```

### 4. Verify
```
GET http://localhost:5000/health
→ { "success": true, "status": "OK", ... }
```

---

## API Reference

### Auth  `/api/auth`

| Method | Path         | Auth | Description                      |
|--------|--------------|------|----------------------------------|
| POST   | /register    | ✗    | Create account, returns tokens   |
| POST   | /login       | ✗    | Login, returns tokens            |
| POST   | /refresh     | ✗    | Exchange refresh → new tokens    |
| POST   | /logout      | ✓    | Invalidate refresh token         |
| GET    | /me          | ✓    | Get current user data            |

**Register body:**
```json
{
  "email": "student@uni.edu",
  "password": "mypassword",
  "profile": {
    "name": "John Doe",
    "matricNumber": "U2020/12345",
    "department": "Computer Science",
    "faculty": "Engineering",
    "school": "University of Port Harcourt"
  }
}
```

**Login response:**
```json
{
  "success": true,
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": { "id": "...", "email": "...", "profile": {...}, "grading": {...} }
}
```

---

### Profile  `/api/profile`  🔒

| Method | Path              | Description                 |
|--------|-------------------|-----------------------------|
| GET    | /                 | Get profile                 |
| PUT    | /                 | Update profile fields       |
| PUT    | /grading          | Save custom grading rules   |
| PUT    | /change-password  | Change password             |
| DELETE | /                 | Delete account + all data   |

---

### Courses  `/api/courses`  🔒

| Method | Path     | Description                      |
|--------|----------|----------------------------------|
| GET    | /        | Get all courses (filter by ?year=&semester=) |
| POST   | /        | Add a single course              |
| PUT    | /:id     | Update a course by MongoDB _id   |
| DELETE | /:id     | Delete a course by MongoDB _id   |
| DELETE | /        | Delete ALL courses               |
| POST   | /sync    | Bidirectional sync (startup)     |

**Add course body:**
```json
{
  "name": "MTH101",
  "title": "Elementary Mathematics I",
  "score": 78,
  "unit": 3,
  "year": 1,
  "semester": 1,
  "clientId": "flutter_local_id_here"
}
```

**Sync body:**
```json
{
  "courses": [
    { "name": "MTH101", "score": 78, "unit": 3, "year": 1, "semester": 1 },
    { "name": "ENG101", "score": 65, "unit": 2, "year": 1, "semester": 1 }
  ]
}
```

---

## Flutter Integration

### Step 1 — Copy the service file
```
cp flutter_integration/api_service.dart <your_flutter_project>/lib/services/api_service.dart
```

### Step 2 — Add http dependency
```yaml
# pubspec.yaml
dependencies:
  http: ^1.2.1
```

### Step 3 — Update baseUrl
In `api_service.dart`, set `ApiConfig.baseUrl`:
- **Android emulator:** `http://10.0.2.2:5000/api`
- **iOS simulator:**    `http://127.0.0.1:5000/api`
- **Physical device:**  `http://<PC-LAN-IP>:5000/api`  (e.g. `http://192.168.1.5:5000/api`)
- **Production:**       `https://yourdomain.com/api`

### Step 4 — Apply patches
Open `flutter_integration/integration_patches.dart` and follow the numbered
sections (1–14) to modify your existing `main.dart`.

---

## Architecture Decisions

### Offline-first
The Flutter app always reads/writes SharedPreferences first. Server calls
happen in the background. On startup, `syncCourses()` merges local data to
the server and pulls the authoritative list back.

### JWT Flow
```
Register/Login → accessToken (7d) + refreshToken (30d)
                        │
Every API request ──────┤ Authorization: Bearer <accessToken>
                        │
Token expires ──────────┤ POST /auth/refresh → new token pair
                        │
Logout ─────────────────┘ refreshToken nulled on server
```

### Duplicate prevention
- **Server:** compound unique index on `(userId, name, unit, year, semester)`
- **Flutter:** existing key-set check before inserting
- **Sync:** server skips existing keys, returns 409 with existing doc

---

## Production Checklist
- [ ] Set `NODE_ENV=production`
- [ ] Use a strong 64-char `JWT_SECRET`
- [ ] Point `MONGO_URI` to MongoDB Atlas
- [ ] Enable HTTPS (use nginx reverse proxy or a platform like Railway/Render)
- [ ] Set `CORS_ORIGIN` to your app's domain
- [ ] Configure proper rate limits for your traffic
