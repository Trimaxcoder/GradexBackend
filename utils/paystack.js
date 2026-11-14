// utils/paystack.js
//
// Talks to Paystack. Uses only Node's built-in modules, so nothing to install.
// The secret key lives ONLY in the server's environment (PAYSTACK_SECRET_KEY).
// It must never be put in the Flutter app, in git, or in a log.

const https = require('https');
const crypto = require('crypto');

const isConfigured = () => !!process.env.PAYSTACK_SECRET_KEY;

const request = (method, path, body) =>
  new Promise((resolve, reject) => {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) {
      const err = new Error('Payments are not set up yet.');
      err.status = 503;
      return reject(err);
    }

    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.paystack.co',
        path,
        method,
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {}

          if (res.statusCode >= 200 && res.statusCode < 300 && json && json.status) {
            return resolve(json.data);
          }
          const err = new Error((json && json.message) || 'Payment provider error.');
          err.status = res.statusCode;
          err.provider = true;
          reject(err);
        });
      },
    );

    req.on('timeout', () =>
      req.destroy(new Error('The payment provider took too long to respond.')),
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

// ── Banks (cached for 12 hours, the list rarely changes) ─────────────────────
let bankCache = { at: 0, list: [] };

const listBanks = async () => {
  if (bankCache.list.length && Date.now() - bankCache.at < 12 * 60 * 60 * 1000) {
    return bankCache.list;
  }
  const rows = await request('GET', '/bank?country=nigeria&perPage=200&use_cursor=false');
  const list = (Array.isArray(rows) ? rows : [])
    .filter((b) => b && b.code && b.name && b.active !== false)
    .map((b) => ({ name: b.name, code: String(b.code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  bankCache = { at: Date.now(), list };
  return list;
};

// Returns the account holder's name exactly as the bank has it
const resolveAccount = async (accountNumber, bankCode) => {
  const q = `account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
  const d = await request('GET', `/bank/resolve?${q}`);
  return String(d.account_name || '').trim();
};

// percentage_charge is 0 because every payment sets its own exact charge
const createSubaccount = async ({ businessName, bankCode, accountNumber }) => {
  const d = await request('POST', '/subaccount', {
    business_name: businessName,
    settlement_bank: bankCode,
    account_number: accountNumber,
    percentage_charge: 0,
  });
  return d.subaccount_code;
};

// `chargeKobo` is what SchoolLife keeps from this payment (it pays the payment
// company's fee out of it). The subaccount (the class rep) receives the rest.
const initialize = ({
  email,
  amountKobo,
  chargeKobo,
  reference,
  subaccount,
  callbackUrl,
  metadata,
}) =>
  request('POST', '/transaction/initialize', {
    email,
    amount: amountKobo,
    currency: 'NGN',
    reference,
    subaccount,
    transaction_charge: chargeKobo,
    bearer: 'account',
    callback_url: callbackUrl,
    metadata,
  });

// Asks Paystack directly what happened to a payment. This is the source of
// truth: we never believe a browser or a webhook body without checking this.
const verify = (reference) =>
  request('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

// Webhooks are signed: HMAC-SHA512 of the raw body with the secret key.
const validSignature = (rawBody, signature) => {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = {
  isConfigured,
  listBanks,
  resolveAccount,
  createSubaccount,
  initialize,
  verify,
  validSignature,
};