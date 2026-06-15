const admin = require('firebase-admin');

let initialized = false;

function getFirebaseAdmin() {
  if (!initialized) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:    process.env.FIREBASE_PROJECT_ID,
        clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
        // Replace \n in env var with actual newlines
        privateKey:   process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    initialized = true;
  }
  return admin;
}

/**
 * Send a push notification to a list of FCM tokens.
 * @param {string[]} tokens
 * @param {string} title
 * @param {string} body
 * @param {object} data  — extra key/value pairs sent to the app
 */
async function sendToTokens(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;

  const fb = getFirebaseAdmin();

  // Send in batches of 500 (FCM limit)
  const batchSize = 500;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    const message = {
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      tokens: batch,
    };
    try {
      const response = await fb.messaging().sendEachForMulticast(message);
      console.log(`FCM sent: ${response.successCount} ok, ${response.failureCount} failed`);
    } catch (err) {
      console.error('FCM batch error:', err);
    }
  }
}

module.exports = { sendToTokens };