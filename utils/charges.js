// utils/charges.js
//
// Pure money maths, no database and no network, so it is easy to test.
// ALL amounts are in kobo (₦1 = 100 kobo). Never use decimals for money.
//
// How a payment is split (the student pays everything on top):
//   due      = what the class rep must receive            (e.g. ₦5,000)
//   service  = SchoolLife's small fee                      (1%, min ₦30, max ₦200)
//   gateway  = the payment company's fee, added on top so the rep gets all of "due"
//   total    = due + service + gateway   <- this is what the student is charged
//
// The rep receives exactly `due`. SchoolLife keeps `total - due` and pays the
// payment company's fee out of it, so what is left is the service fee.

// Paystack's published Nigerian price: 1.5% + ₦100 (the ₦100 is waived for
// payments under ₦2,500) and the fee never goes above ₦2,000.
// If the payment company changes its prices, change these four numbers.
const PCT = 0.015;
const FLAT = 10000;
const WAIVED_BELOW = 250000;
const CAP = 200000;

// SchoolLife's own fee. Can be changed in .env without touching the code.
const SERVICE_PCT = Number(process.env.SERVICE_FEE_PCT) || 0.01;
const SERVICE_MIN = Number(process.env.SERVICE_FEE_MIN_KOBO) || 3000; // ₦30
const SERVICE_MAX = Number(process.env.SERVICE_FEE_MAX_KOBO) || 20000; // ₦200

// Safety limits for one due. Raise MAX_DUE_NAIRA in .env once you trust the system.
const MIN_DUE_KOBO = 20000; // ₦200
const MAX_DUE_KOBO = (Number(process.env.MAX_DUE_NAIRA) || 200000) * 100;

const serviceFee = (dueKobo) =>
  Math.min(Math.max(Math.round(dueKobo * SERVICE_PCT), SERVICE_MIN), SERVICE_MAX);

// What the payment company would take from a payment of `total`
const gatewayFee = (total) =>
  Math.min(Math.round(total * PCT) + (total >= WAIVED_BELOW ? FLAT : 0), CAP);

// Smallest whole-naira total whose amount after the gateway fee is at least `base`
const totalFor = (base) => {
  let total = Math.ceil(base / (1 - PCT));
  if (total >= WAIVED_BELOW) total = Math.ceil((base + FLAT) / (1 - PCT));
  if (gatewayFee(total) >= CAP) total = base + CAP;

  total = Math.ceil(total / 100) * 100; // whole naira

  // safety: rounding can cross the ₦2,500 line, so check and nudge up if needed
  for (let i = 0; i < 10000 && total - gatewayFee(total) < base; i++) total += 100;
  return total;
};

const quoteFor = (dueKobo) => {
  const due = Math.round(dueKobo);
  const service = serviceFee(due);
  const total = totalFor(due + service);
  return {
    dueKobo: due,
    serviceKobo: service,
    totalKobo: total,
    // everything on top of the due (service fee + payment company fee)
    feesKobo: total - due,
  };
};

module.exports = {
  quoteFor,
  gatewayFee,
  serviceFee,
  MIN_DUE_KOBO,
  MAX_DUE_KOBO,
};