const admin = require('firebase-admin');

let initialized = false;

const APP_ICON_URL = 'https://cgpa-calculator-8e6ae.web.app/icons/Icon-192.png'; // ← your hosted icon

function getFirebaseAdmin() {
  if (!initialized) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:    process.env.FIREBASE_PROJECT_ID,
        clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
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

  const batchSize = 500;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    const message = {
      notification: {
        title,
        body,
        imageUrl: APP_ICON_URL,  // ← shows logo in the notification on supported platforms
      },
      android: {
        notification: {
          icon: 'ic_notification', // small status bar icon (uses your app's mipmap if set)
          imageUrl: APP_ICON_URL,
        },
      },
      webpush: {
        notification: {
          icon: APP_ICON_URL,     // shown on the left of web notifications
          image: APP_ICON_URL,
        },
      },
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