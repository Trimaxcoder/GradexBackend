// models/PayoutAccount.js
//
// A bank account that can receive class dues. The full account number is NOT
// stored here: the payment company keeps it (as a "subaccount"). We keep only
// the last 4 digits for display and a one-way fingerprint to block duplicates.

const mongoose = require('mongoose');

const PayoutAccountSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    bankCode: { type: String, required: true },
    bankName: { type: String, required: true },
    accountLast4: { type: String, required: true },

    // Name the BANK returned for this account (not typed by the user)
    accountName: { type: String, required: true },

    // Payment company's code for this account, e.g. ACCT_xxxxxxxx
    subaccountCode: { type: String, required: true, unique: true },

    // HMAC of bankCode + account number, so the same account is not added twice
    fingerprint: { type: String, required: true },

    // active  = can receive payments
    // frozen  = blocked by a SchoolLife super admin (e.g. after a scam report)
    // removed = removed by its owner
    status: {
      type: String,
      enum: ['active', 'frozen', 'removed'],
      default: 'active',
    },
  },
  { timestamps: true },
);

PayoutAccountSchema.index({ owner: 1, fingerprint: 1 }, { unique: true });

module.exports = mongoose.model('PayoutAccount', PayoutAccountSchema);