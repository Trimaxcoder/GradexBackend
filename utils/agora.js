// utils/agora.js
//
// Makes the short-lived pass (token) a phone needs to join one call.
// Needs two environment variables on Render:
//   AGORA_APP_ID
//   AGORA_APP_CERTIFICATE   (secret, never put it in the app)

const { RtcTokenBuilder, RtcRole } = require('agora-token');

const appId = () => String(process.env.AGORA_APP_ID || '').trim();
const cert  = () => String(process.env.AGORA_APP_CERTIFICATE || '').trim();

const isConfigured = () => !!appId() && !!cert();

// Caller always joins as 1, callee as 2. Only these two numbers are ever used,
// and each token is valid for one channel only.
const CALLER_UID = 1;
const CALLEE_UID = 2;

/** A pass for one person to join one call, valid for ttlSeconds. */
const makeToken = (channel, uid, ttlSeconds) => {
  // agora-token takes "seconds from now", not a clock time
  return RtcTokenBuilder.buildTokenWithUid(
    appId(),
    cert(),
    channel,
    uid,
    RtcRole.PUBLISHER,
    ttlSeconds,
    ttlSeconds
  );
};

module.exports = { isConfigured, appId, makeToken, CALLER_UID, CALLEE_UID };