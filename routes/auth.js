const express = require("express");
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const {
  protect,
  generateAccessToken,
  generateRefreshToken,
} = require("../middleware/auth");

const router = express.Router();

// ── Stricter rate limit for auth endpoints ────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message: { success: false, message: "Too many attempts. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Email transporter (Gmail) ─────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // Gmail App Password (not your normal password)
  },
});

// ── Google OAuth client ───────────────────────────────────────────────────────
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Helper ────────────────────────────────────────────────────────────────────
const sendTokens = async (user, statusCode, res) => {
  const accessToken = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  res.status(statusCode).json({
    success: true,
    accessToken,
    refreshToken,
    user: {
      id: user._id,
      email: user.email,
      profile: user.profile,
      grading: user.grading,
    },
  });
};

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post(
  "/register",
  authLimiter,
  [
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("profile.name").notEmpty().withMessage("Full name is required"),
    body("profile.matricNumber")
      .notEmpty()
      .withMessage("Matric number is required"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, password, profile, grading } = req.body;

      const exists = await User.findOne({ email: email.toLowerCase() });
      if (exists) {
        return res.status(409).json({
          success: false,
          message: "An account with this email already exists.",
        });
      }

      const user = await User.create({
        email,
        password,
        profile: profile || {},
        grading: grading || { rules: [] },
      });

      await sendTokens(user, 201, res);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post(
  "/login",
  authLimiter,
  [
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, password } = req.body;

      const user = await User.findOne({ email }).select(
        "+password +refreshToken",
      );
      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password.",
        });
      }

      await sendTokens(user, 200, res);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res
        .status(401)
        .json({ success: false, message: "Refresh token required." });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    } catch {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired refresh token." });
    }

    const user = await User.findById(decoded.id).select("+refreshToken");
    if (!user || user.refreshToken !== refreshToken) {
      return res
        .status(401)
        .json({ success: false, message: "Refresh token mismatch." });
    }

    const newAccessToken = generateAccessToken(user._id);
    const newRefreshToken = generateRefreshToken(user._id);
    user.refreshToken = newRefreshToken;
    await user.save({ validateBeforeSave: false });

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post("/logout", protect, async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { refreshToken: null });
    res.json({ success: true, message: "Logged out successfully." });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get("/me", protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post("/forgot-password", authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required." });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Always return 200 — never reveal whether the email exists
    if (!user) {
      return res.json({
        success: true,
        message: "If that email is registered, a reset link has been sent.",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = token;
    user.resetPasswordExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.FRONTEND_URL || "https://yourapp.com"}/reset-password?token=${token}`;
    const userName = user.profile?.name || "there";

    await transporter.sendMail({
      from: `"Gradex" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: "Reset Your Gradex Password",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;">
          <div style="background:linear-gradient(135deg,#1565C0,#283593);padding:32px;
                      border-radius:12px 12px 0 0;text-align:center;">
            <h1 style="color:white;margin:0;font-size:26px;">🎓 Gradex</h1>
            <p style="color:rgba(255,255,255,.7);margin:8px 0 0;">Password Reset Request</p>
          </div>
          <div style="background:#f9f9f9;padding:32px;border-radius:0 0 12px 12px;">
            <h2 style="color:#1a1a1a;">Hi ${userName},</h2>
            <p style="color:#555;line-height:1.7;">
              We received a request to reset your Gradex password.<br>
              Click the button below — this link expires in <strong>1 hour</strong>.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${resetUrl}"
                 style="background:#1565C0;color:white;padding:14px 36px;
                        border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">
                Reset My Password
              </a>
            </div>
            <p style="color:#aaa;font-size:13px;">
              If the button doesn't work, copy this link:<br>
              <a href="${resetUrl}" style="color:#1565C0;word-break:break-all;">${resetUrl}</a>
            </p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#bbb;font-size:12px;margin:0;">
              If you didn't request this, you can safely ignore this email.
            </p>
          </div>
        </div>
      `,
    });

    res.json({ success: true, message: "Reset link sent successfully." });
  } catch (err) {
    console.error("[forgot-password]", err);
    next(err);
  }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Token and new password are required.",
        });
    }
    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Password must be at least 6 characters.",
        });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Reset link is invalid or has expired.",
        });
    }

    // Assign plain password — your User model's pre-save hook will hash it
    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpiry = undefined;
    await user.save();

    res.json({
      success: true,
      message: "Password reset successfully. You can now sign in.",
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/google ─────────────────────────────────────────────────────
router.post("/google", authLimiter, async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res
        .status(400)
        .json({ success: false, message: "idToken is required." });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { email, name, sub: googleId } = ticket.getPayload();

    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // New user — create account from Google profile
      user = await User.create({
        email: email.toLowerCase(),
        googleId,
        password: crypto.randomBytes(32).toString("hex"), // random, never used
        profile: { name, email },
        grading: { rules: [] },
      });
    } else if (!user.googleId) {
      // Existing email account — link Google ID
      user.googleId = googleId;
      await user.save({ validateBeforeSave: false });
    }

    await sendTokens(user, 200, res);
  } catch (err) {
    console.error("[google-auth]", err);
    res
      .status(401)
      .json({ success: false, message: "Google authentication failed." });
  }
});

module.exports = router;
