// routes/paymentWebhook.js
//
// Paystack calls this URL when a payment succeeds, even if the student closed
// the page or our server was asleep (Paystack retries until it gets a 200).
//
// IMPORTANT: this must be mounted BEFORE express.json() and BEFORE the rate
// limiter in server.js (see server_patch.md), because the signature is checked
// against the exact raw bytes Paystack sent.

const paystack = require('../utils/paystack');
const { settleByReference } = require('../utils/settlePayment');

module.exports = async (req, res) => {
  // 1. Is this really from Paystack?
  const signature = req.headers['x-paystack-signature'];
  if (!paystack.validSignature(req.body, signature)) {
    return res.sendStatus(401);
  }

  // 2. Read the event
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (_) {
    return res.sendStatus(400);
  }

  // 3. We only care about successful charges. Everything else: say "got it".
  if (!event || event.event !== 'charge.success' || !event.data || !event.data.reference) {
    return res.sendStatus(200);
  }

  try {
    // settleByReference asks Paystack again and checks the amount, so even a
    // correctly signed message is never trusted on its own.
    await settleByReference(event.data.reference);
    return res.sendStatus(200);
  } catch (err) {
    // 500 makes Paystack try again later
    console.error('[payments] webhook could not settle:', err && err.message);
    return res.sendStatus(500);
  }
};