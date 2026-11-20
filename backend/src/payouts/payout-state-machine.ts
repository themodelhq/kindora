import { ConflictException, BadRequestException } from '@nestjs/common';
import { PayoutAttemptStatus, PayoutReversalState, WithdrawalStatus } from '@prisma/client';

/**
 * Canonical payout state machine (v1.0.4 §4, extended by v1.0.7 §4.1/§7.2).
 *
 * ALL withdrawal/payout status transitions MUST be expressed through
 * `assertTransition` (withdrawal) and `assertAttemptTransition` (attempt)
 * inside the canonical payout services. There is no other code path that may
 * change a withdrawal's status:
 *
 *  - no controller-facing "mark-*" endpoint mutates state directly;
 *  - workers never write withdrawal status directly (verification +
 *    reconciliation results are applied through the atomic reconciliation
 *    service);
 *  - administrators can never force-fail an ambiguous transfer — a timeout,
 *    an HTTP error or an unknown provider response NEVER maps to FAILED.
 *
 * Withdrawal graph (permitted edges; every other edge is rejected):
 *
 *   REQUESTED(PENDING) ─→ UNDER_REVIEW ─→ APPROVED ─→ PROCESSING ─→ PAID
 *        │  │  │                │             │             │        │
 *        │  │  └→ REJECTED      └→ REJECTED   └→ REJECTED   │        └→ REVERSED
 *        │  └→ REQUIRES_INFORMATION ─→ APPROVED / UNDER_REVIEW / REJECTED
 *        └→ CANCELLED
 *
 *   PROCESSING ─→ REQUIRES_RECONCILIATION   (ambiguous: timeout / unknown)
 *   REQUIRES_RECONCILIATION ─→ PAID         (verified successful transfer)
 *   REQUIRES_RECONCILIATION ─→ FAILED       (verified terminal failure)
 *   FAILED ─→ PROCESSING                    (authorized retry, new attempt)
 *
 * Critical invariants:
 *  - PROCESSING → FAILED requires an AUTHORITATIVE provider failure result
 *    applied through the atomic reconciliation service.
 *  - PAID is terminal except for a verified provider REVERSED result.
 *  - A withdrawal with an unresolved attempt can never start a new transfer.
 */

export const PAYOUT_TRANSITIONS: Record<WithdrawalStatus, WithdrawalStatus[]> = {
  [WithdrawalStatus.PENDING]: [
    WithdrawalStatus.UNDER_REVIEW,
    WithdrawalStatus.APPROVED,
    WithdrawalStatus.REQUIRES_INFORMATION,
    WithdrawalStatus.REJECTED,
    WithdrawalStatus.CANCELLED,
  ],
  [WithdrawalStatus.UNDER_REVIEW]: [
    WithdrawalStatus.APPROVED,
    WithdrawalStatus.REQUIRES_INFORMATION,
    WithdrawalStatus.REJECTED,
  ],
  [WithdrawalStatus.REQUIRES_INFORMATION]: [
    WithdrawalStatus.UNDER_REVIEW,
    WithdrawalStatus.APPROVED,
    WithdrawalStatus.REJECTED,
    WithdrawalStatus.CANCELLED,
  ],
  [WithdrawalStatus.APPROVED]: [
    WithdrawalStatus.PROCESSING,
    WithdrawalStatus.PAID, // manual settlement with provider evidence (PayoutService)
    WithdrawalStatus.REJECTED,
  ],
  [WithdrawalStatus.PROCESSING]: [
    WithdrawalStatus.PAID,
    WithdrawalStatus.FAILED, // ONLY via authoritative provider failure (reconciliation)
    WithdrawalStatus.REQUIRES_RECONCILIATION,
    WithdrawalStatus.REVERSED,
  ],
  [WithdrawalStatus.REQUIRES_RECONCILIATION]: [
    WithdrawalStatus.PAID,
    WithdrawalStatus.FAILED, // ONLY via authoritative provider failure (reconciliation)
    WithdrawalStatus.REJECTED,
  ],
  [WithdrawalStatus.FAILED]: [
    WithdrawalStatus.PROCESSING, // authorized retry (new attempt, separation rules re-checked)
  ],
  [WithdrawalStatus.PAID]: [
    WithdrawalStatus.REVERSED, // verified provider reversal
  ],
  [WithdrawalStatus.REJECTED]: [],
  [WithdrawalStatus.CANCELLED]: [],
  [WithdrawalStatus.REVERSED]: [],
};

export function isTerminalWithdrawalStatus(status: WithdrawalStatus): boolean {
  return PAYOUT_TRANSITIONS[status].length === 0;
}

export function assertTransition(from: WithdrawalStatus, to: WithdrawalStatus): void {
  if (from === to) {
    throw new BadRequestException(`Payout is already in state ${to}`);
  }
  const allowed = PAYOUT_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new ConflictException(
      `Payout state transition ${from} -> ${to} is not permitted by the canonical payout state machine`,
    );
  }
}

// ---- v1.0.7 §4.1 — payout attempt initiation state machine --------------------

/**
 * Durable attempt states (aligned with the existing schema — no duplicates):
 *
 *   INITIATED            registered locally, intent committed, not yet submitted
 *   SUBMISSION_PENDING   provider call was ambiguous (timeout/5xx/lost) — the
 *                        transfer MAY exist; another submission is forbidden
 *   PROVIDER_ACCEPTED    provider accepted/registered the transfer; identity
 *                        persisted; awaiting authoritative verification
 *   PENDING              provider reports the transfer in progress
 *   SUCCESSFUL           authoritative verified settlement (exactly once)
 *   FAILED               authoritative terminal failure
 *   UNKNOWN              verification could not classify the transfer
 *   MANUAL_REVIEW        escalated to a controlled manual review case
 *   REVERSED             verified provider reversal
 */
export const ATTEMPT_TRANSITIONS: Record<PayoutAttemptStatus, PayoutAttemptStatus[]> = {
  [PayoutAttemptStatus.INITIATED]: [
    PayoutAttemptStatus.SUBMISSION_PENDING,
    PayoutAttemptStatus.PROVIDER_ACCEPTED,
    PayoutAttemptStatus.PENDING,
    PayoutAttemptStatus.FAILED,
    PayoutAttemptStatus.UNKNOWN,
    PayoutAttemptStatus.MANUAL_REVIEW,
  ],
  [PayoutAttemptStatus.SUBMISSION_PENDING]: [
    // Resolved only through provider lookup — never by re-submitting blindly.
    PayoutAttemptStatus.PROVIDER_ACCEPTED,
    PayoutAttemptStatus.PENDING,
    PayoutAttemptStatus.SUCCESSFUL,
    PayoutAttemptStatus.FAILED,
    PayoutAttemptStatus.UNKNOWN,
    PayoutAttemptStatus.MANUAL_REVIEW,
    // v1.0.9 §2.3/§7 — RE-ARM ONLY after the provider AUTHORITATIVELY
    // confirmed the reference does not exist (strict NOT_FOUND): the original
    // submission provably never landed, so the SAME durable attempt may be
    // submitted again with the SAME stable idempotency key + provider
    // reference. A lease expiry or an AMBIGUOUS/ERROR lookup can NEVER take
    // this edge — those keep SUBMISSION_PENDING/UNKNOWN (§7).
    PayoutAttemptStatus.INITIATED,
  ],
  [PayoutAttemptStatus.PROVIDER_ACCEPTED]: [
    PayoutAttemptStatus.PENDING,
    PayoutAttemptStatus.SUCCESSFUL,
    PayoutAttemptStatus.FAILED,
    PayoutAttemptStatus.UNKNOWN,
    PayoutAttemptStatus.REVERSED,
    PayoutAttemptStatus.MANUAL_REVIEW,
  ],
  [PayoutAttemptStatus.PENDING]: [
    PayoutAttemptStatus.SUCCESSFUL,
    PayoutAttemptStatus.FAILED,
    PayoutAttemptStatus.UNKNOWN,
    PayoutAttemptStatus.REVERSED,
    PayoutAttemptStatus.MANUAL_REVIEW,
  ],
  [PayoutAttemptStatus.UNKNOWN]: [
    PayoutAttemptStatus.SUCCESSFUL,
    PayoutAttemptStatus.FAILED,
    PayoutAttemptStatus.PENDING,
    PayoutAttemptStatus.REVERSED,
    PayoutAttemptStatus.MANUAL_REVIEW,
  ],
  [PayoutAttemptStatus.MANUAL_REVIEW]: [
    PayoutAttemptStatus.SUCCESSFUL,
    PayoutAttemptStatus.FAILED,
    PayoutAttemptStatus.UNKNOWN,
    PayoutAttemptStatus.REVERSED,
  ],
  [PayoutAttemptStatus.SUCCESSFUL]: [PayoutAttemptStatus.REVERSED],
  [PayoutAttemptStatus.FAILED]: [],
  [PayoutAttemptStatus.REVERSED]: [],
};

export function assertAttemptTransition(from: PayoutAttemptStatus, to: PayoutAttemptStatus): void {
  if (from === to) return; // idempotent re-application of the same state is safe
  const allowed = ATTEMPT_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new ConflictException(
      `Payout attempt state transition ${from} -> ${to} is not permitted by the canonical attempt state machine`,
    );
  }
}

// ---- provider transfer response classification (v1.0.4 §5.1, v1.0.8 §8.2) ----

export type ProviderTransferClass =
  | 'SUCCESSFUL'
  | 'FAILED'
  | 'PENDING'
  | 'UNKNOWN'
  | 'REVERSED'
  // v1.0.8 §8.2 — a reversal that has been requested/initiated/processing is
  // NOT a terminal REVERSED outcome. Funds may still return (or not); the
  // reservation stays intact and a controlled recovery decision is required.
  | 'REVERSAL_IN_PROGRESS';

export interface TransferVerification {
  classification: ProviderTransferClass;
  /** Provider-reported raw status — preserved as evidence, never normalized away. */
  providerStatus: string;
  providerReference?: string;
  providerTransferId?: string;
  amountMinor?: bigint;
  currency?: string;
  /**
   * v1.0.7 §5.2 — the provider's BENEFICIARY identity (Paystack recipient_code
   * / FLW normalized fingerprint). NEVER the local destination JSON hash.
   */
  beneficiaryRef?: string;
  /** Authoritative terminal failure reason (only when classification === FAILED). */
  failureReason?: string;
  /** Sanitized provider response subset persisted as immutable evidence. */
  evidence?: Record<string, unknown>;
}

const PAYSTACK_TRANSFER_SUCCESS = new Set(['success', 'successful']);
const PAYSTACK_TRANSFER_PENDING = new Set(['pending', 'otp', 'processing', 'queued']);
const PAYSTACK_TRANSFER_FAILED = new Set(['failed', 'incorrect_pin', 'cancelled', 'banned']);
// Paystack documents `reversed` as the terminal reversal outcome of a
// successful transfer. Paystack exposes no documented in-progress reversal
// statuses, so an in-progress reversal is not recognizable for this provider
// and any unrecognized reversal-like status falls through to UNKNOWN (fail
// closed) — never prematurely terminal.
const PAYSTACK_TRANSFER_REVERSED = new Set(['reversed', 'reverse']);

const FLW_TRANSFER_SUCCESS = new Set(['successful', 'success']);
const FLW_TRANSFER_PENDING = new Set(['pending', 'queued', 'new', 'processing', 'in_progress']);
const FLW_TRANSFER_FAILED = new Set(['failed', 'error', 'cancelled']);
// v1.0.8 §8.2 — Flutterwave reversal lifecycle (official status semantics):
//   `reversed`          reversal COMPLETED (terminal)
//   `reverse_initiated` reversal INITIATED  (in progress — NOT terminal)
//   `reversing`         reversal PROCESSING (in progress — NOT terminal)
const FLW_TRANSFER_REVERSED = new Set(['reversed']);
const FLW_TRANSFER_REVERSAL_IN_PROGRESS = new Set(['reverse_initiated', 'reversing']);

/**
 * Map a raw provider transfer status to the closed classification set.
 * CRITICAL: everything unrecognised maps to UNKNOWN — never to FAILED.
 * Only an authoritative terminal failure permits the FAILED transition.
 * v1.0.8 §8.2: in-progress reversal statuses are classified as
 * REVERSAL_IN_PROGRESS, never as the terminal REVERSED outcome.
 */
export function classifyTransferStatus(provider: string, rawStatus: string | null | undefined): ProviderTransferClass {
  const s = (rawStatus ?? '').toLowerCase().trim();
  if (!s) return 'UNKNOWN';
  switch (provider.toUpperCase()) {
    case 'PAYSTACK':
      if (PAYSTACK_TRANSFER_SUCCESS.has(s)) return 'SUCCESSFUL';
      if (PAYSTACK_TRANSFER_FAILED.has(s)) return 'FAILED';
      if (PAYSTACK_TRANSFER_PENDING.has(s)) return 'PENDING';
      if (PAYSTACK_TRANSFER_REVERSED.has(s)) return 'REVERSED';
      return 'UNKNOWN';
    case 'FLUTTERWAVE':
      if (FLW_TRANSFER_SUCCESS.has(s)) return 'SUCCESSFUL';
      if (FLW_TRANSFER_FAILED.has(s)) return 'FAILED';
      if (FLW_TRANSFER_PENDING.has(s)) return 'PENDING';
      if (FLW_TRANSFER_REVERSAL_IN_PROGRESS.has(s)) return 'REVERSAL_IN_PROGRESS';
      if (FLW_TRANSFER_REVERSED.has(s)) return 'REVERSED';
      return 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}

/**
 * v1.0.8 §8.2 — provider-specific reversal lifecycle normalization. Returns
 * the internal reversal state a raw provider status maps to, or null when the
 * raw status carries no reversal semantics. Unknown reversal-like strings are
 * NOT guessed: they return null and the caller keeps the lifecycle state
 * unchanged (the classification is already UNKNOWN — fail closed).
 */
export function reversalStateFor(provider: string, rawStatus: string | null | undefined): 'REQUESTED' | 'INITIATED' | 'PROCESSING' | 'PENDING' | 'COMPLETED' | 'REJECTED' | 'UNKNOWN' | null {
  const s = (rawStatus ?? '').toLowerCase().trim();
  if (!s) return null;
  switch (provider.toUpperCase()) {
    case 'PAYSTACK':
      if (PAYSTACK_TRANSFER_REVERSED.has(s)) return 'COMPLETED';
      return null;
    case 'FLUTTERWAVE':
      if (s === 'reversed') return 'COMPLETED';
      if (s === 'reverse_initiated') return 'INITIATED';
      if (s === 'reversing') return 'PROCESSING';
      return null;
    default:
      return null;
  }
}

/**
 * v1.0.8 §8.3 — forward-only reversal lifecycle. A reversal may progress
 * (REQUESTED -> INITIATED/PROCESSING/PENDING -> COMPLETED) or be recorded as
 * REJECTED/UNKNOWN; COMPLETED is terminal and can never "un-complete", which
 * makes duplicate reversal posting impossible at the state-machine level.
 */
const REVERSAL_ORDER: Record<string, number> = {
  REQUESTED: 1,
  INITIATED: 2,
  PENDING: 2,
  PROCESSING: 3,
  COMPLETED: 4,
  REJECTED: 4,
  UNKNOWN: 2,
};

export function assertReversalTransition(
  from: PayoutReversalState | null | undefined,
  to: Exclude<PayoutReversalState, 'NOT_APPLICABLE'>,
): void {
  if (from == null || from === 'NOT_APPLICABLE') return; // first observation
  if (from === to) return; // idempotent re-observation of the same stage
  if (from === 'COMPLETED' || from === 'REJECTED') {
    throw new ConflictException(`Reversal lifecycle is terminal (${from}) — ${to} cannot be applied afterwards`);
  }
  if (to === 'COMPLETED') return; // any in-progress stage may complete
  if (to === 'REJECTED') return; // any in-progress stage may be rejected
  if (from === 'UNKNOWN') return; // unknown -> any concrete stage is progress
  if ((REVERSAL_ORDER[to] ?? 0) < (REVERSAL_ORDER[from] ?? 0)) {
    throw new ConflictException(`Reversal lifecycle regression ${from} -> ${to} is not permitted`);
  }
}

// ---- structured reconciliation result model (v1.0.4 §11, v1.0.7 §7.2) -------

export type ReconciliationOutcome =
  | 'MATCHED'
  | 'PROVIDER_SUCCESS_INTERNAL_PENDING'
  | 'PROVIDER_FAILED_INTERNAL_PROCESSING'
  | 'PROVIDER_PENDING'
  | 'PROVIDER_UNKNOWN'
  | 'PROVIDER_REVERSED'
  | 'PROVIDER_REVERSAL_IN_PROGRESS'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DESTINATION_MISMATCH'
  | 'REFERENCE_MISMATCH'
  | 'DUPLICATE_REFERENCE'
  | 'INTERNAL_STATE_MISMATCH'
  | 'PROVIDER_DATA_INCOMPLETE'
  | 'REQUIRES_MANUAL_INVESTIGATION'
  | 'MANUAL_REVIEW_REQUIRED';

export interface ReconciliationInputs {
  internalStatus: WithdrawalStatus;
  attemptStatus: string | null; // PayoutAttempt.status
  verification: TransferVerification | null;
  expectedAmountMinor: bigint | null;
  expectedCurrency: string | null;
  /**
   * v1.0.7 §5.2 — the APPROVED beneficiary identity (PayoutBeneficiary
   * externalRef bound to the attempt). Compared against the provider's own
   * beneficiary evidence from the transfer object.
   */
  expectedBeneficiaryRef: string | null;
  duplicateReference: boolean;
  /** Reference returned by the provider does not match the submission reference. */
  referenceMismatch?: boolean;
}

export interface ReconciliationEvaluation {
  result: ReconciliationOutcome;
  amountMatched: boolean | null;
  currencyMatched: boolean | null;
  /** v1.0.7: beneficiary identity match (destinationRef field retained for history). */
  beneficiaryMatched: boolean | null;
  destinationMatched: boolean | null;
  /** v1.0.7 §5.3: true when mandatory financial evidence is missing (fail closed). */
  evidenceIncomplete: boolean;
}

/**
 * Derive the structured reconciliation result. v1.0.7 §5.3 FAIL-CLOSED
 * semantics: a missing provider amount, currency or beneficiary value is
 * NEVER interpreted as a match. Unknown is NEVER treated as FAILED.
 */
export function evaluateReconciliation(input: ReconciliationInputs): ReconciliationEvaluation {
  if (input.duplicateReference) {
    return { result: 'DUPLICATE_REFERENCE', amountMatched: null, currencyMatched: null, beneficiaryMatched: null, destinationMatched: null, evidenceIncomplete: true };
  }

  const v = input.verification;
  if (!v) {
    return {
      result: input.internalStatus === WithdrawalStatus.REQUIRES_RECONCILIATION ? 'REQUIRES_MANUAL_INVESTIGATION' : 'PROVIDER_UNKNOWN',
      amountMatched: null,
      currencyMatched: null,
      beneficiaryMatched: null,
      destinationMatched: null,
      evidenceIncomplete: true,
    };
  }

  // Integer minor-unit comparison — never floating point (§5.3).
  const amountMatched = v.amountMinor != null && input.expectedAmountMinor != null ? v.amountMinor === input.expectedAmountMinor : null;
  const currencyMatched = v.currency != null && input.expectedCurrency ? v.currency.toUpperCase() === input.expectedCurrency.toUpperCase() : null;
  const beneficiaryMatched =
    v.beneficiaryRef != null && input.expectedBeneficiaryRef != null ? v.beneficiaryRef === input.expectedBeneficiaryRef : null;
  // destinationMatched is retained for historical rows; for v1.0.7 evidence it
  // mirrors beneficiaryMatched.
  const destinationMatched = beneficiaryMatched;

  // Reference identity: the provider's returned reference must belong to this
  // attempt's submission. A mismatch is never settled.
  if (input.referenceMismatch) {
    return { result: 'REFERENCE_MISMATCH', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete: false };
  }

  const evidenceIncomplete = amountMatched === null || currencyMatched === null || beneficiaryMatched === null;

  // Missing mandatory evidence FAILS CLOSED — but only blocks outcomes that
  // would need that evidence (settlement). An authoritative terminal FAILURE
  // needs no beneficiary proof; a SUCCESS with missing evidence cannot settle.
  if (v.classification === 'SUCCESSFUL' && evidenceIncomplete) {
    return { result: 'PROVIDER_DATA_INCOMPLETE', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete: true };
  }

  if (amountMatched === false) {
    return { result: 'AMOUNT_MISMATCH', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete: false };
  }
  if (currencyMatched === false) {
    return { result: 'CURRENCY_MISMATCH', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete: false };
  }
  if (beneficiaryMatched === false) {
    return { result: 'DESTINATION_MISMATCH', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete: false };
  }

  switch (v.classification) {
    case 'SUCCESSFUL': {
      if (input.internalStatus === WithdrawalStatus.PROCESSING || input.internalStatus === WithdrawalStatus.REQUIRES_RECONCILIATION) {
        // Provider says settled, our ledger has not caught up — the single
        // legitimate path to finalize (PAID), applied atomically by the
        // reconciliation service. v1.0.8: the reconciliation service ALSO
        // gates this branch on a valid approval cycle (§4.5) before applying.
        return { result: 'PROVIDER_SUCCESS_INTERNAL_PENDING', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete };
      }
      return { result: 'MATCHED', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete };
    }
    case 'FAILED': {
      return {
        result: input.internalStatus === WithdrawalStatus.PROCESSING ? 'PROVIDER_FAILED_INTERNAL_PROCESSING' : 'MATCHED',
        amountMatched,
        currencyMatched,
        beneficiaryMatched,
        destinationMatched,
        evidenceIncomplete: false,
      };
    }
    case 'PENDING':
      return { result: 'PROVIDER_PENDING', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete };
    case 'REVERSAL_IN_PROGRESS':
      // v1.0.8 §8.2 — in-progress reversal: never terminal, never a failure,
      // never a settlement. The reconciliation service records the lifecycle
      // state and escalates for a controlled recovery decision (§8.3).
      return { result: 'PROVIDER_REVERSAL_IN_PROGRESS', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete };
    case 'REVERSED':
      return { result: 'PROVIDER_REVERSED', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete };
    case 'UNKNOWN':
    default: {
      if (input.internalStatus === WithdrawalStatus.REQUIRES_RECONCILIATION) {
        return { result: 'REQUIRES_MANUAL_INVESTIGATION', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete: true };
      }
      return { result: 'PROVIDER_UNKNOWN', amountMatched, currencyMatched, beneficiaryMatched, destinationMatched, evidenceIncomplete: true };
    }
  }
}

/** Outcome classes that permit settlement (verified success, evidence complete). */
export const SETTLABLE_OUTCOMES: ReconciliationOutcome[] = ['PROVIDER_SUCCESS_INTERNAL_PENDING', 'MATCHED'];

/**
 * Attempts that make a payout "unresolved" — no new transfer may start while
 * any exists (v1.0.7: submission-pending and manual-review are unresolved).
 */
export const UNRESOLVED_ATTEMPT_STATUSES: PayoutAttemptStatus[] = [
  PayoutAttemptStatus.INITIATED,
  PayoutAttemptStatus.SUBMISSION_PENDING,
  PayoutAttemptStatus.PROVIDER_ACCEPTED,
  PayoutAttemptStatus.PENDING,
  PayoutAttemptStatus.UNKNOWN,
  PayoutAttemptStatus.MANUAL_REVIEW,
];

/** Manual review category for a reconciliation outcome (§9). */
export function manualReviewCategoryFor(outcome: ReconciliationOutcome): string {
  switch (outcome) {
    case 'AMOUNT_MISMATCH':
      return 'AMOUNT_MISMATCH';
    case 'CURRENCY_MISMATCH':
      return 'CURRENCY_MISMATCH';
    case 'DESTINATION_MISMATCH':
      return 'BENEFICIARY_MISMATCH';
    case 'REFERENCE_MISMATCH':
      return 'REFERENCE_MISMATCH';
    case 'DUPLICATE_REFERENCE':
      return 'DUPLICATE_REFERENCE';
    case 'PROVIDER_REVERSED':
      return 'PROVIDER_REVERSAL';
    // v1.0.8 §8.3 — an in-progress reversal also requires a controlled
    // recovery decision; it must not sit unattended while funds are in flight.
    case 'PROVIDER_REVERSAL_IN_PROGRESS':
      return 'PROVIDER_REVERSAL';
    case 'INTERNAL_STATE_MISMATCH':
      return 'INTERNAL_STATE_MISMATCH';
    case 'PROVIDER_DATA_INCOMPLETE':
      return 'PROVIDER_DATA_INCOMPLETE';
    default:
      return 'PROVIDER_UNKNOWN';
  }
}
