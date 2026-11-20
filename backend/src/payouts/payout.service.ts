import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PayoutAttemptStatus, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { sha256Hex } from '../common/utils/crypto.util';
import { ManualReviewService } from './manual-review.service';
import { PayoutApprovalCycleService } from './payout-approval-cycle.service';
import { PayoutEvidenceService } from './payout-evidence.service';
import { PayoutInitiationService } from './payout-initiation.service';
import { PayoutProviderRegistry } from './payout-provider.registry';
import { PayoutReconciliationService } from './payout-reconciliation.service';
import { PayoutSecurityMetricsService } from './payout-metrics.service';
import { PayoutVerificationService } from './payout-verification.service';
import { MANUAL_SETTLEMENT_CHANNELS, assertManualSettlementChannel, isManualSettlementChannel, normalizeLegacyManualChannel } from './manual-settlement-channels';
import { UNRESOLVED_ATTEMPT_STATUSES, assertTransition } from './payout-state-machine';

export type Actor = { id: string; role: string };

export interface ManualSettlementInput {
  payoutProvider: string;
  providerTransferRef: string;
  payoutProviderTxnId?: string;
  evidenceFileId: string;
  note?: string;
}

export interface RetryInput {
  payoutProvider?: string;
  note?: string;
}

/**
 * Canonical payout service — the SINGLE owner of every withdrawal status
 * transition (v1.0.4 §4/§5, extended by v1.0.7). There is no other code path
 * that may change a withdrawal's status.
 *
 * v1.0.7 architecture:
 *  - initiation      -> PayoutInitiationService (durable intent + outbox + provider transfer)
 *  - verification    -> PayoutVerificationService (fail-closed provider checks)
 *  - reconciliation  -> PayoutReconciliationService (ATOMIC for every outcome)
 *  - beneficiary     -> PayoutBeneficiaryService (provider-specific identity)
 *  - manual review   -> ManualReviewService (controlled escalation)
 *  - provider access -> PayoutProviderRegistry (Paystack/Flutterwave real
 *                       initiation + verification; Stripe/PayPal rejected)
 *
 * Controls preserved from v1.0.4/v1.0.6:
 *  1. Canonical state machine — every transition passes assertTransition and
 *     is executed as a conditional updateMany (from-state guarded) inside a
 *     transaction, so concurrent writers cannot interleave.
 *  2. Attempt registry — every payout transfer is a durable PayoutAttempt row
 *     with a unique idempotency key `payout:<wd>:<attemptNo>`. Provider-level
 *     retries (HTTP retry, job retry, webhook replay) map to the SAME attempt
 *     row — no second transfer can ever be created for one logical attempt.
 *  3. Ambiguous transfer protection — timeouts, HTTP errors and unknown
 *     provider statuses classify as UNKNOWN: the reservation stays intact,
 *     the withdrawal moves to REQUIRES_RECONCILIATION, and reconciliation
 *     (never an administrator's hand) resolves the outcome.
 *  4. Safe retry — allowed only from FAILED with no unresolved attempt,
 *     producing a fresh attemptNo, then entering the v1.0.7 initiation
 *     pipeline (durable intent + real provider transfer).
 *  5. Authoritative settlement — a withdrawal becomes PAID ONLY through the
 *     atomic reconciliation of a verified provider SUCCESSFUL result with
 *     exact amount/currency/beneficiary evidence, or via the controlled
 *     manual-settlement path (registered evidence file + separation + MFA).
 *  6. Exactly-once ledger — settlement posts through LedgerService.postWithdrawal
 *     whose unique reference `withdrawal:<id>` turns any double-settlement
 *     race into a P2002 -> 409 Conflict.
 *  7. Immutable audit — every transition writes an AuditLog entry.
 */
@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly config: ConfigService,
    private readonly initiation: PayoutInitiationService,
    private readonly verification: PayoutVerificationService,
    private readonly manualReview: ManualReviewService,
    private readonly registry: PayoutProviderRegistry,
    private readonly reconciliation: PayoutReconciliationService,
    private readonly approvalCycles: PayoutApprovalCycleService,
    private readonly evidence: PayoutEvidenceService,
    private readonly metrics: PayoutSecurityMetricsService,
  ) {}

  // ---- helpers ---------------------------------------------------------------

  private destinationHash(destination: unknown): string {
    return `sha256:${sha256Hex(JSON.stringify(destination ?? {}))}`;
  }

  private async loadWithdrawal(id: string) {
    const w = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Withdrawal not found');
    return w;
  }

  private async audit(actorId: string, action: string, withdrawalId: string, metadata?: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action,
        entityType: 'WITHDRAWAL',
        entityId: withdrawalId,
        ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /**
   * Manual settlement is only allowed for the v1.0.8 allowlisted offline
   * channels (§3.2). The v1.0.7 regex-based helper is replaced by the
   * explicit centralized allowlist; legacy MANUAL_BANK rows are recognized
   * for READ-side continuity only.
   */
  isManualProvider(provider: string): boolean {
    return isManualSettlementChannel(provider) || provider.toUpperCase() === 'MANUAL_BANK';
  }

  /** v1.0.7 — providers that can be selected for API-verified payouts right now. */
  activePayoutProviders(): string[] {
    return this.registry.activeProviders();
  }

  // ---- v1.0.7 initiation ------------------------------------------------------

  /**
   * Real provider payout initiation (v1.0.7 §3): enforces executor separation
   * + approval snapshot binding, resolves the beneficiary, commits the durable
   * intent (attempt + outbox) and dispatches the provider transfer through
   * the outbox pipeline. Replaces the v1.0.6 startAttempt registration-only
   * path, which never moved money.
   */
  async initiate(withdrawalId: string, actor: Actor, input: { payoutProvider: string; isRetry?: boolean }) {
    return this.initiation.initiate(withdrawalId, actor, { payoutProvider: input.payoutProvider, isRetry: input.isRetry });
  }

  // ---- manual settlement (v1.0.4 §6.2/§7, hardened v1.0.9 §3/§5) ---------------

  /**
   * v1.0.9 §5.1 — authorize a MANUAL payout intent and BIND the immutable
   * manual approval snapshot onto BOTH approval records. This is step one of
   * the two-step manual settlement protocol; step two is settleManual().
   *
   * The snapshot binds (SHA-256, constant-time verified at settlement):
   * withdrawal id, requester, amount (minor units), currency, beneficiary
   * identity (destination hash), destination version, settlement channel,
   * MANUAL_SETTLEMENT designation, approval cycle id, both approver ids, both
   * approval row ids and both approval timestamps.
   *
   * Four-person separation (requester, first approver, second approver,
   * authorizing executor = the acting admin) is enforced inside the locked
   * transaction. Legacy withdrawals without a bound snapshot can never skip
   * this step (no grandfathering, §5.2).
   */
  async authorizeManualIntent(withdrawalId: string, actor: Actor, input: { payoutProvider: string; note?: string }) {
    // §3.3 — service-layer allowlist assertion (the security boundary).
    const channel = assertManualSettlementChannel(input.payoutProvider);

    try {
      const attempt = await this.prisma.$transaction(async (tx) => {
        // Lock the authoritative withdrawal row.
        await tx.$queryRaw`SELECT "id" FROM "Withdrawal" WHERE "id" = ${withdrawalId} FOR UPDATE`;
        const fresh = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
        if (fresh.status !== WithdrawalStatus.APPROVED) {
          throw new ConflictException('Manual payout intent authorization requires an APPROVED withdrawal');
        }

        // §3.1 — in-lock recheck: a payout with an unresolved provider
        // transfer can never be replaced by a manual intent.
        const unresolved = await tx.payoutAttempt.findFirst({
          where: { withdrawalId, status: { in: UNRESOLVED_ATTEMPT_STATUSES } },
        });
        if (unresolved) {
          throw new ConflictException('A payout attempt is unresolved — the outcome must be established before a manual intent can be authorized');
        }

        // §3.2 — durable coordination claim (same transaction, same locks).
        const guardClaimed = await this.initiation.claimManualSettlementGuard(tx, withdrawalId, actor.id);
        if (!guardClaimed) {
          this.metrics.inc('blockedManualSettlements');
          await tx.$executeRaw`UPDATE "PayoutSettlementGuard" SET "manualBlocks" = "manualBlocks" + 1, "lastBlockedReason" = 'manual intent authorization blocked by an active settlement path', "lastBlockedAt" = now(), "updatedAt" = now() WHERE "withdrawalId" = ${withdrawalId}`.catch(() => undefined);
          throw new ConflictException('A settlement path is active — manual payout intent authorization is blocked');
        }

        // §4.3/§5 — full approval-cycle validation INSIDE the lock: requester
        // + both approvers + the authorizing executor must be four distinct
        // identities, and the approved details must still bind exactly.
        const cycle = await this.approvalCycles.validate(tx, withdrawalId, {
          executorId: actor.id,
          requireExecutor: true,
          allowedStatuses: [WithdrawalStatus.APPROVED],
        });
        if (!cycle.valid) {
          throw new ForbiddenException(`Manual payout intent blocked: the approval cycle is invalid — ${cycle.invalidReason}`);
        }

        // §5.1 — bind the immutable manual snapshot on BOTH approvals.
        const approvals = await tx.withdrawalApproval.findMany({ where: { withdrawalId, cycle: fresh.approvalCycle, status: 'ACTIVE' } });
        const destinationRef = this.destinationHash(fresh.destination);
        const { expected } = this.approvalCycles.buildManualSnapshot(fresh, approvals, channel, destinationRef);
        const first = approvals.find((a) => a.role === 'FIRST_APPROVER');
        const second = approvals.find((a) => a.role === 'SECOND_APPROVER');
        if (!first || !second) throw new ForbiddenException('Dual approval: an active first and second approval are required');
        await tx.withdrawalApproval.update({ where: { id: first.id }, data: { snapshotHash: expected } });
        await tx.withdrawalApproval.update({ where: { id: second.id }, data: { snapshotHash: expected } });

        // Register the durable manual intent (attempt WITHOUT an outbox row —
        // manual intents never produce a provider submission).
        const lastAttempt = await tx.payoutAttempt.findFirst({ where: { withdrawalId }, orderBy: { attemptNo: 'desc' } });
        const attemptNo = (lastAttempt?.attemptNo ?? 0) + 1;
        const created = await tx.payoutAttempt.create({
          data: {
            withdrawalId,
            attemptNo,
            provider: channel,
            manualChannel: channel,
            idempotencyKey: `payout:${withdrawalId}:${attemptNo}`,
            amount: fresh.amount,
            currency: fresh.currency,
            destinationRef,
            status: PayoutAttemptStatus.INITIATED,
            initiatedById: actor.id,
          },
        });

        // The intent is committed; release the guard. The INITIATED attempt
        // keeps BOTH settlement paths blocked through the in-transaction
        // rechecks until this intent is settled or explicitly superseded.
        await tx.$executeRaw`UPDATE "PayoutSettlementGuard" SET "mode" = 'IDLE', "claimedBy" = NULL, "claimedAt" = NULL, "claimedUntil" = NULL, "updatedAt" = now() WHERE "withdrawalId" = ${withdrawalId} AND "mode" = 'MANUAL_SETTLEMENT_ACTIVE'`;

        await tx.auditLog.create({
          data: {
            actorUserId: actor.id,
            action: 'PAYOUT_MANUAL_INTENT_AUTHORIZED',
            entityType: 'WITHDRAWAL',
            entityId: withdrawalId,
            metadata: {
              attemptId: created.id,
              attemptNo,
              settlementChannel: channel,
              approvalCycleId: cycle.approvalCycleId,
              approvalSnapshotHash: expected,
              requesterId: cycle.requesterId,
              firstApproverId: cycle.firstApproverId,
              secondApproverId: cycle.secondApproverId,
              executorId: actor.id,
              destinationVersion: fresh.destinationVersion,
              note: input.note ?? null,
            } as Prisma.InputJsonValue,
          },
        });
        return created;
      });
      return attempt;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A payout attempt already exists for this withdrawal state (duplicate prevented)');
      }
      throw err;
    }
  }

  /**
   * Complete an authorized MANUAL settlement. v1.0.9 hardening:
   *   1. the settlement channel is asserted against the EXPLICIT server-side
   *      allowlist here at the service layer (mandatory, independent of the
   *      DTO/controller) — API providers are structurally rejected;
   *   2. the withdrawal row is LOCKED and EVERY check runs INSIDE the
   *      transaction (§3.1: no pre-transaction checks are trusted):
   *      withdrawal status, unresolved provider attempts, pending outbox
   *      submissions, active submission leases, the durable settlement guard;
   *   3. the IMMUTABLE approval snapshot is REQUIRED (§5.1: requireBoundSnapshot
   *      with the manual snapshot — missing hashes, hash mismatches, changed
   *      amount/currency/destination/channel all block settlement; legacy
   *      withdrawals without a bound snapshot require the authorization step,
   *      §5.2 — no grandfathering);
   *   4. evidence is re-validated INSIDE the transaction against authorized
   *      StoredFile records (§3.5/§5.3);
   *   5. the reconciliation row uses the DISTINCT classification
   *      MANUAL_EVIDENCE_RECORDED (§3.4);
   *   6. the coordination guard is marked SETTLED — a provider submission can
   *      never start afterwards (§3.2);
   *   7. exactly-once ledger posting via the unique `withdrawal:<id>` ref.
   */
  async settleManual(withdrawalId: string, actor: Actor, input: ManualSettlementInput) {
    // §3.3 — service-layer allowlist assertion (the security boundary).
    const channel = assertManualSettlementChannel(input.payoutProvider);

    const withdrawal = await this.loadWithdrawal(withdrawalId);
    void withdrawal; // existence check only — every decision runs under the lock

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // §3.6 step 1 — lock the withdrawal (ALL checks below run under this
        // lock — the v1.0.8 pre-transaction unresolved check was TOCTOU-vulnerable
        // and is now performed here, §3.1).
        await tx.$queryRaw`SELECT "id" FROM "Withdrawal" WHERE "id" = ${withdrawalId} FOR UPDATE`;
        const fresh = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
        const payableStates: WithdrawalStatus[] = [WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING, WithdrawalStatus.REQUIRES_RECONCILIATION];
        if (!payableStates.includes(fresh.status)) {
          throw new BadRequestException('Withdrawal is not in a payable state');
        }

        // §3.1 — in-lock recheck of unresolved PROVIDER attempts. Manual-
        // channel attempts (the registered intent this settlement completes)
        // are exempt.
        const unresolved = await tx.payoutAttempt.findFirst({
          where: {
            withdrawalId,
            status: { in: UNRESOLVED_ATTEMPT_STATUSES },
            provider: { notIn: [...MANUAL_SETTLEMENT_CHANNELS, 'MANUAL_BANK'] },
          },
        });
        if (unresolved) {
          throw new ConflictException(
            'A provider transfer attempt is unresolved — run verification before manual settlement (recheck under the withdrawal lock, v1.0.9 §3.1)',
          );
        }

        // §3.1 — in-lock recheck of pending outbox submissions / active
        // submission leases: any PENDING or IN_FLIGHT outbox event for this
        // withdrawal means a provider submission may be authorized or in
        // flight — manual settlement is blocked.
        const pendingOutbox = await tx.payoutOutbox.findFirst({
          where: { withdrawalId, status: { in: ['PENDING', 'IN_FLIGHT'] } },
        });
        if (pendingOutbox) {
          throw new ConflictException('A provider submission is pending or in flight for this withdrawal — manual settlement is blocked (v1.0.9 §3.1)');
        }

        // §3.2 — durable coordination claim: MANUAL_SETTLEMENT_ACTIVE in the
        // SAME transaction that will settle. A provider submission holding a
        // valid lease (or a settled withdrawal) blocks the claim — the two
        // paths can never independently authorize competing payments.
        const guardClaimed = await this.initiation.claimManualSettlementGuard(tx, withdrawalId, actor.id);
        if (!guardClaimed) {
          this.metrics.inc('blockedManualSettlements');
          await tx.$executeRaw`UPDATE "PayoutSettlementGuard" SET "manualBlocks" = "manualBlocks" + 1, "lastBlockedReason" = 'manual settlement blocked by an active settlement path', "lastBlockedAt" = now(), "updatedAt" = now() WHERE "withdrawalId" = ${withdrawalId}`.catch(() => undefined);
          throw new ConflictException('A settlement path is active — manual settlement is blocked by the durable coordination guard (v1.0.9 §3.2)');
        }

        // §3.6 steps 2-3 + §4.3/§5.1 — validate the CURRENT approval cycle
        // INSIDE the transaction with the IMMUTABLE MANUAL SNAPSHOT REQUIRED:
        // requester/approvers/executor separation + channel-bound snapshot
        // recomputation + constant-time comparison. A withdrawal without the
        // bound snapshot (legacy) is NEVER grandfathered (§5.2) — authorize
        // the manual payout intent (or restart the approval cycle) first.
        const destinationRef = this.destinationHash(fresh.destination);
        const cycle = await this.approvalCycles.validate(tx, withdrawalId, {
          executorId: actor.id,
          requireExecutor: true,
          allowedStatuses: [WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING, WithdrawalStatus.REQUIRES_RECONCILIATION],
          requireBoundSnapshot: true,
          settlementChannel: channel,
          manualDestinationRef: destinationRef,
        });
        if (!cycle.valid) {
          throw new ForbiddenException(`Manual settlement blocked: the approval cycle is invalid — ${cycle.invalidReason}`);
        }

        // §3.6 step 4 + §5.1/§5.2 — attempt association: this settlement
        // completes the AUTHORIZED manual intent (the INITIATED manual-channel
        // attempt whose authorization bound the immutable snapshot). A
        // withdrawal without that authorized intent can never settle manually
        // — legacy withdrawals are NEVER grandfathered (§5.2): authorize the
        // manual payout intent (or restart the approval cycle) first.
        const intent = await tx.payoutAttempt.findFirst({
          where: {
            withdrawalId,
            status: PayoutAttemptStatus.INITIATED,
            provider: { in: [...MANUAL_SETTLEMENT_CHANNELS, 'MANUAL_BANK'] },
          },
          orderBy: { attemptNo: 'desc' },
        });
        if (!intent) {
          throw new ForbiddenException(
            'No authorized manual payout intent exists — authorize the manual payout intent first (v1.0.9 §5.2: withdrawals without a bound manual approval snapshot are never grandfathered)',
          );
        }
        if (intent.initiatedById === cycle.requesterId || intent.initiatedById === cycle.firstApproverId || intent.initiatedById === cycle.secondApproverId) {
          throw new ForbiddenException('Executor separation: the persisted intent executor collides with the requester or an approver (v1.0.9 §4)');
        }

        // §3.6 step 5 + §3.5 — evidence re-validated INSIDE the transaction.
        const evidenceFile = await this.evidence.validateEvidenceFile(tx, input.evidenceFileId, actor, withdrawalId);

        // §3.6 step 6 — validate the approved amount/currency are the ones
        // being settled (the cycle check bound them; assert explicitly too).
        if (cycle.approvedAmountMinor !== fresh.amount || cycle.approvedCurrency?.toUpperCase() !== fresh.currency.toUpperCase()) {
          throw new ConflictException('Approved amount/currency do not match the withdrawal — settlement refused');
        }

        // §3.6 steps 7-8 — record the manual settlement.
        const updated = await tx.withdrawal.updateMany({
          where: { id: withdrawalId, status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING, WithdrawalStatus.REQUIRES_RECONCILIATION] as WithdrawalStatus[] } },
          data: {
            status: WithdrawalStatus.PAID,
            paidAt: new Date(),
            paidById: actor.id,
            payoutProvider: channel,
            payoutProviderTxnId: input.payoutProviderTxnId,
            providerTransferRef: input.providerTransferRef,
          },
        });
        if (updated.count === 0) throw new ConflictException('Withdrawal state changed concurrently during manual settlement');

        // Complete the AUTHORIZED intent attempt (not a fresh row): the
        // settlement chain stays one auditable unit — authorization (snapshot
        // bound) -> completion (evidence + provider ref recorded).
        const attempt = await tx.payoutAttempt.update({
          where: { id: intent.id },
          data: {
            providerTransferRef: input.providerTransferRef,
            status: PayoutAttemptStatus.SUCCESSFUL,
            providerStatus: input.payoutProviderTxnId ?? 'MANUAL_CONFIRMED',
            classification: 'SUCCESSFUL',
            lastVerifiedAt: new Date(),
            resolvedAt: new Date(),
          },
        });
        // §3.4 — DISTINCT reconciliation classification: no authoritative
        // provider verification occurred, so the row MUST NOT read MATCHED.
        await tx.payoutReconciliation.create({
          data: {
            withdrawalId,
            attemptId: attempt.id,
            result: 'MANUAL_EVIDENCE_RECORDED',
            providerStatus: 'MANUAL_CONFIRMED',
            internalStatus: 'PAID',
            amountMatched: true,
            currencyMatched: true,
            destinationMatched: true,
            note: input.note ?? 'Manual settlement with registered evidence file',
            providerEvidence: {
              settlementChannel: channel,
              evidenceFileId: evidenceFile.id,
              approvalCycleId: cycle.approvalCycleId,
              approvalSnapshotHash: cycle.approvalSnapshotHash,
              requesterId: cycle.requesterId,
              firstApproverId: cycle.firstApproverId,
              secondApproverId: cycle.secondApproverId,
              executorId: actor.id,
              classification: 'MANUAL_EVIDENCE_RECORDED',
            } as Prisma.InputJsonValue,
            createdById: actor.id,
          },
        });

        // §3.6 step 9 — reservation/accounting: exactly-once ledger posting.
        await this.ledger.postWithdrawal(
          {
            withdrawalId: fresh.id,
            publicRef: fresh.publicRef,
            campaignId: fresh.campaignId,
            currency: fresh.currency,
            amount: fresh.amount,
            feeAmount: fresh.feeAmount,
            netAmount: fresh.netAmount,
          },
          tx,
        );
        // §3.2 — the withdrawal is settled BY HAND: the coordination guard is
        // TERMINAL. No provider worker can ever submit against this withdrawal
        // afterwards (a provider-settled withdrawal can never be manually
        // settled either — the guard/PAID status make both directions closed).
        await tx.$executeRaw`UPDATE "PayoutSettlementGuard" SET "mode" = 'SETTLED', "claimedBy" = NULL, "claimedAt" = NULL, "claimedUntil" = NULL, "updatedAt" = now() WHERE "withdrawalId" = ${withdrawalId}`.catch(() => undefined);
        // §3.6 step 10 + §14 — immutable audit history with the full
        // authorization context (no secrets, no full beneficiary PII).
        await tx.auditLog.create({
          data: {
            actorUserId: actor.id,
            action: 'WITHDRAWAL_PAID_MANUAL_SETTLEMENT',
            entityType: 'WITHDRAWAL',
            entityId: withdrawalId,
            metadata: {
              amount: fresh.amount.toString(),
              currency: fresh.currency,
              netAmount: fresh.netAmount.toString(),
              settlementChannel: channel,
              providerTransferRef: input.providerTransferRef,
              payoutProviderTxnId: input.payoutProviderTxnId,
              evidenceFileId: evidenceFile.id,
              attemptId: attempt.id,
              approvalCycleId: cycle.approvalCycleId,
              approvalSnapshotHash: cycle.approvalSnapshotHash,
              requesterId: cycle.requesterId,
              firstApproverId: cycle.firstApproverId,
              secondApproverId: cycle.secondApproverId,
              executorId: actor.id,
              reconciliationClassification: 'MANUAL_EVIDENCE_RECORDED',
              legacyApproverId: fresh.reviewedById,
              legacySecondApproverId: fresh.secondApprovedById,
            } as Prisma.InputJsonValue,
          },
        });
        return { attempt, withdrawal: await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } }) };
      });
      return result;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('This withdrawal has already been settled (duplicate payout prevented)');
      }
      throw err;
    }
  }

  // ---- authoritative verification ---------------------------------------------

  /**
   * Query the provider for the authoritative transfer outcome and apply it to
   * the state machine atomically (v1.0.7 §5.3/§7). This is the ONLY path that
   * may move PROCESSING to FAILED (authoritative terminal failure) and the
   * standard path to PAID.
   */
  async verifyAttempt(attemptId: string, actor: Actor | null) {
    return this.verification.verifyAttempt(attemptId, { source: 'API_VERIFY', actorId: actor?.id ?? null });
  }

  /**
   * Legacy direct-application entry point preserved for tests/tools: applies
   * a classified verification through the atomic reconciliation service.
   */
  async applyProviderVerification(
    attemptId: string,
    verification: {
      classification: string;
      providerStatus: string;
      providerReference?: string;
      providerTransferId?: string;
      amountMinor?: bigint;
      currency?: string;
      beneficiaryRef?: string;
      evidence?: Record<string, unknown>;
    },
    actor: Actor | null,
  ) {
    return this.reconcileDirect(attemptId, verification, actor);
  }

  private async reconcileDirect(
    attemptId: string,
    verification: {
      classification: string;
      providerStatus: string;
      providerReference?: string;
      providerTransferId?: string;
      amountMinor?: bigint;
      currency?: string;
      beneficiaryRef?: string;
      evidence?: Record<string, unknown>;
    },
    _actor: Actor | null,
  ) {
    void _actor;
    return this.reconciliation.apply({
      attemptId,
      verification: {
        classification: verification.classification as never,
        providerStatus: verification.providerStatus,
        providerReference: verification.providerReference,
        providerTransferId: verification.providerTransferId,
        amountMinor: verification.amountMinor,
        currency: verification.currency,
        beneficiaryRef: verification.beneficiaryRef,
        evidence: verification.evidence,
      },
      source: 'RECONCILIATION_SWEEP',
    });
  }

  // ---- reconciliation ---------------------------------------------------------

  /** Reconcile a withdrawal's latest (or given) attempt; idempotent, read-only on money. */
  async reconcileWithdrawal(withdrawalId: string, actor: Actor | null, attemptId?: string) {
    const withdrawal = await this.loadWithdrawal(withdrawalId);
    const attempt =
      (attemptId
        ? await this.prisma.payoutAttempt.findFirst({ where: { id: attemptId, withdrawalId } })
        : await this.prisma.payoutAttempt.findFirst({ where: { withdrawalId }, orderBy: { attemptNo: 'desc' } })) ?? null;

    if (attempt && attempt.provider !== 'MANUAL_BANK' && attempt.status !== PayoutAttemptStatus.SUCCESSFUL) {
      if (attempt.providerTransferRef || attempt.providerTransferId) {
        const result = await this.verification.verifyAttempt(attempt.id, { source: 'RECONCILIATION_SWEEP', actorId: actor?.id ?? null });
        return { withdrawalId, attemptId: attempt.id, verification: result.verification, outcome: result.outcome };
      }
      if (attempt.status === PayoutAttemptStatus.INITIATED) {
        // v1.0.7: an INITIATED attempt without provider identity is submitted
        // through the outbox pipeline (never re-registered).
        await this.initiation.submitOutbox(attempt.id);
        return { withdrawalId, attemptId: attempt.id, note: 'Intent submitted through the outbox pipeline' };
      }
      return { withdrawalId, attemptId: attempt.id, note: `Attempt ${attempt.status} — handled by escalation/manual review` };
    }
    if (attempt) {
      return { withdrawalId, attemptId: attempt.id, note: `Attempt already resolved (${attempt.status})` };
    }
    return { withdrawalId, result: 'NO_ATTEMPTS' };
  }

  // ---- safe retry ---------------------------------------------------------------

  /**
   * Retry is permitted ONLY when:
   *  - the withdrawal is FAILED (the previous attempt authoritatively failed),
   *  - no unresolved attempt exists,
   *  - the previous attempt carries a failure reason from verification,
   *  - a fresh attemptNo/idempotencyKey is minted by the initiation pipeline.
   * The v1.0.7 retry performs a REAL provider initiation (durable intent +
   * outbox + transfer) — not a registration-only action.
   */
  async retry(withdrawalId: string, actor: Actor, input: RetryInput) {
    const withdrawal = await this.loadWithdrawal(withdrawalId);
    if (withdrawal.status !== WithdrawalStatus.FAILED) {
      throw new ConflictException(
        `Retry requires a FAILED withdrawal (current: ${withdrawal.status}). A pending, ambiguous or processing transfer can never be retried.`,
      );
    }
    const unresolved = await this.prisma.payoutAttempt.findFirst({
      where: { withdrawalId, status: { in: UNRESOLVED_ATTEMPT_STATUSES } },
    });
    if (unresolved) {
      throw new ConflictException('An unresolved attempt exists — retry is impossible until it is authoritatively resolved');
    }
    const last = await this.prisma.payoutAttempt.findFirst({ where: { withdrawalId }, orderBy: { attemptNo: 'desc' } });
    if (last && last.status !== PayoutAttemptStatus.FAILED) {
      throw new ConflictException('The previous attempt is not authoritatively FAILED — retry refused');
    }
    if (last && !last.failureReason) {
      throw new ConflictException('The previous attempt has no recorded authoritative failure reason — reconcile first');
    }

    const provider = input.payoutProvider ?? last?.provider ?? 'MANUAL_BANK_TRANSFER';
    const manualChannel = normalizeLegacyManualChannel(provider);
    if (manualChannel) {
      // Manual-channel retry: authorize the manual payout intent for the
      // manual settlement workflow (the executor completes it outside the API
      // with evidence + settleManual). v1.0.8 §3.2 — only allowlisted channels
      // (incl. the legacy alias) are recognized; v1.0.9 §5.1 — the immutable
      // MANUAL approval snapshot is BOUND here, so the later settlement can
      // verify it (legacy/no-snapshot settlements are impossible, §5.2).
      assertTransition(withdrawal.status, WithdrawalStatus.PROCESSING);
      const attempt = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Withdrawal" WHERE "id" = ${withdrawalId} FOR UPDATE`;
        const fresh = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
        // v1.0.9 §3.1 — in-lock recheck: nothing unresolved may exist.
        const unresolvedInLock = await tx.payoutAttempt.findFirst({ where: { withdrawalId, status: { in: UNRESOLVED_ATTEMPT_STATUSES } } });
        if (unresolvedInLock) throw new ConflictException('An unresolved attempt exists — retry is impossible until it is authoritatively resolved');
        // v1.0.9 §3.2 — durable coordination claim for the intent binding.
        const guardClaimed = await this.initiation.claimManualSettlementGuard(tx, withdrawalId, actor.id);
        if (!guardClaimed) {
          this.metrics.inc('blockedManualSettlements');
          throw new ConflictException('A settlement path is active — manual retry authorization is blocked (v1.0.9 §3.2)');
        }
        const updated = await tx.withdrawal.updateMany({
          where: { id: withdrawalId, status: WithdrawalStatus.FAILED },
          data: { status: WithdrawalStatus.PROCESSING },
        });
        if (updated.count === 0) throw new ConflictException('Payout state changed concurrently — retry rejected');

        // v1.0.9 §5.1 — bind the immutable MANUAL approval snapshot.
        const approvals = await tx.withdrawalApproval.findMany({ where: { withdrawalId, cycle: fresh.approvalCycle, status: 'ACTIVE' } });
        const destinationRef = this.destinationHash(fresh.destination);
        const { expected: snapshotHash } = this.approvalCycles.buildManualSnapshot(fresh, approvals, manualChannel, destinationRef);
        const firstApp = approvals.find((a) => a.role === 'FIRST_APPROVER');
        const secondApp = approvals.find((a) => a.role === 'SECOND_APPROVER');
        if (!firstApp || !secondApp) throw new ForbiddenException('Dual approval: an active first and second approval are required before payout execution');
        await tx.withdrawalApproval.update({ where: { id: firstApp.id }, data: { snapshotHash } });
        await tx.withdrawalApproval.update({ where: { id: secondApp.id }, data: { snapshotHash } });

        const lastAttempt = await tx.payoutAttempt.findFirst({ where: { withdrawalId }, orderBy: { attemptNo: 'desc' } });
        const attemptNo = (lastAttempt?.attemptNo ?? 0) + 1;
        const created = await tx.payoutAttempt.create({
          data: {
            withdrawalId,
            attemptNo,
            provider: manualChannel,
            manualChannel,
            idempotencyKey: `payout:${withdrawalId}:${attemptNo}`,
            amount: fresh.amount,
            currency: fresh.currency,
            destinationRef,
            status: PayoutAttemptStatus.INITIATED,
            initiatedById: actor.id,
          },
        });
        // The intent is committed — release the guard (the INITIATED attempt
        // keeps both settlement paths blocked via the in-lock rechecks).
        await tx.$executeRaw`UPDATE "PayoutSettlementGuard" SET "mode" = 'IDLE', "claimedBy" = NULL, "claimedAt" = NULL, "claimedUntil" = NULL, "updatedAt" = now() WHERE "withdrawalId" = ${withdrawalId} AND "mode" = 'MANUAL_SETTLEMENT_ACTIVE'`;
        await tx.auditLog.create({
          data: {
            actorUserId: actor.id,
            action: 'PAYOUT_RETRY_AUTHORIZED_MANUAL',
            entityType: 'WITHDRAWAL',
            entityId: withdrawalId,
            metadata: {
              attemptId: created.id,
              attemptNo,
              provider,
              previousAttemptId: last?.id,
              previousFailureReason: last?.failureReason,
              approvalSnapshotHash: snapshotHash,
              settlementChannel: manualChannel,
            },
          },
        });
        return created;
      });
      return attempt;
    }

    const attempt = await this.initiation.initiate(withdrawalId, actor, { payoutProvider: provider, isRetry: true });
    await this.audit(actor.id, 'PAYOUT_RETRY_AUTHORIZED', withdrawalId, {
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      provider,
      previousAttemptId: last?.id,
      previousFailureReason: last?.failureReason,
    });
    return attempt;
  }
}
