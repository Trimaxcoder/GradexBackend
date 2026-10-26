// utils/cloudinary.js
//
// Chat attachments (photos, files, voice notes) are stored on Cloudinary.
//
// How it works:
//  1. The app asks the backend for an upload "permission slip" for ONE class.
//     The backend checks the person is an active member, then signs the upload
//     with the API secret. The secret never leaves the server.
//  2. The app uploads the file straight to Cloudinary with that slip. The slip
//     only allows uploads into this class's folder and expires in an hour.
//  3. The app sends the chat message with the file's link. The server only
//     accepts links that point into this class's folder on OUR Cloudinary
//     account, so nobody can attach an outside link.

const crypto = require('crypto');

const MAX_FILE_BYTES    = 10 * 1024 * 1024; // 10 MB (free Cloudinary plan limit)
const MAX_AUDIO_SECONDS = 300;              // 5 minutes per voice note
const KINDS             = ['image', 'file', 'audio'];

const cloudName = () => process.env.CLOUDINARY_CLOUD_NAME || '';
const apiKey    = () => process.env.CLOUDINARY_API_KEY || '';
const apiSecret = () => process.env.CLOUDINARY_API_SECRET || '';

const isConfigured = () => !!(cloudName() && apiKey() && apiSecret());

const classFolder = (classId) => `schoollife/classes/${classId}`;

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

/** Signed upload details for one class. Valid for about an hour. */
function signUpload(classId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder    = classFolder(classId);
  // Cloudinary signs the parameters in alphabetical order, then the secret
  const signature = sha1(`folder=${folder}&timestamp=${timestamp}${apiSecret()}`);

  return {
    cloudName: cloudName(),
    apiKey:    apiKey(),
    timestamp,
    folder,
    signature,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName()}/auto/upload`,
    maxBytes:  MAX_FILE_BYTES,
  };
}

/** true only for a link into THIS class's folder on OUR Cloudinary account. */
function isValidAssetUrl(url, classId) {
  if (typeof url !== 'string' || url.length > 600 || /\s/.test(url)) return false;
  const prefix = `https://res.cloudinary.com/${cloudName()}/`;
  if (!cloudName() || !url.startsWith(prefix)) return false;
  if (!url.includes('/upload/')) return false;
  return url.includes(`/${classFolder(classId)}/`);
}

/**
 * Checks an attachment sent by the app and returns a clean copy,
 * or null if anything is wrong with it.
 */
function cleanAttachment(raw, classId) {
  if (!raw || typeof raw !== 'object') return null;
  if (!KINDS.includes(raw.kind)) return null;
  if (!isValidAssetUrl(raw.url, classId)) return null;

  const size = Number(raw.size) || 0;
  if (size < 0 || size > MAX_FILE_BYTES) return null;

  const duration = Number(raw.duration) || 0;
  if (duration < 0 || duration > MAX_AUDIO_SECONDS) return null;

  return {
    kind:     raw.kind,
    url:      raw.url,
    name:     String(raw.name || '').slice(0, 120),
    size:     Math.round(size),
    mime:     String(raw.mime || '').slice(0, 100),
    duration: raw.kind === 'audio' ? Math.round(duration) : 0,
  };
}

/** Short text for push notifications and reply previews. */
function attachmentLabel(att) {
  if (!att) return '';
  if (att.kind === 'image') return 'Photo';
  if (att.kind === 'audio') return 'Voice note';
  return att.name ? `File: ${att.name}` : 'File';
}

/**
 * Deletes a file from Cloudinary (used when a message is deleted).
 * Best effort: it logs and never throws, so a failure can't break the chat.
 */
async function destroyAsset(url) {
  try {
    if (!isConfigured() || typeof fetch !== 'function') return;

    const m = /\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)$/.exec(String(url));
    if (!m) return;

    const resourceType = m[1];
    let publicId = decodeURIComponent(m[2]);
    // images and audio/video are stored without their extension, raw files keep it
    if (resourceType !== 'raw') publicId = publicId.replace(/\.[^./]+$/, '');

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sha1(`public_id=${publicId}&timestamp=${timestamp}${apiSecret()}`);

    const body = new URLSearchParams({
      public_id: publicId,
      timestamp: String(timestamp),
      api_key:   apiKey(),
      signature,
    });

    await fetch(`https://api.cloudinary.com/v1_1/${cloudName()}/${resourceType}/destroy`, {
      method: 'POST',
      body,
    });
  } catch (err) {
    console.error('Cloudinary delete failed:', err.message);
  }
}

module.exports = {
  isConfigured,
  signUpload,
  cleanAttachment,
  attachmentLabel,
  destroyAsset,
  MAX_FILE_BYTES,
  MAX_AUDIO_SECONDS,
};