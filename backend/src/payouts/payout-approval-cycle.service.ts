import { Injectable } from '@nestjs/common';
import { Prisma, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { sha256Hex } from '../common/utils/crypto.util';
import { safeEqualHex } from './payout-provider.adapter';

/**
 * KINDORA v1.0.8 §4 — THE centralized approval-cycle validator.
 *
 * `validatePayoutApprovalCycle()` returns a STRUCTURED result (never a bare
 * boolean) describing exactly which conditions passed and — on any failure —
 * the precise invalidation reason. Every payout authorization path calls it:
 *  - BEFORE creating a provider payout attempt (initiation);
 *  - inside the submission-time state re-validation (outbox processor);
 *  - BEFORE successful reconciliation/settlement (mandatory gate, §4.5);
 *  - inside the manual-settlement transaction (§3.6).
 *
 * v1.0.8 §4.5 semantics: a valid approval at initiation does NOT remain valid
 * forever. Callers must re-run this validation against the AUTHORITATIVE rows
 * (inside the transaction that locks withdrawal + attempt) immediately before
 * any successful settlement. A previously recorded "was valid" metadata flag
 * is never trusted.
 */

export interface ApprovalCycleSnapshotParts {
  withdrawalId: string;
  amountMinor: bigint;
  currency: string;
  destinationVersion: number;
  provider: string;
  beneficiaryId: string;
  requesterId: string;
  firstApproverId: string;
  secondApproverId: string;
  cycle: number;
}

/**
 * v1.0.9 §5.1 — the immutable MANUAL SETTLEMENT approval snapshot.
 *
 * A deterministic canonical representation of the approved withdrawal data
 * that a manual settlement completes. Bound (SHA-256) onto BOTH approval
 * records when the manual payout intent is authorized, and RECOMPUTED at
 * settlement time — any change of amount, currency, beneficiary identity,
 * destination version, approver set, approval cycle or settlement channel
 * invalidates the snapshot and blocks the settlement.
 */
export interface ManualSettlementSnapshotParts {
  withdrawalId: string;
  requesterId: string;
  /** Approved amount in minor units (integer string, never float). */
  amountMinor: string;
  currency: string;
  /** Beneficiary identity binding: the withdrawal's destination hash. */
  destinationRef: string;
  destinationVersion: number;
  /** The allowlisted manual settlement channel (e.g. MANUAL_BANK_TRANSFER). */
  settlementChannel: string;
  /** Fixed designation marker — distinguishes manual snapshots from provider ones. */
  designation: 'MANUAL_SETTLEMENT';
  /** Approval cycle identity: `<withdrawalId>#cycle<n>`. */
  approvalCycleId: string;
  approvalCycle: number;
  firstApproverId: string;
  secondApproverId: string;
  /** Immutable approval references (row ids). */
  firstApprovalId: string;
  secondApprovalId: string;
  /** Relevant approval timestamps (ISO-8601, immutable once approved). */
  firstApprovedAt: string;
  secondApprovedAt: string;
}

export interface ApprovalCycleValidation {
  valid: boolean;
  withdrawalId: string;
  /** Human-readable cycle identity: `<withdrawalId>#cycle<n>`. */
  approvalCycleId: string;
  approvedAmountMinor: bigint | null;
  approvedCurrency: string | null;
  approvedDestinationVersion: number | null;
  /** The provider the cycle was validated against (null when not requested). */
  provider: string | null;
  /** The beneficiary identity the cycle was validated against (external ref). */
  beneficiaryRef: string | null;
  requesterId: string | null;
  firstApproverId: string | null;
  secondApproverId: string | null;
  executorId: string | null;
  approvalSnapshotHash: string | null;
  /** Exactly why the cycle is invalid — null when valid. */
  invalidReason: string | null;
}

function invalid(base: Omit<ApprovalCycleValidation, 'valid' | 'invalidReason'>, reason: string): ApprovalCycleValidation {
  return { ...base, valid: false, invalidReason: reason };
}

@Injectable()
export class PayoutApprovalCycleService {
  constructor(private readonly prisma: PrismaService) {}

  /** Canonical approval snapshot hash (v1.0.7 §8.3 semantics, unchanged). */
  snapshotHash(parts: ApprovalCycleSnapshotParts): string {
    return sha256Hex(
      [
        `withdrawal=${parts.withdrawalId}`,
        `amount=${parts.amountMinor.toString()}`,
        `currency=${parts.currency.toUpperCase()}`,
        `destV=${parts.destinationVersion}`,
        `provider=${parts.provider.toUpperCase()}`,
        `beneficiary=${parts.beneficiaryId}`,
        `requester=${parts.requesterId}`,
        `first=${parts.firstApproverId}`,
        `second=${parts.secondApproverId}`,
        `cycle=${parts.cycle}`,
      ].join('|'),
    );
  }

  /**
   * v1.0.9 §5.1 — canonical MANUAL settlement snapshot hash. Deterministic,
   * order-fixed, integer-amount, constant fields only. A missing/changed
   * field changes the hash, so tampering or drift is detectable.
   */
  manualSettlementSnapshotHash(parts: ManualSettlementSnapshotParts): string {
    return sha256Hex(
      [
        `withdrawal=${parts.withdrawalId}`,
        `requester=${parts.requesterId}`,
        `amount=${parts.amountMinor}`,
        `currency=${parts.currency.toUpperCase()}`,
        `beneficiary=${parts.destinationRef}`,
        `destV=${parts.destinationVersion}`,
        `channel=${parts.settlementChannel.toUpperCase()}`,
        `designation=${parts.designation}`,
        `cycleId=${parts.approvalCycleId}`,
        `cycle=${parts.approvalCycle}`,
        `first=${parts.firstApproverId}`,
        `second=${parts.secondApproverId}`,
        `firstApproval=${parts.firstApprovalId}`,
        `secondApproval=${parts.secondApprovalId}`,
        `firstApprovedAt=${parts.firstApprovedAt}`,
        `secondApprovedAt=${parts.secondApprovedAt}`,
      ].join('|'),
    );
  }

  /**
   * v1.0.9 §5.1 — build the expected manual snapshot from the AUTHORITATIVE
   * rows (must be called with the locked withdrawal + its CURRENT-cycle
   * ACTIVE approvals). Throws when the inputs are incomplete.
   */
  buildManualSnapshot(
    withdrawal: { id: string; requestedById: string; amount: bigint; currency: string; destination: unknown; destinationVersion: number; approvalCycle: number },
    approvals: { id: string; role: string; approverId: string; approvedAt: Date }[],
    settlementChannel: string,
    destinationRef: string,
  ): { expected: string; parts: ManualSettlementSnapshotParts } {
    const first = approvals.find((a) => a.role === 'FIRST_APPROVER');
    const second = approvals.find((a) => a.role === 'SECOND_APPROVER');
    if (!first || !second) throw new Error('manual snapshot requires both approvals');
    const parts: ManualSettlementSnapshotParts = {
      withdrawalId: withdrawal.id,
      requesterId: withdrawal.requestedById,
      amountMinor: withdrawal.amount.toString(),
      currency: withdrawal.currency,
      destinationRef,
      destinationVersion: withdrawal.destinationVersion,
      settlementChannel,
      designation: 'MANUAL_SETTLEMENT',
      approvalCycleId: `${withdrawal.id}#cycle${withdrawal.approvalCycle}`,
      approvalCycle: withdrawal.approvalCycle,
      firstApproverId: first.approverId,
      secondApproverId: second.approverId,
      firstApprovalId: first.id,
      secondApprovalId: second.id,
      firstApprovedAt: first.approvedAt.toISOString(),
      secondApprovedAt: second.approvedAt.toISOString(),
    };
    return { expected: this.manualSettlementSnapshotHash(parts), parts };
  }

  /**
   * Validate the CURRENT approval cycle of a withdrawal against the
   * authoritative database rows (v1.0.8 §4.3 conditions 1-19).
   *
   * Pass a transaction client when the caller already holds row locks so the
   * validation reads the same locked snapshot that will be mutated.
   */
  async validate(
    client: Prisma.TransactionClient | PrismaService,
    withdrawalId: string,
    opts: {
      executorId?: string | null;
      /** Provider the payout will use — checked against the bound snapshot. */
      provider?: string | null;
      /** Internal PayoutBeneficiary id bound to the attempt (hash recompute). */
      beneficiaryId?: string | null;
      /** Provider beneficiary identity that must equal the approved one. */
      beneficiaryExternalRef?: string | null;
      /** Valid withdrawal states for the requested operation. */
      allowedStatuses?: WithdrawalStatus[];
      /** Require snapshot hashes bound at initiation (provider payout paths). */
      requireBoundSnapshot?: boolean;
      /**
       * v1.0.9 §4.1/§4.2 — when true, an executor identity MUST be supplied
       * (the PERSISTED initiatedById of the attempt); a missing executor
       * invalidates the cycle instead of silently skipping separation checks.
       */
      requireExecutor?: boolean;
      /**
       * v1.0.9 §5 — the allowlisted MANUAL settlement channel being settled.
       * Switches snapshot verification to the manual snapshot (channel-bound,
       * designation-bound) and REQUIRES the immutable bound snapshot.
       */
      settlementChannel?: string | null;
      /** Beneficiary identity binding for the manual snapshot (destination hash). */
      manualDestinationRef?: string | null;
    } = {},
  ): Promise<ApprovalCycleValidation> {
    const withdrawal = await client.withdrawal.findUnique({ where: { id: withdrawalId } });
    const base: Omit<ApprovalCycleValidation, 'valid' | 'invalidReason'> = {
      withdrawalId,
      approvalCycleId: `${withdrawalId}#cycle${withdrawal?.approvalCycle ?? '?'}`,
      approvedAmountMinor: null,
      approvedCurrency: null,
      approvedDestinationVersion: null,
      provider: opts.provider ?? null,
      beneficiaryRef: opts.beneficiaryExternalRef ?? null,
      requesterId: withdrawal?.requestedById ?? null,
      firstApproverId: null,
      secondApproverId: null,
      executorId: opts.executorId ?? null,
      approvalSnapshotHash: null,
    };
    if (!withdrawal) return invalid(base, 'Withdrawal not found');

    // §4.3 condition 19 — the withdrawal must be in a valid state for the
    // requested operation.
    if (opts.allowedStatuses && !opts.allowedStatuses.includes(withdrawal.status)) {
      return invalid(base, `Withdrawal status ${withdrawal.status} is not valid for this operation`);
    }

    // §4.3 conditions 2-5 — both approvals exist, belong to the CURRENT
    // cycle, and remain ACTIVE (an invalidated approval is never reused).
    const approvals = await client.withdrawalApproval.findMany({
      where: { withdrawalId, cycle: withdrawal.approvalCycle, status: 'ACTIVE' },
    });
    const first = approvals.find((a) => a.role === 'FIRST_APPROVER') ?? null;
    const second = approvals.find((a) => a.role === 'SECOND_APPROVER') ?? null;
    if (!first) return invalid(base, 'The current approval cycle has no ACTIVE first approval');
    if (!second) return invalid(base, 'The current approval cycle has no ACTIVE second approval');

    const enriched: Omit<ApprovalCycleValidation, 'valid' | 'invalidReason'> = {
      ...base,
      firstApproverId: first.approverId,
      secondApproverId: second.approverId,
      approvedAmountMinor: first.amountAtApproval,
      approvedCurrency: first.currencyAtApproval,
      approvedDestinationVersion: first.destinationVersionAtApproval,
      approvalSnapshotHash: first.snapshotHash,
    };

    // §4.3 condition 6 — distinct approvers.
    if (first.approverId === second.approverId) {
      return invalid(enriched, 'The first and second approver must be distinct identities');
    }
    // §4.3 conditions 7-8 — requester is neither approver.
    if (withdrawal.requestedById === first.approverId) {
      return invalid(enriched, 'The requester cannot be the first approver');
    }
    if (withdrawal.requestedById === second.approverId) {
      return invalid(enriched, 'The requester cannot be the second approver');
    }
    // v1.0.9 §4.1/§4.2 — a PERSISTED executor identity is mandatory for
    // provider submission and final reconciliation; a missing executor is an
    // invalid cycle (never a silent skip of the separation checks).
    if (opts.requireExecutor && !opts.executorId) {
      return invalid(enriched, 'The persisted payout executor identity is missing — the approval cycle cannot be validated');
    }
    // §4.3 conditions 9-11 — executor separation (enforced whenever an
    // executor identity is supplied; the executor must be a fourth person).
    if (opts.executorId) {
      if (withdrawal.requestedById === opts.executorId) {
        return invalid(enriched, 'The executor cannot be the withdrawal requester');
      }
      if (first.approverId === opts.executorId) {
        return invalid(enriched, 'The executor cannot be the first approver');
      }
      if (second.approverId === opts.executorId) {
        return invalid(enriched, 'The executor cannot be the second approver');
      }
    }
    // §4.3 conditions 12-13 — approved amount and currency match the CURRENT
    // withdrawal exactly (any material change invalidates the cycle, §4.6).
    if (
      first.amountAtApproval !== withdrawal.amount ||
      second.amountAtApproval !== withdrawal.amount ||
      first.currencyAtApproval.toUpperCase() !== withdrawal.currency.toUpperCase() ||
      second.currencyAtApproval.toUpperCase() !== withdrawal.currency.toUpperCase()
    ) {
      return invalid(enriched, 'Approved amount/currency no longer matches the withdrawal — the approval cycle is stale');
    }
    // §4.3 condition 14 — destination version binding.
    if (
      first.destinationVersionAtApproval == null ||
      second.destinationVersionAtApproval == null ||
      first.destinationVersionAtApproval !== withdrawal.destinationVersion ||
      second.destinationVersionAtApproval !== withdrawal.destinationVersion
    ) {
      return invalid(enriched, 'Approvals are not bound to the current destination version');
    }
    // §4.3 conditions 15-18 — snapshot hash integrity. When either approval
    // carries a snapshot hash, BOTH must be present, identical, and (with
    // provider + beneficiary supplied) must recompute exactly.
    // v1.0.9 §5 — a MANUAL settlement channel REQUIRES the immutable bound
    // snapshot (no grandfathering): missing hashes never pass, both approvals
    // must bind the SAME hash, and the hash must recompute against the
    // CURRENT authoritative rows with the channel + MANUAL designation bound.
    const hashA = first.snapshotHash;
    const hashB = second.snapshotHash;
    const isManualSnapshotCheck = Boolean(opts.settlementChannel);
    if (hashA || hashB || opts.requireBoundSnapshot || isManualSnapshotCheck) {
      if (!hashA || !hashB) {
        return invalid(enriched, 'Approval snapshot hashes are not bound on both approvals');
      }
      // v1.0.9 §5.1 — constant-time comparison for security-sensitive hashes.
      if (!safeEqualHex(hashA, hashB)) {
        return invalid(enriched, 'Approval snapshot hashes differ between the two approvals');
      }
      if (isManualSnapshotCheck) {
        if (!opts.manualDestinationRef) {
          return invalid(enriched, 'The manual settlement snapshot cannot be recomputed without the destination binding');
        }
        let expectedManual: string;
        try {
          expectedManual = this.buildManualSnapshot(
            withdrawal,
            [first, second],
            opts.settlementChannel as string,
            opts.manualDestinationRef,
          ).expected;
        } catch {
          return invalid(enriched, 'The manual settlement snapshot could not be recomputed from the approval records');
        }
        if (!safeEqualHex(hashA, expectedManual)) {
          return invalid(enriched, 'Approval snapshot hash does not match the current manual settlement details — approvals invalidated');
        }
      } else if (opts.provider && opts.beneficiaryId) {
        const expected = this.snapshotHash({
          withdrawalId: withdrawal.id,
          amountMinor: withdrawal.amount,
          currency: withdrawal.currency,
          destinationVersion: withdrawal.destinationVersion,
          provider: opts.provider,
          beneficiaryId: opts.beneficiaryId,
          requesterId: withdrawal.requestedById,
          firstApproverId: first.approverId,
          secondApproverId: second.approverId,
          cycle: withdrawal.approvalCycle,
        });
        if (!safeEqualHex(hashA, expected)) {
          return invalid(enriched, 'Approval snapshot hash does not match the current payout details — approvals invalidated');
        }
      }
    }
    // §4.3 condition 16 — beneficiary identity binding (provider evidence vs
    // the approved beneficiary), when the caller supplies provider evidence.
    if (opts.beneficiaryExternalRef) {
      const bound = await client.payoutBeneficiary.findUnique({
        where: { withdrawalId_provider_destinationVersion: {
          withdrawalId: withdrawal.id,
          provider: opts.provider ?? '',
          destinationVersion: withdrawal.destinationVersion,
        } },
      });
      if (!bound || bound.status !== 'ACTIVE' || bound.externalRef !== opts.beneficiaryExternalRef) {
        return invalid(enriched, 'Provider beneficiary identity does not match the approved destination version');
      }
    }

    return { ...enriched, valid: true, invalidReason: null };
  }
}
