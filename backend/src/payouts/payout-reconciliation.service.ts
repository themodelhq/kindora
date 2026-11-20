import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PayoutAttemptStatus, PayoutReversalState, Prisma, ReconciliationResult, VerificationSource, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { sha256Hex } from '../common/utils/crypto.util';
import { assertAttemptTransition, assertReversalTransition, assertTransition, evaluateReconciliation, manualReviewCategoryFor, reversalStateFor, type ReconciliationEvaluation, type TransferVerification } from './payout-state-machine';
import { ManualReviewService } from './manual-review.service';
import { PayoutApprovalCycleService } from './payout-approval-cycle.service';
import { PayoutSecurityMetricsService } from './payout-metrics.service';

export interface ApplyOutcomeInput {
  attemptId: string;
  verification: TransferVerification;
  source: VerificationSource;
  correlationId?: string;
  /** Pre-computed duplicate-reference flag (verification service checks). */
  duplicateReference?: boolean;
}

/**
 * KINDORA v1.0.7 §7 — centralized ATOMIC reconciliation for EVERY outcome.
 *
 * v1.0.6 applied success in one transaction but left pending/unknown/mismatch
 * paths scattering attempt + withdrawal writes across separate statements.
 * v1.0.7 routes EVERY outcome through this single method:
 *
 *  ONE database transaction:
 *    1. lock the withdrawal row        (SELECT ... FOR UPDATE)
 *    2. lock the payout attempt row    (SELECT ... FOR UPDATE — v1.0.10 §5:
 *       the locked query explicitly selects initiatedById, provider,
 *       idempotencyKey, withdrawalId together with the settlement fields)
 *    3. validate attempt ↔ withdrawal relation
 *    4. validate the approval cycle (ACTIVE first + second, distinct —
 *       v1.0.10 §5.3: the executor identity passed to the validator is the
 *       one read UNDER THE ROW LOCK, locked.initiatedById; stale
 *       pre-transaction identities can never authorize settlement)
 *    5. classify the outcome (fail-closed evaluateReconciliation)
 *    6. persist the immutable reconciliation + evidence rows
 *    7. attempt state transition (assertAttemptTransition)
 *    8. withdrawal state transition (conditional updateMany, guarded)
 *    9. reservation/ledger updates ONLY when policy permits
 *   10. immutable audit event
 *
 * All-or-nothing: related state changes either all commit or all roll back.
 * Row locks + conditional updates make concurrent reconciliations serialize:
 * the loser re-reads committed state and becomes a no-op.
 *
 * v1.0.10 §5.5 — every security-sensitive decision inside the transaction
 * uses the LOCKED rows as the source of truth. Pre-transaction reads are used
 * only as change-detection tripwires (amount/currency/provider/idempotencyKey
 * divergence aborts the reconciliation before anything is applied).
 */
@Injectable()
export class PayoutReconciliationService {
  private readonly logger = new Logger(PayoutReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly manualReview: ManualReviewService,
    private readonly approvalCycles: PayoutApprovalCycleService,
    private readonly metrics: PayoutSecurityMetricsService,
  ) {}

  /** Canonical evidence hash (tamper detection, §17). */
  private evidenceHash(parts: Record<string, unknown>): string {
    return sha256Hex(JSON.stringify(parts, Object.keys(parts).sort()));
  }

  private async duplicateReferenceExists(attemptId: string, providerRef: string): Promise<boolean> {
    if (!providerRef) return false;
    const dup = await this.prisma.payoutAttempt.findFirst({ where: { providerTransferRef: providerRef, id: { not: attemptId } } });
    return Boolean(dup);
  }

  /**
   * v1.0.9 §3.2 — mark the durable settlement guard TERMINAL (SETTLED). Once
   * a withdrawal is settled (provider-verified or manual), no future
   * submission or settlement claim can ever succeed on its guard row.
   */
  private async markGuardSettled(tx: Prisma.TransactionClient, withdrawalId: string): Promise<void> {
    await tx
      .$executeRaw`UPDATE "PayoutSettlementGuard" SET "mode" = 'SETTLED', "claimedBy" = NULL, "claimedAt" = NULL, "claimedUntil" = NULL, "updatedAt" = now() WHERE "withdrawalId" = ${withdrawalId}`
      .catch(() => undefined);
  }

  async apply(input: ApplyOutcomeInput): Promise<{ outcome: ReconciliationResult; evaluation: ReconciliationEvaluation; applied: boolean }> {
    const attempt = await this.prisma.payoutAttempt.findUnique({ where: { id: input.attemptId } });
    if (!attempt) throw new ConflictException('Payout attempt not found');

    const duplicateReference =
      input.duplicateReference ?? (await this.duplicateReferenceExists(attempt.id, input.verification.providerReference ?? ''));

    const result = await this.prisma.$transaction(async (tx) => {
      // 1-2. Lock the authoritative rows.
      const wLock = await tx.$queryRaw<{ id: string; status: WithdrawalStatus; approvalCycle: number; amount: bigint; currency: string }[]>`SELECT "id", "status", "approvalCycle", "amount", "currency" FROM "Withdrawal" WHERE "id" = ${attempt.withdrawalId} FOR UPDATE`;
      const withdrawal = wLock[0];
      if (!withdrawal) throw new ConflictException('Withdrawal not found for attempt');
      // v1.0.10 §5.2 — the locked payout-attempt query EXPLICITLY selects the
      // executor identity (initiatedById) together with every other field the
      // final settlement validation depends on. The final authorization
      // decision MUST use THIS locked row — never the pre-transaction attempt
      // object, a stale worker payload or a caller-supplied identity (§5.3).
      const aLock = await tx.$queryRaw<{
        id: string;
        withdrawalId: string;
        initiatedById: string | null;
        provider: string;
        providerTransferRef: string | null;
        idempotencyKey: string;
        status: PayoutAttemptStatus;
        amount: bigint;
        currency: string;
        beneficiaryId: string | null;
        reversalState: PayoutReversalState | null;
      }[]>`SELECT "id", "withdrawalId", "initiatedById", "provider", "providerTransferRef", "idempotencyKey", "status", "amount", "currency", "beneficiaryId", "reversalState" FROM "PayoutAttempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
      const locked = aLock[0];
      if (!locked) throw new ConflictException('Payout attempt not found');
      // v1.0.10 §5.2 — the locked row must be the same attempt the caller
      // addressed AND belong to the locked withdrawal (authoritative
      // association, re-proven under the lock).
      if (locked.withdrawalId !== attempt.withdrawalId || locked.idempotencyKey !== attempt.idempotencyKey || locked.provider !== attempt.provider) {
        throw new ConflictException('Payout attempt row changed concurrently — reconciliation aborted (nothing applied)');
      }

      // 3. Attempt ↔ withdrawal relation.
      if (locked.amount !== attempt.amount || locked.currency !== attempt.currency) {
        throw new ConflictException('Attempt row changed concurrently — reconciliation aborted (nothing applied)');
      }

      // 4. Approval cycle validity — SUPERSEDED in v1.0.8 by the mandatory
      //    structured validation below (§4.5); the legacy local check is
      //    removed so no code path can mistake metadata for the gate.
      const withdrawalStatus = withdrawal.status;

      // 5. Approved beneficiary identity (§5.2): the provider's beneficiary
      //    evidence is compared with the EXTERNAL REF bound to the attempt —
      //    never with the destination JSON hash.
      let expectedBeneficiaryRef: string | null = null;
      if (locked.beneficiaryId) {
        const beneficiary = await tx.payoutBeneficiary.findUnique({ where: { id: locked.beneficiaryId } });
        expectedBeneficiaryRef = beneficiary?.externalRef ?? null;
      }

      // v1.0.8 §4.5 — MANDATORY approval-cycle validation, re-loaded from the
      // authoritative rows INSIDE this transaction (locks held). The value
      // recorded in v1.0.7 metadata was informational only; it is now the
      // hard gate on settlement below.
      const cycleValidation = await this.approvalCycles.validate(tx, withdrawal.id, {
        // v1.0.9 §4.2, corrected v1.0.10 §5.3 — the executor identity passed
        // to the validator is the one read UNDER THE ROW LOCK
        // (locked.initiatedById). The pre-transaction attempt object, a stale
        // worker payload, a cached identity or a caller-supplied executor are
        // never used for the final authorization decision. A missing locked
        // executor invalidates the cycle (requireExecutor) — settlement is
        // rejected below (§5.3: fail closed).
        executorId: locked.initiatedById ?? null,
        requireExecutor: true,
        provider: locked.provider,
        beneficiaryId: locked.beneficiaryId,
        beneficiaryExternalRef: input.verification.beneficiaryRef ?? null,
        requireBoundSnapshot: Boolean(locked.beneficiaryId),
      });

      // Reference belonging (§5.3.2): the provider response must carry this
      // attempt's submission reference.
      const referenceMismatch = Boolean(
        input.verification.providerReference &&
          locked.providerTransferRef &&
          input.verification.providerReference !== locked.providerTransferRef,
      );

      const evaluation = evaluateReconciliation({
        internalStatus: withdrawalStatus,
        attemptStatus: locked.status,
        verification: input.verification,
        expectedAmountMinor: locked.amount,
        expectedCurrency: locked.currency,
        expectedBeneficiaryRef,
        duplicateReference,
        referenceMismatch,
      });

      // 6. Immutable evidence + reconciliation rows (written BEFORE any
      //    state transition so the outcome is always explainable).
      const evHash = this.evidenceHash({
        attemptId: locked.id,
        provider: locked.provider,
        classification: input.verification.classification,
        providerStatus: input.verification.providerStatus,
        providerReference: input.verification.providerReference ?? null,
        providerTransferId: input.verification.providerTransferId ?? null,
        amountMinor: input.verification.amountMinor?.toString() ?? null,
        currency: input.verification.currency ?? null,
        beneficiaryRef: input.verification.beneficiaryRef ?? null,
        source: input.source,
      });
      await tx.payoutVerificationEvidence.create({
        data: {
          withdrawalId: withdrawal.id,
          attemptId: locked.id,
          source: input.source,
          provider: locked.provider,
          rawStatus: input.verification.providerStatus,
          classification: input.verification.classification,
          providerTransferRef: input.verification.providerReference ?? null,
          providerTransferId: input.verification.providerTransferId ?? null,
          amountMinor: input.verification.amountMinor ?? null,
          currency: input.verification.currency ?? null,
          beneficiaryRef: input.verification.beneficiaryRef ?? null,
          evidenceHash: evHash,
          payload: (input.verification.evidence ?? {}) as Prisma.InputJsonValue,
          correlationId: input.correlationId,
        },
      });
      await tx.payoutReconciliation.create({
        data: {
          withdrawalId: withdrawal.id,
          attemptId: locked.id,
          result: evaluation.result,
          providerStatus: input.verification.providerStatus,
          internalStatus: withdrawalStatus,
          amountMatched: evaluation.amountMatched,
          currencyMatched: evaluation.currencyMatched,
          destinationMatched: evaluation.beneficiaryMatched,
          providerEvidence: {
            classification: input.verification.classification,
            providerReference: input.verification.providerReference ?? null,
            providerTransferId: input.verification.providerTransferId ?? null,
            amountMinor: input.verification.amountMinor?.toString() ?? null,
            currency: input.verification.currency ?? null,
            beneficiaryRef: input.verification.beneficiaryRef ?? null,
            source: input.source,
            evidenceHash: evHash,
            approvalCycleValid: cycleValidation.valid,
            approvalCycleId: cycleValidation.approvalCycleId,
            approvalCycleInvalidReason: cycleValidation.invalidReason,
          } as Prisma.InputJsonValue,
          createdById: null,
        },
      });

      // 7-10. Outcome application — every branch inside THIS transaction.
      const now = new Date();
      let applied = true;

      // v1.0.8 §4.5 — hard approval-cycle gate on EVERY settleable outcome.
      // Provider verification proves the transfer happened; it can NEVER
      // replace internal authorization. An invalid/stale/incomplete cycle
      // blocks settlement and escalates for investigation.
      const settlableOutcome =
        evaluation.result === 'PROVIDER_SUCCESS_INTERNAL_PENDING' ||
        (evaluation.result === 'MATCHED' && input.verification.classification === 'SUCCESSFUL');
      if (settlableOutcome && !cycleValidation.valid) {
        const blocked: ReconciliationResult = 'INTERNAL_STATE_MISMATCH';
        this.logger.warn(
          `Settlement BLOCKED for attempt ${locked.id}: invalid approval cycle (${cycleValidation.invalidReason})`,
        );
        this.metrics.inc('blockedManualSettlements');
        assertAttemptTransition(locked.status, PayoutAttemptStatus.MANUAL_REVIEW);
        await tx.payoutAttempt.update({
          where: { id: locked.id },
          data: { status: PayoutAttemptStatus.MANUAL_REVIEW, classification: 'UNKNOWN', providerStatus: input.verification.providerStatus, lastVerifiedAt: now },
        });
        if (withdrawalStatus === WithdrawalStatus.PROCESSING) {
          assertTransition(withdrawalStatus, WithdrawalStatus.REQUIRES_RECONCILIATION);
          await tx.withdrawal.updateMany({ where: { id: withdrawal.id, status: WithdrawalStatus.PROCESSING }, data: { status: WithdrawalStatus.REQUIRES_RECONCILIATION } });
        }
        await tx.auditLog.create({
          data: {
            actorUserId: null,
            action: 'PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE',
            entityType: 'WITHDRAWAL',
            entityId: withdrawal.id,
            metadata: {
              attemptId: locked.id,
              provider: locked.provider,
              executorId: locked.initiatedById,
              providerReference: input.verification.providerReference ?? locked.providerTransferRef,
              providerStatus: input.verification.providerStatus,
              evidenceHash: evHash,
              approvalCycleId: cycleValidation.approvalCycleId,
              invalidReason: cycleValidation.invalidReason,
              correlationId: input.correlationId,
            },
          },
        });
        return { evaluation: { ...evaluation, result: blocked }, applied: true };
      }

      if (evaluation.result === 'PROVIDER_SUCCESS_INTERNAL_PENDING') {
        // Verified settlement — evidence complete, exact matches, cycle valid.
        assertAttemptTransition(locked.status, PayoutAttemptStatus.SUCCESSFUL);
        await tx.payoutAttempt.update({
          where: { id: locked.id },
          data: {
            status: PayoutAttemptStatus.SUCCESSFUL,
            classification: 'SUCCESSFUL',
            providerStatus: input.verification.providerStatus,
            providerTransferRef: input.verification.providerReference ?? locked.providerTransferRef,
            providerTransferId: input.verification.providerTransferId ?? null,
            lastVerifiedAt: now,
            resolvedAt: now,
          },
        });
        const allowedFrom: WithdrawalStatus[] = [WithdrawalStatus.PROCESSING, WithdrawalStatus.REQUIRES_RECONCILIATION];
        assertTransition(withdrawalStatus, WithdrawalStatus.PAID);
        const updated = await tx.withdrawal.updateMany({
          where: { id: withdrawal.id, status: { in: allowedFrom } },
          data: {
            status: WithdrawalStatus.PAID,
            paidAt: now,
            payoutProvider: locked.provider,
            providerTransferRef: input.verification.providerReference ?? locked.providerTransferRef,
          },
        });
        if (updated.count === 0) throw new ConflictException('Withdrawal state changed concurrently during settlement');
        const fresh = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
        // v1.0.9 §3.2 — the withdrawal is settled: the coordination guard is
        // TERMINAL. No worker can submit and no settlement can claim again.
        await this.markGuardSettled(tx, withdrawal.id);
        // 9. Finalize reservation + accounting (exactly once — unique ledger ref).
        await this.ledger.postWithdrawal(
          { withdrawalId: fresh.id, publicRef: fresh.publicRef, campaignId: fresh.campaignId, currency: fresh.currency, amount: fresh.amount, feeAmount: fresh.feeAmount, netAmount: fresh.netAmount },
          tx,
        );
        await tx.auditLog.create({
          data: {
            actorUserId: null,
            action: 'PAYOUT_SETTLED_PROVIDER_VERIFIED',
            entityType: 'WITHDRAWAL',
            entityId: fresh.id,
            metadata: {
              attemptId: locked.id,
              provider: locked.provider,
              executorId: locked.initiatedById,
              providerReference: input.verification.providerReference ?? locked.providerTransferRef,
              providerStatus: input.verification.providerStatus,
              evidenceHash: evHash,
              correlationId: input.correlationId,
            },
          },
        });
        return { evaluation, applied };
      }

      if (evaluation.result === 'PROVIDER_FAILED_INTERNAL_PROCESSING' || evaluation.result === 'MATCHED') {
        if (input.verification.classification === 'FAILED') {
          // Authoritative terminal failure (§7.4) — the ONLY route to FAILED.
          assertAttemptTransition(locked.status, PayoutAttemptStatus.FAILED);
          await tx.payoutAttempt.update({
            where: { id: locked.id },
            data: {
              status: PayoutAttemptStatus.FAILED,
              classification: 'FAILED',
              providerStatus: input.verification.providerStatus,
              failureReason: input.verification.failureReason ?? `Authoritative provider failure (${input.verification.providerStatus})`,
              lastVerifiedAt: now,
              resolvedAt: now,
            },
          });
          const updated = await tx.withdrawal.updateMany({
            where: { id: withdrawal.id, status: { in: [WithdrawalStatus.PROCESSING, WithdrawalStatus.REQUIRES_RECONCILIATION] } },
            data: { status: WithdrawalStatus.FAILED, failureReason: `Authoritative provider failure (${input.verification.providerStatus})` },
          });
          if (updated.count === 0) throw new ConflictException('Withdrawal state changed concurrently during failure application');
          await tx.auditLog.create({
            data: {
              actorUserId: null,
              action: 'PAYOUT_ATTEMPT_FAILED_AUTHORITATIVE',
              entityType: 'WITHDRAWAL',
              entityId: withdrawal.id,
              metadata: { attemptId: locked.id, provider: locked.provider, providerStatus: input.verification.providerStatus, evidenceHash: evHash },
            },
          });
          return { evaluation, applied };
        }
        if (input.verification.classification === 'REVERSED') {
          // Reversal is NEVER an ordinary failure (§7.4): recorded separately
          // with an auditable recovery decision.
          const target = PayoutAttemptStatus.REVERSED;
          assertAttemptTransition(locked.status, target);
          await tx.payoutAttempt.update({
            where: { id: locked.id },
            data: { status: target, classification: 'REVERSED', providerStatus: input.verification.providerStatus, lastVerifiedAt: now, resolvedAt: now },
          });
          if (withdrawalStatus === WithdrawalStatus.PAID) {
            assertTransition(withdrawalStatus, WithdrawalStatus.REVERSED);
            await tx.withdrawal.updateMany({ where: { id: withdrawal.id, status: WithdrawalStatus.PAID }, data: { status: WithdrawalStatus.REVERSED } });
          }
          await tx.auditLog.create({
            data: {
              actorUserId: null,
              action: 'PAYOUT_TRANSFER_REVERSED',
              entityType: 'WITHDRAWAL',
              entityId: withdrawal.id,
              metadata: { attemptId: locked.id, provider: locked.provider, providerStatus: input.verification.providerStatus, evidenceHash: evHash },
            },
          });
          return { evaluation, applied };
        }
        // MATCHED with an already-resolved attempt — re-check, no state change.
        applied = false;
        return { evaluation, applied };
      }

      if (evaluation.result === 'PROVIDER_PENDING') {
        assertAttemptTransition(locked.status, PayoutAttemptStatus.PENDING);
        await tx.payoutAttempt.update({
          where: { id: locked.id },
          data: { status: PayoutAttemptStatus.PENDING, classification: 'PENDING', providerStatus: input.verification.providerStatus, lastVerifiedAt: now },
        });
        // Keep PROCESSING + reservation; schedule later verification (worker).
        await tx.auditLog.create({
          data: { actorUserId: null, action: 'PAYOUT_VERIFICATION_PENDING', entityType: 'WITHDRAWAL', entityId: withdrawal.id, metadata: { attemptId: locked.id, providerStatus: input.verification.providerStatus } },
        });
        return { evaluation, applied };
      }

      if (evaluation.result === 'PROVIDER_REVERSAL_IN_PROGRESS') {
        // v1.0.8 §8.2 — an in-progress reversal is recorded in the reversal
        // lifecycle (forward-only), the attempt stays UNRESOLVED, the
        // reservation stays intact, and a controlled recovery decision is
        // escalated (§8.3). The withdrawal is never flipped to REVERSED here.
        const nextReversalState = reversalStateFor(locked.provider, input.verification.providerStatus) ?? 'UNKNOWN';
        assertReversalTransition(locked.reversalState, nextReversalState);
        await tx.payoutAttempt.update({
          where: { id: locked.id },
          data: {
            reversalState: nextReversalState,
            reversalObservedAt: now,
            classification: 'REVERSAL_IN_PROGRESS',
            providerStatus: input.verification.providerStatus,
            lastVerifiedAt: now,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: null,
            action: 'PAYOUT_REVERSAL_IN_PROGRESS_RECORDED',
            entityType: 'WITHDRAWAL',
            entityId: withdrawal.id,
            metadata: { attemptId: locked.id, provider: locked.provider, providerStatus: input.verification.providerStatus, reversalState: nextReversalState, evidenceHash: evHash },
          },
        });
        return { evaluation, applied };
      }

      if (evaluation.result === 'PROVIDER_REVERSED') {
        // Terminal reversal (§8.3): confirmed by authoritative provider
        // evidence, associated with the ORIGINAL transfer (this attempt),
        // recorded as a separate financial event — the original successful
        // transfer history is never erased. The accounting correction posts
        // exactly once (unique ledger reference). The lifecycle must be
        // forward-only: COMPLETED is terminal, duplicate postings impossible.
        assertAttemptTransition(locked.status, PayoutAttemptStatus.REVERSED);
        assertReversalTransition(locked.reversalState, 'COMPLETED');
        await tx.payoutAttempt.update({
          where: { id: locked.id },
          data: { status: PayoutAttemptStatus.REVERSED, classification: 'REVERSED', providerStatus: input.verification.providerStatus, reversalState: 'COMPLETED', reversalObservedAt: now, lastVerifiedAt: now, resolvedAt: now },
        });
        // A reversal is NEVER an ordinary failure: a settled withdrawal moves
        // to REVERSED for the auditable recovery decision (§7.4).
        if (withdrawalStatus === WithdrawalStatus.PAID) {
          assertTransition(withdrawalStatus, WithdrawalStatus.REVERSED);
          const fresh = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
          await tx.withdrawal.updateMany({ where: { id: withdrawal.id, status: WithdrawalStatus.PAID }, data: { status: WithdrawalStatus.REVERSED } });
          // Accounting correction — exactly-once via the unique ledger ref.
          await this.ledger.postWithdrawalReversal(
            { withdrawalId: fresh.id, publicRef: fresh.publicRef, campaignId: fresh.campaignId, currency: fresh.currency, amount: fresh.amount, feeAmount: fresh.feeAmount, netAmount: fresh.netAmount, attemptId: locked.id },
            tx,
          );
        }
        await tx.auditLog.create({
          data: { actorUserId: null, action: 'PAYOUT_REVERSAL_RECORDED', entityType: 'WITHDRAWAL', entityId: withdrawal.id, metadata: { attemptId: locked.id, providerStatus: input.verification.providerStatus, reversalState: 'COMPLETED', evidenceHash: evHash } },
        });
        return { evaluation, applied };
      }

      if (evaluation.result === 'PROVIDER_UNKNOWN' || evaluation.result === 'REQUIRES_MANUAL_INVESTIGATION') {
        const target = PayoutAttemptStatus.UNKNOWN;
        assertAttemptTransition(locked.status, target);
        await tx.payoutAttempt.update({
          where: { id: locked.id },
          data: { status: target, classification: 'UNKNOWN', providerStatus: input.verification.providerStatus, lastVerifiedAt: now },
        });
        if (withdrawalStatus === WithdrawalStatus.PROCESSING) {
          assertTransition(withdrawalStatus, WithdrawalStatus.REQUIRES_RECONCILIATION);
          await tx.withdrawal.updateMany({ where: { id: withdrawal.id, status: WithdrawalStatus.PROCESSING }, data: { status: WithdrawalStatus.REQUIRES_RECONCILIATION } });
        }
        return { evaluation, applied };
      }

      // Mismatch / duplicate / incomplete / manual-review-required: NEVER
      // settle, NEVER release, escalate (§7.4).
      const target = PayoutAttemptStatus.UNKNOWN;
      assertAttemptTransition(locked.status, target);
      await tx.payoutAttempt.update({
        where: { id: locked.id },
        data: { status: target, classification: input.verification.classification, providerStatus: input.verification.providerStatus, lastVerifiedAt: now },
      });
      if (withdrawalStatus === WithdrawalStatus.PROCESSING) {
        assertTransition(withdrawalStatus, WithdrawalStatus.REQUIRES_RECONCILIATION);
        await tx.withdrawal.updateMany({ where: { id: withdrawal.id, status: WithdrawalStatus.PROCESSING }, data: { status: WithdrawalStatus.REQUIRES_RECONCILIATION } });
      }
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          action: 'PAYOUT_RECONCILIATION_ESCALATED',
          entityType: 'WITHDRAWAL',
          entityId: withdrawal.id,
          metadata: { attemptId: locked.id, outcome: evaluation.result, evidenceHash: evHash },
        },
      });
      return { evaluation, applied };
    });

    // Manual review case (outside the money transaction — idempotent per case).
    const escalatesManualReview: ReconciliationResult[] = [
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'DESTINATION_MISMATCH',
      'REFERENCE_MISMATCH',
      'DUPLICATE_REFERENCE',
      'PROVIDER_DATA_INCOMPLETE',
      'REQUIRES_MANUAL_INVESTIGATION',
      'MANUAL_REVIEW_REQUIRED',
      'PROVIDER_REVERSED',
      // v1.0.8 §8.3 — in-progress reversals require a controlled recovery
      // decision too (replacement payout is forbidden until decided).
      'PROVIDER_REVERSAL_IN_PROGRESS',
    ];
    if (escalatesManualReview.includes(result.evaluation.result)) {
      const openCase = await this.prisma.manualReviewCase.findFirst({ where: { attemptId: attempt.id, status: 'OPEN' } });
      if (!openCase) {
        await this.manualReview.openCase({
          withdrawalId: attempt.withdrawalId,
          attemptId: attempt.id,
          category: manualReviewCategoryFor(result.evaluation.result),
          openedReason: `Automatic settlement blocked: reconciliation outcome ${result.evaluation.result} (source ${input.source})`,
          evidence: { providerStatus: input.verification.providerStatus, providerReference: input.verification.providerReference ?? null },
          correlationId: input.correlationId,
        });
      }
    }

    this.logger.warn(
      `Reconciliation applied for attempt ${attempt.id}: outcome=${result.evaluation.result} applied=${result.applied} (source=${input.source})`,
    );
    return { outcome: result.evaluation.result, evaluation: result.evaluation, applied: result.applied };
  }
}
