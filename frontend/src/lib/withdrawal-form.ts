/**
 * Manual-settlement form validation.
 *
 * v1.0.8 §3.2/§13 — the settlement channel select offers ONLY the explicit
 * server-side allowlisted MANUAL channels. API providers (PAYSTACK,
 * PAYSTACK_TRANSFER, FLUTTERWAVE, FLUTTERWAVE_TRANSFER, STRIPE, PAYPAL) are
 * NOT offered and NOT accepted by the API's DTO validation either — frontend
 * restrictions are supplementary; the backend remains the security boundary.
 */

export const MANUAL_SETTLEMENT_CHANNELS = [
  'MANUAL_BANK_TRANSFER',
  'CASH',
  'APPROVED_OFFLINE_CHANNEL',
] as const;

/** Legacy alias kept for READ-side rendering of historical rows only. */
export const LEGACY_MANUAL_CHANNEL_LABEL = 'MANUAL_BANK';

export const PAYOUT_PROVIDERS = MANUAL_SETTLEMENT_CHANNELS;

export const PAYOUT_PROVIDER_LABELS: Record<string, string> = {
  MANUAL_BANK_TRANSFER: 'Manual bank transfer',
  CASH: 'Cash',
  APPROVED_OFFLINE_CHANNEL: 'Approved offline channel',
  // Read-side labels for historical rows (never selectable for new settlements):
  MANUAL_BANK: 'Manual bank transfer (legacy)',
  PAYSTACK_TRANSFER: 'Paystack transfer (API payout)',
  FLUTTERWAVE_TRANSFER: 'Flutterwave transfer (API payout)',
  MOCK: 'Mock (non-production)',
};

export interface SettleFormInput {
  payoutProvider: string;
  providerTransferRef: string;
  payoutProviderTxnId?: string;
  evidenceFileId: string;
}

export interface SettleFormErrors {
  payoutProvider?: string;
  providerTransferRef?: string;
  evidenceFileId?: string;
}

/**
 * Settlement requires one of the APPROVED MANUAL channels, the transfer
 * reference (proof of settlement) and a REGISTERED private evidence file id.
 * API providers are rejected here AND structurally by the backend DTO.
 */
export function validateSettleInput(input: Partial<SettleFormInput>): SettleFormErrors {
  const errors: SettleFormErrors = {};
  if (!input.payoutProvider) {
    errors.payoutProvider = 'Select the manual settlement channel the money was sent through.';
  } else if (!(MANUAL_SETTLEMENT_CHANNELS as readonly string[]).includes(input.payoutProvider)) {
    errors.payoutProvider = 'Only approved manual settlement channels can be recorded here — API payouts are settled by provider verification.';
  }
  if (!input.providerTransferRef || input.providerTransferRef.trim().length < 3) {
    errors.providerTransferRef = 'The transfer reference is required (proof of settlement).';
  }
  if (!input.evidenceFileId || input.evidenceFileId.length < 6) {
    errors.evidenceFileId = 'Upload the transfer receipt as payout evidence (scanned, private).';
  }
  return errors;
}
