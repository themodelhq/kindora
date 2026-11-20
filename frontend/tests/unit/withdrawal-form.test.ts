import { describe, expect, it } from 'vitest';

import { PAYOUT_PROVIDERS, validateSettleInput } from '@/lib/withdrawal-form';

describe('validateSettleInput (manual settlement form, v1.0.4 §10)', () => {
  const baseInput = {
    // v1.0.10 §13 — the allowlisted manual channel replaces the stale
    // PAYSTACK_TRANSFER fixture (API payouts are NEVER manual-settle inputs).
    payoutProvider: 'MANUAL_BANK_TRANSFER',
    providerTransferRef: 'TRF-88H2K4M9',
    evidenceFileId: 'file-abc123',
  };

  it('rejects an empty payoutProvider and an empty providerTransferRef', () => {
    const errors = validateSettleInput({ payoutProvider: '', providerTransferRef: '', evidenceFileId: 'file-abc123' });
    expect(errors.payoutProvider).toBeTruthy();
    expect(errors.providerTransferRef).toBeTruthy();
  });

  it('rejects a whitespace-only providerTransferRef', () => {
    const errors = validateSettleInput({ payoutProvider: 'MANUAL_BANK', providerTransferRef: '  ', evidenceFileId: 'file-abc123' });
    expect(errors.providerTransferRef).toBeTruthy();
  });

  it('rejects a whitespace-only payoutProvider (v1.0.8+ manual-channel allowlist contract)', () => {
    // v1.0.10 §13 — the stale pre-allowlist expectation ("3 spaces pass") was
    // updated: settlement inputs are restricted to the APPROVED MANUAL
    // channels, so a whitespace-only value is rejected like any other
    // non-allowlisted provider string.
    const errors = validateSettleInput({ payoutProvider: '   ', providerTransferRef: 'TRF-1', evidenceFileId: 'file-abc123' });
    expect(errors.payoutProvider).toBeTruthy();
  });

  it('requires a REGISTERED evidence file id (arbitrary URLs are rejected by the API)', () => {
    const missing = validateSettleInput({ ...baseInput, evidenceFileId: '' });
    expect(missing.evidenceFileId).toBeTruthy();

    const tooShort = validateSettleInput({ ...baseInput, evidenceFileId: 'abc' });
    expect(tooShort.evidenceFileId).toBeTruthy();

    const ok = validateSettleInput(baseInput);
    expect(ok.evidenceFileId).toBeUndefined();
  });

  it('accepts a complete valid submission with the optional transaction id', () => {
    const errors = validateSettleInput({
      payoutProvider: 'MANUAL_BANK_TRANSFER',
      providerTransferRef: 'TRF-88H2K4M9',
      payoutProviderTxnId: 'txn_123456',
      evidenceFileId: 'file-abc123',
    });
    expect(errors).toEqual({});
  });

  it('accepts a valid submission without any optional fields', () => {
    const errors = validateSettleInput({ payoutProvider: 'MANUAL_BANK_TRANSFER', providerTransferRef: 'TRF-1', evidenceFileId: 'file-abc123' });
    expect(errors).toEqual({});
  });

  it('rejects a providerTransferRef shorter than 3 characters (backend MinLength)', () => {
    const errors = validateSettleInput({ payoutProvider: 'MANUAL_BANK', providerTransferRef: 'ab', evidenceFileId: 'file-abc123' });
    expect(errors.providerTransferRef).toBeTruthy();
  });

  it('rejects a payoutProvider shorter than 2 characters (backend MinLength)', () => {
    const errors = validateSettleInput({ payoutProvider: 'X', providerTransferRef: 'TRF-1', evidenceFileId: 'file-abc123' });
    expect(errors.payoutProvider).toBeTruthy();
  });

  it('accepts every known provider constant from PAYOUT_PROVIDERS', () => {
    for (const provider of PAYOUT_PROVIDERS) {
      const errors = validateSettleInput({ payoutProvider: provider, providerTransferRef: 'TRF-2024-0001', evidenceFileId: 'file-abc123' });
      expect(errors).toEqual({});
    }
  });

  it('rejects API and legacy provider names at the form layer (v1.0.10 §13 — allowlist contract regression)', () => {
    for (const provider of ['PAYSTACK_TRANSFER', 'FLUTTERWAVE_TRANSFER', 'MOCK', 'STRIPE', 'MANUAL_BANK']) {
      const errors = validateSettleInput({ payoutProvider: provider, providerTransferRef: 'TRF-2024-0001', evidenceFileId: 'file-abc123' });
      expect(errors.payoutProvider).toBeTruthy();
    }
  });

  it('never validates an evidenceUrl field — evidence must be a registered file id', () => {
    // The mark-paid-era evidenceUrl field is gone: validateSettleInput has no
    // URL field at all, and the settle API rejects arbitrary evidence URLs.
    const errors = validateSettleInput(baseInput);
    expect(Object.keys(errors).sort()).toEqual([]);
    expect('evidenceUrl' in errors).toBe(false);
  });
});
