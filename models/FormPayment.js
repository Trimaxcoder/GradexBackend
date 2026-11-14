// models/FormPayment.js
//
// One record per payment ATTEMPT. A response can have several attempts
// (e.g. the first one failed) but should end with exactly one "success".
// These records are the audit trail: never delete them.

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const FormPaymentSchema = new mongoose.Schema(
  {
    form: { type: ObjectId, ref: 'Form', required: true, index: true },
    submission: { type: ObjectId, ref: 'FormSubmission', required: true, index: true },
    payoutAccount: { type: ObjectId, ref: 'PayoutAccount', required: true },
    subaccountCode: { type: String, required: true },

    // Logged-in payer (null for guests)
    payer: { type: ObjectId, ref: 'User', default: null },
    payerEmail: { type: String, required: true },

    // Our own unique reference, created on the server. The payment company
    // sends it back to us, so it is how we match a payment to a response.
    reference: { type: String, required: true, unique: true },

    // All in kobo. These are fixed when the payment starts and are checked
    // again against what the payment company says was really paid.
    dueKobo: { type: Number, required: true },
    serviceKobo: { type: Number, required: true },
    totalKobo: { type: Number, required: true },

    // initialized = student sent to pay; success; failed; abandoned;
    // mismatch   = paid amount did not match (needs a human to look)
    status: {
      type: String,
      enum: ['initialized', 'success', 'failed', 'abandoned', 'mismatch'],
      default: 'initialized',
      index: true,
    },

    paidAt: { type: Date, default: null },
    channel: { type: String, default: '' }, // card, bank_transfer, ussd ...
    providerTxId: { type: String, default: '' },

    // true when this response was already paid by another attempt. The money
    // arrived twice, so one payment needs refunding (done on the payment
    // company's dashboard).
    duplicate: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model('FormPayment', FormPaymentSchema);