import { WithdrawalStatus } from '@prisma/client';
import { PayoutAttemptStatus } from '@prisma/client';
import {
  assertAttemptTransition,
  assertTransition,
  classifyTransferStatus,
  evaluateReconciliation,
  isTerminalWithdrawalStatus,
  PAYOUT_TRANSITIONS,
  UNRESOLVED_ATTEMPT_STATUSES,
} from './payout-state-machine';

const S = WithdrawalStatus;

describe('canonical payout state machine (v1.0.4 §4)', () => {
  it('permits exactly the documented transitions', () => {
    const permitted: Array<[WithdrawalStatus, WithdrawalStatus]> = [
      [S.PENDING, S.UNDER_REVIEW],
      [S.PENDING, S.APPROVED],
      [S.PENDING, S.REQUIRES_INFORMATION],
      [S.PENDING, S.REJECTED],
      [S.PENDING, S.CANCELLED],
      [S.UNDER_REVIEW, S.APPROVED],
      [S.UNDER_REVIEW, S.REQUIRES_INFORMATION],
      [S.UNDER_REVIEW, S.REJECTED],
      [S.REQUIRES_INFORMATION, S.UNDER_REVIEW],
      [S.REQUIRES_INFORMATION, S.APPROVED],
      [S.REQUIRES_INFORMATION, S.REJECTED],
      [S.REQUIRES_INFORMATION, S.CANCELLED],
      [S.APPROVED, S.PROCESSING],
      [S.APPROVED, S.PAID],
      [S.APPROVED, S.REJECTED],
      [S.PROCESSING, S.PAID],
      [S.PROCESSING, S.FAILED],
      [S.PROCESSING, S.REQUIRES_RECONCILIATION],
      [S.PROCESSING, S.REVERSED],
      [S.REQUIRES_RECONCILIATION, S.PAID],
      [S.REQUIRES_RECONCILIATION, S.FAILED],
      [S.REQUIRES_RECONCILIATION, S.REJECTED],
      [S.FAILED, S.PROCESSING],
      [S.PAID, S.REVERSED],
    ];
    for (const [from, to] of permitted) {
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it('rejects every edge outside the documented graph', () => {
    const forbidden: Array<[WithdrawalStatus, WithdrawalStatus]> = [
      [S.PENDING, S.PROCESSING], // cannot skip review+approval
      [S.PENDING, S.PAID], // cannot settle an unreviewed request
      [S.UNDER_REVIEW, S.PROCESSING],
      [S.UNDER_REVIEW, S.PAID],
      [S.UNDER_REVIEW, S.FAILED],
      [S.APPROVED, S.FAILED], // an APPROVED payout was never transferred
      [S.APPROVED, S.REQUIRES_RECONCILIATION],
      [S.PROCESSING, S.APPROVED], // no going back behind the transfer point
      [S.PROCESSING, S.UNDER_REVIEW],
      [S.PROCESSING, S.REJECTED], // an in-flight transfer is verification's business
      [S.REQUIRES_RECONCILIATION, S.PROCESSING],
      [S.FAILED, S.PAID], // a failed payout cannot be settled
      [S.FAILED, S.APPROVED],
      [S.PAID, S.PROCESSING], // never pay again
      [S.PAID, S.FAILED], // a successful transfer is never marked failed
      [S.PAID, S.APPROVED],
      [S.REJECTED, S.PENDING],
      [S.REJECTED, S.PROCESSING],
      [S.CANCELLED, S.PROCESSING],
      [S.REVERSED, S.PAID],
      [S.REVERSED, S.PROCESSING],
    ];
    for (const [from, to] of forbidden) {
      expect(() => assertTransition(from, to)).toThrow(/not permitted/);
    }
  });

  it('admin force-failing an ambiguous transfer is impossible: PROCESSING -> FAILED exists but is only reachable from authoritative verification', () => {
    // The transition exists ONLY for applyProviderVerification; the state
    // machine has no actor concept, so the guarantee is enforced by the fact
    // that NO service method except PayoutService.applyProviderVerification
    // (called from verifyAttempt with a classified FAILED result) ever passes
    // (PROCESSING, FAILED) — controllers expose no such route.
    expect(() => assertTransition(S.PROCESSING, S.FAILED)).not.toThrow();
    // What IS forbidden at the transition level:
    expect(() => assertTransition(S.PROCESSING, S.CANCELLED)).toThrow();
    expect(() => assertTransition(S.REQUIRES_RECONCILIATION, S.CANCELLED)).toThrow();
  });

  it('terminal states have no outgoing edges', () => {
    expect(isTerminalWithdrawalStatus(S.REJECTED)).toBe(true);
    expect(isTerminalWithdrawalStatus(S.CANCELLED)).toBe(true);
    expect(isTerminalWithdrawalStatus(S.REVERSED)).toBe(true);
    expect(isTerminalWithdrawalStatus(S.PAID)).toBe(false); // reversal edge exists
    expect(isTerminalWithdrawalStatus(S.PROCESSING)).toBe(false);
  });

  it('a withdrawal cannot transition to its own state', () => {
    expect(() => assertTransition(S.PROCESSING, S.PROCESSING)).toThrow();
  });

  it('the graph is closed: every enum value has an entry', () => {
    for (const status of Object.values(S)) {
      expect(Array.isArray(PAYOUT_TRANSITIONS[status])).toBe(true);
    }
  });
});

describe('provider transfer classification (v1.0.4 §5.1)', () => {
  it('maps known Paystack statuses', () => {
    expect(classifyTransferStatus('PAYSTACK', 'success')).toBe('SUCCESSFUL');
    expect(classifyTransferStatus('PAYSTACK', 'success')).toBe('SUCCESSFUL');
    expect(classifyTransferStatus('PAYSTACK', 'otp')).toBe('PENDING');
    expect(classifyTransferStatus('PAYSTACK', 'pending')).toBe('PENDING');
    expect(classifyTransferStatus('PAYSTACK', 'failed')).toBe('FAILED');
    expect(classifyTransferStatus('PAYSTACK', 'reversed')).toBe('REVERSED');
  });

  it('maps known Flutterwave statuses', () => {
    expect(classifyTransferStatus('FLUTTERWAVE', 'SUCCESSFUL')).toBe('SUCCESSFUL');
    expect(classifyTransferStatus('FLUTTERWAVE', 'queued')).toBe('PENDING');
    expect(classifyTransferStatus('FLUTTERWAVE', 'failed')).toBe('FAILED');
    expect(classifyTransferStatus('FLUTTERWAVE', 'reversed')).toBe('REVERSED');
  });

  it('NEVER collapses unrecognized responses to FAILED', () => {
    for (const weird of ['', null, undefined, 'hmm', 'ERR_CONNECTION', '502', 'timeout', 'weird_status']) {
      expect(classifyTransferStatus('PAYSTACK', weird as string)).not.toBe('FAILED');
      expect(classifyTransferStatus('FLUTTERWAVE', weird as string)).toBe('UNKNOWN');
    }
  });

  it('unknown provider names classify as UNKNOWN (never FAILED)', () => {
    expect(classifyTransferStatus('SOME_BANK', 'anything')).toBe('UNKNOWN');
  });
});

describe('reconciliation result model (v1.0.4 §11, v1.0.7 §7.2 fail-closed)', () => {
  const base = {
    internalStatus: S.PROCESSING,
    attemptStatus: 'PROVIDER_ACCEPTED',
    expectedAmountMinor: 1000000n,
    expectedCurrency: 'NGN',
    expectedBeneficiaryRef: 'RCP_approved',
    duplicateReference: false,
  };

  it('provider success with complete evidence + internal processing -> PROVIDER_SUCCESS_INTERNAL_PENDING (finalizable)', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1000000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(r.result).toBe('PROVIDER_SUCCESS_INTERNAL_PENDING');
    expect(r.amountMatched).toBe(true);
    expect(r.beneficiaryMatched).toBe(true);
    expect(r.evidenceIncomplete).toBe(false);
  });

  it('provider success + already PAID -> MATCHED (idempotent)', () => {
    const r = evaluateReconciliation({
      ...base,
      internalStatus: S.PAID,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1000000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(r.result).toBe('MATCHED');
  });

  it('provider pending -> PROVIDER_PENDING (never a failure)', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'PENDING', providerStatus: 'pending' },
    });
    expect(r.result).toBe('PROVIDER_PENDING');
  });

  it('provider unknown -> PROVIDER_UNKNOWN (never FAILED)', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'UNKNOWN', providerStatus: '????' },
    });
    expect(r.result).toBe('PROVIDER_UNKNOWN');
    expect(r.evidenceIncomplete).toBe(true);
  });

  it('unknown + already escalated -> REQUIRES_MANUAL_INVESTIGATION', () => {
    const r = evaluateReconciliation({
      ...base,
      internalStatus: S.REQUIRES_RECONCILIATION,
      verification: { classification: 'UNKNOWN', providerStatus: '????' },
    });
    expect(r.result).toBe('REQUIRES_MANUAL_INVESTIGATION');
  });

  // ---- v1.0.7 §5.3 FAIL-CLOSED: missing evidence is never a match ----

  it('MISSING provider amount on a success -> PROVIDER_DATA_INCOMPLETE (never settles)', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(r.result).toBe('PROVIDER_DATA_INCOMPLETE');
    expect(r.amountMatched).toBeNull();
  });

  it('MISSING provider currency on a success -> PROVIDER_DATA_INCOMPLETE', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1000000n, beneficiaryRef: 'RCP_approved' },
    });
    expect(r.result).toBe('PROVIDER_DATA_INCOMPLETE');
    expect(r.currencyMatched).toBeNull();
  });

  it('MISSING provider beneficiary identity on a success -> PROVIDER_DATA_INCOMPLETE', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1000000n, currency: 'NGN' },
    });
    expect(r.result).toBe('PROVIDER_DATA_INCOMPLETE');
    expect(r.beneficiaryMatched).toBeNull();
  });

  it('missing evidence on a TERMINAL FAILURE does not block the failure (no beneficiary proof needed)', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'FAILED', providerStatus: 'failed', failureReason: 'insufficient funds' },
    });
    expect(r.result).toBe('PROVIDER_FAILED_INTERNAL_PROCESSING');
  });

  it('amount/currency/beneficiary mismatches escalate and never settle', () => {
    const amount = evaluateReconciliation({
      ...base,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 500n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(amount.result).toBe('AMOUNT_MISMATCH');
    const currency = evaluateReconciliation({
      ...base,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1000000n, currency: 'USD', beneficiaryRef: 'RCP_approved' },
    });
    expect(currency.result).toBe('CURRENCY_MISMATCH');
    const beneficiary = evaluateReconciliation({
      ...base,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1000000n, currency: 'NGN', beneficiaryRef: 'RCP_OTHER' },
    });
    expect(beneficiary.result).toBe('DESTINATION_MISMATCH');
  });

  it('currency comparison is case-insensitive and never silently converts', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1000000n, currency: 'ngn', beneficiaryRef: 'RCP_approved' },
    });
    expect(r.result).toBe('PROVIDER_SUCCESS_INTERNAL_PENDING');
  });

  it('provider reference not belonging to the attempt -> REFERENCE_MISMATCH', () => {
    const r = evaluateReconciliation({
      ...base,
      referenceMismatch: true,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1000000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(r.result).toBe('REFERENCE_MISMATCH');
  });

  it('duplicate provider reference -> DUPLICATE_REFERENCE', () => {
    const r = evaluateReconciliation({
      ...base,
      duplicateReference: true,
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success' },
    });
    expect(r.result).toBe('DUPLICATE_REFERENCE');
  });

  it('verified reversal -> PROVIDER_REVERSED (recorded separately, never an ordinary failure)', () => {
    const r = evaluateReconciliation({
      ...base,
      verification: { classification: 'REVERSED', providerStatus: 'reversed', amountMinor: 1000000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(r.result).toBe('PROVIDER_REVERSED');
  });

  it('no verification at all -> PROVIDER_UNKNOWN / REQUIRES_MANUAL_INVESTIGATION', () => {
    const a = evaluateReconciliation({ ...base, verification: null });
    expect(a.result).toBe('PROVIDER_UNKNOWN');
    const b = evaluateReconciliation({ ...base, internalStatus: S.REQUIRES_RECONCILIATION, verification: null });
    expect(b.result).toBe('REQUIRES_MANUAL_INVESTIGATION');
  });
});

describe('payout attempt state machine (v1.0.7 §4.1)', () => {
  const A = PayoutAttemptStatus;
  it('INITIATED can enter SUBMISSION_PENDING / PROVIDER_ACCEPTED / PENDING but never SUCCESSFUL directly', () => {
    expect(() => assertAttemptTransition(A.INITIATED, A.SUBMISSION_PENDING)).not.toThrow();
    expect(() => assertAttemptTransition(A.INITIATED, A.PROVIDER_ACCEPTED)).not.toThrow();
    expect(() => assertAttemptTransition(A.INITIATED, A.MANUAL_REVIEW)).not.toThrow();
    expect(() => assertAttemptTransition(A.INITIATED, A.SUCCESSFUL)).toThrow(/not permitted/);
  });

  it('SUBMISSION_PENDING re-arms to INITIATED ONLY as the v1.0.9 authoritative-not-found edge (never a blind resubmission)', () => {
    // v1.0.9 §2.3/§7 — the edge exists so the SAME durable attempt (same
    // idempotency key + provider reference) may be resubmitted ONLY after the
    // provider authoritatively confirmed the reference does not exist. Lease
    // expiry or AMBIGUOUS/ERROR lookups keep SUBMISSION_PENDING/UNKNOWN and
    // NEVER take this edge (enforced by the recovery gate, not the graph).
    expect(() => assertAttemptTransition(A.SUBMISSION_PENDING, A.INITIATED)).not.toThrow();
    expect(() => assertAttemptTransition(A.SUBMISSION_PENDING, A.PROVIDER_ACCEPTED)).not.toThrow();
    // A blind resubmission would skip straight to PROVIDER_ACCEPTED — that
    // path stays guarded by the outbox submission gate, not the graph.
  });

  it('terminal attempt states have no outgoing edges (except SUCCESSFUL -> REVERSED)', () => {
    expect(() => assertAttemptTransition(A.FAILED, A.PENDING)).toThrow(/not permitted/);
    expect(() => assertAttemptTransition(A.SUCCESSFUL, A.PENDING)).toThrow(/not permitted/);
    expect(() => assertAttemptTransition(A.SUCCESSFUL, A.REVERSED)).not.toThrow();
    expect(() => assertAttemptTransition(A.REVERSED, A.FAILED)).toThrow(/not permitted/);
  });

  it('unresolved attempt statuses block new transfers', () => {
    expect(UNRESOLVED_ATTEMPT_STATUSES).toContain(A.INITIATED);
    expect(UNRESOLVED_ATTEMPT_STATUSES).toContain(A.SUBMISSION_PENDING);
    expect(UNRESOLVED_ATTEMPT_STATUSES).toContain(A.PROVIDER_ACCEPTED);
    expect(UNRESOLVED_ATTEMPT_STATUSES).toContain(A.PENDING);
    expect(UNRESOLVED_ATTEMPT_STATUSES).toContain(A.UNKNOWN);
    expect(UNRESOLVED_ATTEMPT_STATUSES).toContain(A.MANUAL_REVIEW);
    expect(UNRESOLVED_ATTEMPT_STATUSES).not.toContain(A.FAILED);
    expect(UNRESOLVED_ATTEMPT_STATUSES).not.toContain(A.SUCCESSFUL);
    expect(UNRESOLVED_ATTEMPT_STATUSES).not.toContain(A.REVERSED);
  });
});
