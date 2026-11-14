// utils/settlePayment.js
//
// The ONE place where a payment becomes "paid". It is used by both the webhook
// and the "I have paid" check from the app, so the rules are identical.
//
// Safe to call any number of times for the same reference:
//   - it asks Paystack what really happened (never trusts the caller)
//   - it checks currency and the exact amount against what we expected
//   - it marks the payment successful at most once

const FormPayment = require('../models/FormPayment');
const FormSubmission = require('../models/FormSubmission');
const paystack = require('./paystack');

// Returns { found: false } when the reference is not ours, else
// { found: true, state: 'success' | 'pending' | 'failed' | 'mismatch', payment }
// Throws if Paystack cannot be reached, so the caller can retry later.
const settleByReference = async (reference) => {
  const pay = await FormPayment.findOne({ reference: String(reference) });
  if (!pay) return { found: false };

  if (pay.status === 'success') return { found: true, state: 'success', payment: pay };
  if (pay.status === 'mismatch') return { found: true, state: 'mismatch', payment: pay };

  const tx = await paystack.verify(pay.reference);

  // ── Paid ──
  if (tx.status === 'success') {
    const amountOk = Number(tx.amount) === pay.totalKobo;
    const currencyOk = tx.currency === 'NGN';
    const refOk = tx.reference === pay.reference;

    if (!amountOk || !currencyOk || !refOk) {
      await FormPayment.updateOne(
        { _id: pay._id, status: { $ne: 'success' } },
        { status: 'mismatch', providerTxId: String(tx.id || '') },
      );
      console.error(
        `[payments] MISMATCH ref=${pay.reference} expected=${pay.totalKobo} got=${tx.amount} ${tx.currency}`,
      );
      return { found: true, state: 'mismatch', payment: pay };
    }

    // Was this response already paid by another attempt (e.g. two tabs)?
    const alreadyPaid = await FormPayment.exists({
      submission: pay.submission,
      status: 'success',
      _id: { $ne: pay._id },
    });

    // Atomic: only ONE caller can flip it from "not success" to "success"
    const updated = await FormPayment.findOneAndUpdate(
      { _id: pay._id, status: { $ne: 'success' } },
      {
        status: 'success',
        paidAt: tx.paid_at ? new Date(tx.paid_at) : new Date(),
        channel: String(tx.channel || ''),
        providerTxId: String(tx.id || ''),
        duplicate: !!alreadyPaid,
      },
      { new: true },
    );

    const finalPay = updated || (await FormPayment.findById(pay._id));

    if (updated) {
      await FormSubmission.updateOne(
        { _id: pay.submission, paymentStatus: { $ne: 'paid' } },
        {
          paymentStatus: 'paid',
          paidAt: updated.paidAt,
          paymentRef: updated.reference,
        },
      );
      if (alreadyPaid) {
        console.error(`[payments] DUPLICATE payment ref=${pay.reference}: needs a refund`);
      }
    }
    return { found: true, state: 'success', payment: finalPay };
  }

  // ── Not paid ──
  if (tx.status === 'failed' || tx.status === 'abandoned') {
    await FormPayment.updateOne(
      { _id: pay._id, status: 'initialized' },
      { status: tx.status === 'failed' ? 'failed' : 'abandoned' },
    );
    return { found: true, state: 'failed', payment: pay };
  }

  // ongoing / pending / queued: the student may still be paying
  return { found: true, state: 'pending', payment: pay };
};

module.exports = { settleByReference };