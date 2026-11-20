import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayoutAttemptStatus, PayoutOutboxStatus, Prisma, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QueueService, QUEUES } from '../common/queue.service';
import { sha256Hex } from '../common/utils/crypto.util';
import { ManualReviewService } from './manual-review.service';
import { PayoutBeneficiaryService } from './payout-beneficiary.service';
import { PayoutProviderRegistry } from './payout-provider.registry';
import { PayoutProviderRejectedError, PayoutTransportError, providerSubmissionReference, type PayoutLookupResult } from './payout-provider.adapter';
import { assertAttemptTransition, assertTransition } from './payout-state-machine';
import { PayoutApprovalCycleService } from './payout-approval-cycle.service';
import { PayoutSecurityMetricsService } from './payout-metrics.service';

export type Actor = { id: string; role: string };

export interface InitiationInput {
  payoutProvider: string;
  /** true when this initiation is the authorized retry of a FAILED payout. */
  isRetry?: boolean;
}

export interface SubmissionSummary {
  outboxId: string;
  attemptId: string;
  action: 'SUBMITTED' | 'ACCEPTED' | 'ALREADY_SUBMITTED' | 'LOOKUP_PENDING' | 'LOOKUP_BLOCKED' | 'LOOKUP_FOUND' | 'REJECTED' | 'AMBIGUOUS' | 'STATE_VIOLATION';
  providerTransferRef?: string;
  detail?: string;
}

/**
 * KINDORA v1.0.7 §3/§4/§8 — payout initiation pipeline.
 *
 * Guarantees:
 *  1. Executor separation (§8.2) is enforced BEFORE any external call — the
 *     executor can be neither the requester nor either approver.
 *  2. Fresh purpose-bound MFA is enforced at the controller; the approval
 *     snapshot (§8.3) is re-validated here against amount, currency,
 *     destinationVersion, provider and beneficiary identity.
 *  3. The intent (attempt + outbox) is COMMITTED before the provider call
 *     (§4.2). No DB transaction is ever held open across the provider API.
 *  4. Exactly one outbox row per attempt; exactly one submission per outbox
 *     row via durable conditional claims (§4.3).
 *  5. Ambiguous submission outcomes enter SUBMISSION_PENDING: the provider is
 *     queried for the existing transfer — another submission is forbidden
 *     until the outcome is resolved; unresolved ambiguity escalates to
 *     MANUAL_REVIEW after the configured window (§4.3).
 *  6. Definite provider rejections (4xx, no transfer created) are the ONLY
 *     initiation-phase route to FAILED.
 */
@Injectable()
export class PayoutInitiationService {
  private readonly logger = new Logger(PayoutInitiationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PayoutProviderRegistry,
    private readonly beneficiaries: PayoutBeneficiaryService,
    private readonly manualReview: ManualReviewService,
    private readonly queue: QueueService,
    private readonly config: ConfigService,
    private readonly approvalCycles: PayoutApprovalCycleService,
    private readonly metrics: PayoutSecurityMetricsService,
  ) {}

  /** v1.0.8 §5.2 — identity of THIS worker for outbox lease ownership. */
  private readonly workerId = `${process.env.HOSTNAME ?? 'api'}:${process.pid}`;

  private auditInTx(
    tx: Prisma.TransactionClient,
    actorId: string | null,
    action: string,
    withdrawalId: string,
    metadata: Record<string, unknown>,
  ) {
    return tx.auditLog.create({
      data: {
        actorUserId: actorId,
        action,
        entityType: 'WITHDRAWAL',
        entityId: withdrawalId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  // ---- v1.0.9 §3.2 — durable settlement-path coordination -------------------

  /**
   * Ensure the durable coordination guard row exists (one per withdrawal).
   * Called inside the initiation intent transaction so every later claim is a
   * simple atomic conditional UPDATE. Redis is never consulted for financial
   * correctness — this is a PostgreSQL-only mechanism.
   */
  private async ensureGuardRow(tx: Prisma.TransactionClient, withdrawalId: string): Promise<void> {
    await tx.$executeRaw`INSERT INTO "PayoutSettlementGuard" ("id", "withdrawalId", "mode", "updatedAt")
      VALUES (gen_random_uuid(), ${withdrawalId}, 'IDLE', now())
      ON CONFLICT ("withdrawalId") DO NOTHING`;
  }

  /**
   * Atomically claim the PROVIDER_SUBMISSION_ACTIVE guard. Succeeds only when
   * the guard is IDLE or holds an EXPIRED provider lease (a reclaim — which is
   * only ever reached through the safe lookup-first recovery path). A manual
   * settlement (MANUAL_SETTLEMENT_ACTIVE/SETTLED) or another worker's valid
   * lease makes this fail closed with zero rows updated.
   */
  private async claimSubmissionGuard(tx: Prisma.TransactionClient, withdrawalId: string, leaseExpiresAt: Date, reclaim: boolean): Promise<boolean> {
    const updated = await tx.$executeRaw`UPDATE "PayoutSettlementGuard"
      SET "mode" = 'PROVIDER_SUBMISSION_ACTIVE',
          "claimedBy" = ${this.workerId},
          "claimedAt" = now(),
          "claimedUntil" = ${leaseExpiresAt},
          "updatedAt" = now(),
          "expiredReclaims" = "expiredReclaims" + ${reclaim ? 1 : 0}
      WHERE "withdrawalId" = ${withdrawalId}
        AND ( "mode" = 'IDLE'
              OR ("mode" = 'PROVIDER_SUBMISSION_ACTIVE' AND "claimedUntil" IS NOT NULL AND "claimedUntil" < now()) )`;
    return updated > 0;
  }

  /**
   * Release the provider submission claim. `settled` marks the guard terminal
   * (SETTLED) after a successful settlement — no future claim can ever
   * succeed on a settled withdrawal.
   */
  private async releaseSubmissionGuard(tx: Prisma.TransactionClient, withdrawalId: string, settled = false): Promise<void> {
    await tx.$executeRaw`UPDATE "PayoutSettlementGuard"
      SET "mode" = ${settled ? 'SETTLED' : 'IDLE'}::"PayoutSettlementGuardMode", "claimedBy" = NULL, "claimedAt" = NULL, "claimedUntil" = NULL, "updatedAt" = now()
      WHERE "withdrawalId" = ${withdrawalId} AND "mode" = 'PROVIDER_SUBMISSION_ACTIVE'`;
  }

  /**
   * Atomically claim the MANUAL_SETTLEMENT_ACTIVE guard. Upsert-and-claim:
   * creates the guard row when the withdrawal has no payout history yet, or
   * claims it when IDLE / holding an EXPIRED provider lease (which the caller
   * has already proven safe: the in-transaction unresolved-attempt recheck
   * runs BEFORE this claim). A row held by a valid provider lease, another
   * manual settlement, or a SETTLED terminal state makes this fail closed
   * with zero rows updated. MANUAL_SETTLEMENT_ACTIVE only lives inside the
   * settlement transaction — commit sets SETTLED, rollback restores the
   * previous state. Public: the manual settlement paths in PayoutService
   * claim the guard inside their own transactions (they hold the withdrawal
   * row lock).
   */
  async claimManualSettlementGuard(tx: Prisma.TransactionClient, withdrawalId: string, claimedBy: string): Promise<boolean> {
    const updated = await tx.$executeRaw`INSERT INTO "PayoutSettlementGuard" ("id", "withdrawalId", "mode", "claimedBy", "claimedAt", "claimedUntil", "updatedAt")
      VALUES (gen_random_uuid(), ${withdrawalId}, 'MANUAL_SETTLEMENT_ACTIVE', ${claimedBy}, now(), NULL, now())
      ON CONFLICT ("withdrawalId") DO UPDATE
        SET "mode" = 'MANUAL_SETTLEMENT_ACTIVE',
            "claimedBy" = ${claimedBy},
            "claimedAt" = now(),
            "claimedUntil" = NULL,
            "updatedAt" = now()
        WHERE "PayoutSettlementGuard"."mode" = 'IDLE'
           OR ("PayoutSettlementGuard"."mode" = 'PROVIDER_SUBMISSION_ACTIVE'
               AND "PayoutSettlementGuard"."claimedUntil" IS NOT NULL
               AND "PayoutSettlementGuard"."claimedUntil" < now())`;
    return updated > 0;
  }

  /** Persist the last provider lookup outcome on the durable rows (§2.3/§7). */
  private async recordLookupOutcome(outboxId: string, attemptId: string, result: PayoutLookupResult): Promise<void> {
    const outcome = result.outcome;
    await this.prisma.payoutOutbox
      .update({ where: { id: outboxId }, data: { lastLookupOutcome: outcome, lastLookupAt: new Date() } })
      .catch(() => undefined);
    await this.prisma.payoutAttempt
      .update({ where: { id: attemptId }, data: { lastLookupOutcome: outcome, lastLookupAt: new Date() } })
      .catch(() => undefined);
    if (outcome === 'AMBIGUOUS') this.metrics.inc('ambiguousLookupOutcomes');
    if (outcome === 'ERROR') this.metrics.inc('errorLookupOutcomes');
    if (outcome === 'NOT_FOUND') this.metrics.inc('authoritativeNotFoundLookups');
    if (outcome === 'FOUND') this.metrics.inc('foundLookupsAdopted');
  }

  /**
   * Release the submission guard OUTSIDE a transaction — only valid when NO
   * provider request was made after the claim (lookup-only paths). When a
   * provider call may have happened, the guard must stay claimed until the
   * outcome is durably recorded (applyAcceptance/applySubmissionPending/
   * applyDefiniteRejection) or until the lease expires (crash recovery).
   */
  private async releaseSubmissionGuardStandalone(withdrawalId: string): Promise<void> {
    await this.prisma
      .$executeRaw`UPDATE "PayoutSettlementGuard"
        SET "mode" = 'IDLE', "claimedBy" = NULL, "claimedAt" = NULL, "claimedUntil" = NULL, "updatedAt" = now()
        WHERE "withdrawalId" = ${withdrawalId} AND "mode" = 'PROVIDER_SUBMISSION_ACTIVE'`
      .catch(() => undefined);
  }

  /** §8.3 — canonical approval snapshot hash. */
  private snapshotHash(parts: {
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
  }): string {
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
   * §8.2 — full executor separation, enforced BEFORE initiation. Returns the
   * locked approval set on success. Every combination is checked in the
   * backend; nothing relies on frontend restrictions.
   */
  private async assertExecutorSeparation(withdrawal: { id: string; requestedById: string }, executorId: string) {
    if (withdrawal.requestedById === executorId) {
      throw new ForbiddenException('Executor separation: the withdrawal requester cannot execute the payout');
    }
    return this.prisma.withdrawalApproval.findMany({
      where: { withdrawalId: withdrawal.id, status: 'ACTIVE' },
    });
  }

  /**
   * §8.2 — the COMPLETE separation + detail-binding matrix. Runs BEFORE any
   * external provider call (beneficiary resolution included). Returns the
   * first + second approval rows on success.
   */
  private assertSeparationAndBinding(
    approvals: { id: string; role: string; approverId: string; amountAtApproval: bigint; currencyAtApproval: string; destinationVersionAtApproval: number | null; snapshotHash: string | null }[],
    withdrawal: { id: string; amount: bigint; currency: string; destinationVersion: number; approvalCycle: number; requestedById: string },
    executorId: string,
  ) {
    const first = approvals.find((a) => a.role === 'FIRST_APPROVER');
    const second = approvals.find((a) => a.role === 'SECOND_APPROVER');
    if (!first || !second) {
      throw new ForbiddenException('Dual approval: an active first and second approval are required before payout execution');
    }
    // Complete separation matrix (§8.2):
    if (first.approverId === second.approverId) throw new ForbiddenException('Executor separation: the first and second approver must differ');
    if (withdrawal.requestedById === first.approverId) throw new ForbiddenException('Executor separation: the requester cannot be an approver');
    if (withdrawal.requestedById === second.approverId) throw new ForbiddenException('Executor separation: the requester cannot be an approver');
    if (executorId === first.approverId) throw new ForbiddenException('Executor separation: the payout executor cannot be the first approver');
    if (executorId === second.approverId) throw new ForbiddenException('Executor separation: the payout executor cannot be the second approver');

    // Exact detail binding (§8.3) — any change invalidates the cycle.
    const binds =
      first.amountAtApproval === withdrawal.amount &&
      first.currencyAtApproval.toUpperCase() === withdrawal.currency.toUpperCase() &&
      second.amountAtApproval === withdrawal.amount &&
      second.currencyAtApproval.toUpperCase() === withdrawal.currency.toUpperCase();
    if (!binds) {
      throw new ConflictException('Approval snapshot no longer matches the withdrawal amount/currency — reapproval required');
    }
    const destinationBound =
      first.destinationVersionAtApproval != null &&
      first.destinationVersionAtApproval === withdrawal.destinationVersion &&
      second.destinationVersionAtApproval != null &&
      second.destinationVersionAtApproval === withdrawal.destinationVersion;
    if (!destinationBound) {
      throw new ConflictException('Approval snapshot is not bound to the current destination version — the approval cycle must be restarted (v1.0.7 §8.3)');
    }
    return { first, second };
  }

  /** §8.3 — compute the initiation-time snapshot hash and verify any stored one. */
  private bindSnapshot(
    approvals: { id: string; role: string; approverId: string; amountAtApproval: bigint; currencyAtApproval: string; destinationVersionAtApproval: number | null; snapshotHash: string | null }[],
    withdrawal: { id: string; amount: bigint; currency: string; destinationVersion: number; approvalCycle: number; requestedById: string },
    provider: string,
    beneficiaryId: string,
  ) {
    const first = approvals.find((a) => a.role === 'FIRST_APPROVER');
    const second = approvals.find((a) => a.role === 'SECOND_APPROVER');
    if (!first || !second) throw new ForbiddenException('Dual approval: an active first and second approval are required before payout execution');
    const expected = this.snapshotHash({
      withdrawalId: withdrawal.id,
      amountMinor: withdrawal.amount,
      currency: withdrawal.currency,
      destinationVersion: withdrawal.destinationVersion,
      provider,
      beneficiaryId,
      requesterId: withdrawal.requestedById,
      firstApproverId: first.approverId,
      secondApproverId: second.approverId,
      cycle: withdrawal.approvalCycle,
    });
    if (first.snapshotHash && first.snapshotHash !== expected) {
      throw new ConflictException('Approval snapshot hash mismatch — approvals invalidated');
    }
    return { first, second, expected };
  }

  /**
   * THE initiation entry point. Enforces separation + snapshot binding,
   * resolves the beneficiary (provider call OUTSIDE any transaction), commits
   * the durable intent (attempt + outbox) and dispatches the submission.
   */
  async initiate(withdrawalId: string, actor: Actor, input: InitiationInput) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');

    const allowedSources: WithdrawalStatus[] = input.isRetry ? [WithdrawalStatus.FAILED] : [WithdrawalStatus.APPROVED];
    if (!allowedSources.includes(withdrawal.status)) {
      throw new ConflictException(`Payout initiation requires the withdrawal to be ${allowedSources.join('/')} (current: ${withdrawal.status})`);
    }

    // Provider gate (§6): Stripe/PayPal rejected here with explicit reasons.
    const adapter = this.registry.require(input.payoutProvider);
    const cfg = adapter.validatePayoutConfig();
    if (!cfg.ok) throw new BadRequestException(`Payout provider misconfigured: ${cfg.reason}`);

    // §4.2 preconditions 1-4: eligibility, approvals valid, amount/currency/
    // destination unchanged — the COMPLETE separation matrix runs BEFORE any
    // external provider call (beneficiary resolution included, §8.2).
    const approvals = await this.assertExecutorSeparation(withdrawal, actor.id);
    const bound = this.assertSeparationAndBinding(approvals, withdrawal, actor.id);

    // Beneficiary resolution (provider API call — deliberately OUTSIDE the
    // intent transaction; a failure aborts before any intent exists).
    const beneficiary = await this.beneficiaries.ensureBeneficiary(adapter, {
      withdrawalId,
      provider: adapter.name,
      currency: withdrawal.currency,
      method: withdrawal.method,
      destination: withdrawal.destination as Record<string, string>,
      destinationVersion: withdrawal.destinationVersion,
      createdById: actor.id,
    });

    const snapshot = this.bindSnapshot(approvals, withdrawal, adapter.name, beneficiary.id);
    void bound;

    // §4.2 precondition 7: the payout must not already be initiated.
    const unresolved = await this.prisma.payoutAttempt.findFirst({
      where: { withdrawalId, status: { in: ['INITIATED', 'SUBMISSION_PENDING', 'PROVIDER_ACCEPTED', 'PENDING', 'UNKNOWN', 'MANUAL_REVIEW'] } },
    });
    if (unresolved) {
      throw new ConflictException(
        `Attempt #${unresolved.attemptNo} is ${unresolved.status} — a new transfer cannot be initiated until the original attempt is authoritatively resolved`,
      );
    }

    const provider = adapter.name;
    const correlationId = `KPO-${withdrawal.publicRef}`;
    // Full beneficiary identity for providers that take destination fields
    // inline (Flutterwave). Derived from the SAME destination JSON the
    // beneficiary was validated against — same sensitivity class as
    // withdrawal.destination, which is already persisted.
    const dest = withdrawal.destination as Record<string, string>;
    const beneficiaryIdentity = {
      kind: withdrawal.method === 'MOBILE_MONEY' ? 'mobile_money' : 'bank',
      bankCode: dest.bankCode ?? dest.bank_code ?? '',
      accountNumber: dest.accountNumber ?? dest.account_number ?? '',
      accountName: dest.accountName ?? dest.account_name ?? '',
      mobileNumber: dest.mobileNumber ?? dest.mobile_number ?? '',
      currency: withdrawal.currency.toUpperCase(),
    };

    // §4.2 steps 8-10: persist the intent, commit, then submit.
    const attempt = await this.prisma.$transaction(async (tx) => {
      // Row-lock the authoritative withdrawal (§10 discipline).
      await tx.$queryRaw`SELECT "id" FROM "Withdrawal" WHERE "id" = ${withdrawalId} FOR UPDATE`;

      const lastAttempt = await tx.payoutAttempt.findFirst({ where: { withdrawalId }, orderBy: { attemptNo: 'desc' } });
      const attemptNo = (lastAttempt?.attemptNo ?? 0) + 1;
      const idempotencyKey = `payout:${withdrawalId}:${attemptNo}`;
      const requestFingerprint = sha256Hex(
        [
          `key=${idempotencyKey}`,
          `provider=${provider}`,
          `amount=${withdrawal.amount.toString()}`,
          `currency=${withdrawal.currency.toUpperCase()}`,
          `destV=${withdrawal.destinationVersion}`,
          `beneficiary=${beneficiary.id}`,
        ].join('|'),
      );

      // Re-validate approvals INSIDE the lock (stale-approval protection).
      const fresh = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      if (fresh.status !== withdrawal.status || fresh.amount !== withdrawal.amount || fresh.currency !== withdrawal.currency || fresh.destinationVersion !== withdrawal.destinationVersion) {
        throw new ConflictException('Withdrawal changed concurrently — initiation aborted, nothing was submitted');
      }
      // v1.0.8 §4.4 — the FULL approval-cycle matrix (all §4.3 conditions)
      // inside the lock, before the intent is committed.
      const cycle = await this.approvalCycles.validate(tx, withdrawalId, {
        executorId: actor.id,
        provider,
        beneficiaryId: beneficiary.id,
        allowedStatuses: [withdrawal.status],
        requireBoundSnapshot: false,
      });
      if (!cycle.valid) {
        throw new ConflictException(`Approval cycle invalid at intent commit: ${cycle.invalidReason}`);
      }
      const freshApprovals = await tx.withdrawalApproval.findMany({ where: { withdrawalId, status: 'ACTIVE' } });
      this.assertSeparationAndBinding(freshApprovals, fresh, actor.id);
      this.bindSnapshot(freshApprovals, fresh, provider, beneficiary.id);

      // Conditional transition APPROVED/FAILED -> PROCESSING.
      const updated = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: fresh.status },
        data: { status: WithdrawalStatus.PROCESSING },
      });
      if (updated.count === 0) throw new ConflictException('Payout state changed concurrently — initiation rejected');

      const created = await tx.payoutAttempt.create({
        data: {
          withdrawalId,
          attemptNo,
          provider,
          idempotencyKey,
          requestFingerprint,
          amount: fresh.amount,
          currency: fresh.currency,
          destinationRef: this.beneficiaries.destinationHash(fresh.destination),
          beneficiaryId: beneficiary.id,
          status: PayoutAttemptStatus.INITIATED,
          initiatedById: actor.id,
        },
      });

      const outbox = await tx.payoutOutbox.create({
        data: {
          attemptId: created.id,
          withdrawalId,
          idempotencyKey,
          status: PayoutOutboxStatus.PENDING,
          requestFingerprint,
          payload: {
            provider,
            providerReference: providerSubmissionReference(idempotencyKey),
            amountMinor: fresh.amount.toString(),
            currency: fresh.currency.toUpperCase(),
            beneficiaryId: beneficiary.id,
            beneficiaryExternalRef: beneficiary.externalRef,
            beneficiaryIdentity,
            narration: `KINDORA withdrawal ${fresh.publicRef}`,
            correlationId,
          } as Prisma.InputJsonValue,
        },
      });

      // v1.0.9 §3.2 — the durable coordination guard exists from the moment
      // the intent commits, so manual settlement and provider submission
      // arbitrate through ONE authoritative row from here on.
      await this.ensureGuardRow(tx, withdrawalId);

      // Bind the initiation snapshot hash onto both approvals (§8.3).
      await tx.withdrawalApproval.update({ where: { id: snapshot.first.id }, data: { snapshotHash: snapshot.expected } });
      await tx.withdrawalApproval.update({ where: { id: snapshot.second.id }, data: { snapshotHash: snapshot.expected } });

      await this.auditInTx(tx, actor.id, 'PAYOUT_INTENT_COMMITTED', withdrawalId, {
        attemptId: created.id,
        attemptNo,
        idempotencyKey,
        requestFingerprint,
        outboxId: outbox.id,
        provider,
        beneficiaryId: beneficiary.id,
        destinationVersion: fresh.destinationVersion,
        correlationId,
      });
      return created;
    });

    // Dispatch after commit. Without Redis the outbox sweeper picks it up.
    await this.queue.enqueue(QUEUES.PAYOUTS, 'payouts.submit-outbox', { outboxAttemptId: attempt.id }, { jobId: `outbox-${attempt.id}` });

    this.logger.warn(
      `Payout intent committed: withdrawal ${withdrawal.publicRef} attempt #${attempt.attemptNo} (${provider}, key=${attempt.idempotencyKey}, correlation=${correlationId})`,
    );
    return attempt;
  }

  /**
   * Outbox submission processor — the ONLY code path that calls the provider
   * transfer API. Idempotent, restart-safe, concurrency-safe via durable
   * conditional claims. Never resubmits on ambiguity: it looks the transfer
   * up instead (§4.3).
   */
  async submitOutbox(attemptId: string): Promise<SubmissionSummary> {
    const outbox = await this.prisma.payoutOutbox.findUnique({ where: { attemptId } });
    if (!outbox) throw new NotFoundException('Payout outbox intent not found');
    if (outbox.status === PayoutOutboxStatus.SUBMITTED) {
      return { outboxId: outbox.id, attemptId, action: 'ALREADY_SUBMITTED' };
    }
    if (outbox.status === PayoutOutboxStatus.FAILED_PERMANENT || outbox.status === PayoutOutboxStatus.EXHAUSTED) {
      return { outboxId: outbox.id, attemptId, action: 'STATE_VIOLATION', detail: `outbox is ${outbox.status}` };
    }

    // v1.0.8 §5.2 — durable claim with an EXPLICIT lease. Only one worker may
    // own a valid lease at a time (atomic conditional update). An EXPIRED
    // IN_FLIGHT lease may be reclaimed, but ONLY through the safe recovery
    // path below — a stale lease is never proof that the provider did not
    // execute the transfer, so recovery checks the provider FIRST.
    const now = new Date();
    const leaseMs = (this.config.get<number>('payouts.leaseMinutes') ?? 10) * 60_000;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const freshClaim = await this.prisma.payoutOutbox.updateMany({
      where: { id: outbox.id, status: PayoutOutboxStatus.PENDING, nextRunAt: { lte: now } },
      data: { status: PayoutOutboxStatus.IN_FLIGHT, attempts: { increment: 1 }, claimedAt: now, claimedBy: this.workerId, leaseExpiresAt: leaseExpiresAt },
    });
    let reclaimed = false;
    if (freshClaim.count === 0) {
      const staleReclaim = await this.prisma.payoutOutbox.updateMany({
        where: { id: outbox.id, status: PayoutOutboxStatus.IN_FLIGHT, leaseExpiresAt: { lte: now } },
        data: {
          attempts: { increment: 1 },
          claimedAt: now,
          claimedBy: this.workerId,
          leaseExpiresAt: leaseExpiresAt,
          recoveryAttempts: { increment: 1 },
          lastRecoveryAt: now,
        },
      });
      if (staleReclaim.count === 0) {
        return { outboxId: outbox.id, attemptId, action: 'LOOKUP_PENDING', detail: 'intent is claimed (lease valid) or not yet due' };
      }
      // An expired lease was atomically reclaimed by THIS worker. The event
      // was possibly submitted by the crashed owner — the safety gate below
      // resolves the truth from the provider before any resubmission.
      reclaimed = true;
      this.logger.warn(
        `Outbox intent ${outbox.id} recovered from an expired lease (previous owner: ${outbox.claimedBy ?? 'unknown'}, recovery #${outbox.recoveryAttempts + 1})`,
      );
    }

    const attempt = await this.prisma.payoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const withdrawal = await this.prisma.withdrawal.findUniqueOrThrow({ where: { id: attempt.withdrawalId } });
    const payload = outbox.payload as { provider: string; providerReference: string; amountMinor: string; currency: string; beneficiaryId: string; beneficiaryExternalRef: string; beneficiaryIdentity: Record<string, string>; narration: string; correlationId: string };

    try {
      const adapter = this.registry.require(payload.provider);

      // Crash recovery (§4.4): if a previous process already obtained a
      // provider identity, NEVER submit again — go to verification.
      if (attempt.providerTransferRef || attempt.providerTransferId) {
        await this.markSubmitted(attempt, outbox);
        await this.dispatchVerification(attempt.id);
        return { outboxId: outbox.id, attemptId, action: 'ALREADY_SUBMITTED', providerTransferRef: attempt.providerTransferRef ?? undefined };
      }

      // Pre-submit state re-validation (§4.2 4-7): the committed state must
      // still authorize this exact transfer. v1.0.8 §4.4: the FULL approval
      // cycle is validated here (inside the lock) — not just hash presence.
      // v1.0.9 §3.1/§3.2: the validation runs INSIDE the transaction that
      // holds the withdrawal row lock, the PERSISTED executor identity is
      // passed to the approval-cycle validator (never a worker/API-supplied
      // one), and the durable settlement guard is atomically claimed in the
      // SAME transaction — so manual settlement cannot interleave between
      // this authorization and the provider call.
      const stateCheck = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Withdrawal" WHERE "id" = ${withdrawal.id} FOR UPDATE`;
        const w = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
        if (w.status !== WithdrawalStatus.PROCESSING) return { ok: false, reason: 'STATE' as const };
        const beneficiaryRow = attempt.beneficiaryId ? await tx.payoutBeneficiary.findUnique({ where: { id: attempt.beneficiaryId } }) : null;
        if (!beneficiaryRow || beneficiaryRow.status !== 'ACTIVE') return { ok: false, reason: 'STATE' as const };
        if (w.amount !== attempt.amount || w.currency.toUpperCase() !== attempt.currency.toUpperCase() || w.destinationVersion !== beneficiaryRow.destinationVersion) {
          return { ok: false, reason: 'STATE' as const };
        }
        const a = await tx.payoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        // v1.0.9 §2.3 — SUBMISSION_PENDING is a VALID pre-check state: it is
        // the recoverable "possibly-submitted, outcome unknown" state whose
        // ONLY exit is the provider-lookup gate below (v1.0.8 required
        // INITIATED here, which left the ambiguity-resolution path dead).
        if ((a.status !== PayoutAttemptStatus.INITIATED && a.status !== PayoutAttemptStatus.SUBMISSION_PENDING) || a.requestFingerprint !== outbox.requestFingerprint) {
          return { ok: false, reason: 'STATE' as const };
        }
        const cycle = await this.approvalCycles.validate(tx, w.id, {
          // v1.0.9 §4.1 — the PERSISTED executor identity (initiatedById),
          // never an API/worker-supplied one. A missing persisted executor
          // invalidates the cycle (fail closed).
          executorId: a.initiatedById ?? null,
          requireExecutor: true,
          provider: payload.provider,
          beneficiaryId: attempt.beneficiaryId,
          beneficiaryExternalRef: beneficiaryRow.externalRef,
          requireBoundSnapshot: Boolean(attempt.beneficiaryId),
          allowedStatuses: [WithdrawalStatus.PROCESSING],
        });
        if (!cycle.valid) return { ok: false, reason: 'STATE' as const };
        // v1.0.9 §3.2 — durable coordination claim (same transaction, same
        // locks). A manual settlement in progress (or committed) blocks the
        // submission; an expired provider lease is reclaimable here ONLY
        // because the lookup-first recovery gate below has already run.
        const guardClaimed = await this.claimSubmissionGuard(tx, withdrawal.id, leaseExpiresAt, reclaimed);
        if (!guardClaimed) {
          this.metrics.inc('blockedSubmissionsByGuard');
          return { ok: false, reason: 'GUARD' as const };
        }
        return { ok: true, reason: 'OK' as const };
      });
      if (!stateCheck.ok) {
        if (stateCheck.reason === 'GUARD') {
          // Transient: a manual settlement holds the guard (or another
          // submission lease is valid). NEVER escalate, NEVER submit —
          // release the claim with backoff and let the sweeper retry.
          await this.prisma.payoutOutbox.update({
            where: { id: outbox.id },
            data: { status: PayoutOutboxStatus.PENDING, nextRunAt: this.nextRunAfter(outbox.attempts), lastError: 'settlement guard held by a competing settlement path' },
          });
          return { outboxId: outbox.id, attemptId, action: 'LOOKUP_PENDING', detail: 'settlement guard held by a competing settlement path — submission deferred' };
        }
        // The approval cycle or withdrawal state changed after the intent was
        // committed: the intent must NOT be submitted. Escalate for review.
        await this.manualReview.openCase({
          withdrawalId: withdrawal.id,
          attemptId: attempt.id,
          category: 'INTERNAL_STATE_MISMATCH',
          openedReason: 'Committed payout intent no longer matches the withdrawal/approval state — submission withheld (v1.0.7 §4.2)',
          correlationId: payload.correlationId,
        });
        await this.prisma.$transaction(async (tx) => {
          await tx.payoutAttempt.update({ where: { id: attempt.id }, data: { status: PayoutAttemptStatus.MANUAL_REVIEW, classification: 'UNKNOWN' } });
          await tx.payoutOutbox.update({ where: { id: outbox.id }, data: { status: PayoutOutboxStatus.FAILED_PERMANENT, lastError: 'state validation failed at submission time', processedAt: new Date() } });
        });
        return { outboxId: outbox.id, attemptId, action: 'STATE_VIOLATION', detail: 'intent withheld — state no longer authorizes this transfer' };
      }

      // Ambiguity resolution path (§4.3): attempt is SUBMISSION_PENDING —
      // look the transfer up instead of resubmitting. v1.0.9 §2: the lookup
      // outcome is EXPLICIT. Only an AUTHORITATIVE NOT_FOUND re-arms the same
      // durable attempt (same reference, same idempotency key). AMBIGUOUS and
      // ERROR never trigger another provider submission.
      let authoritativeNotFoundThisRun = false;
      if (attempt.status === PayoutAttemptStatus.SUBMISSION_PENDING) {
        const lookup = await adapter.findTransferByReference(payload.providerReference);
        await this.recordLookupOutcome(outbox.id, attempt.id, lookup);
        if (lookup.outcome === 'FOUND' && lookup.transfer) {
          const found = lookup.transfer;
          await this.applyAcceptance(attempt, outbox, found.providerTransferRef ?? payload.providerReference, found.providerTransferId ?? undefined, found.providerStatus ?? 'unknown', found.evidence);
          await this.dispatchVerification(attempt.id);
          return { outboxId: outbox.id, attemptId, action: 'LOOKUP_FOUND', providerTransferRef: found.providerTransferRef ?? undefined };
        }
        if (lookup.outcome === 'NOT_FOUND') {
          // v1.0.9 §2.3 — the provider authoritatively confirmed the reference
          // does not exist: the original submission provably never landed.
          // The SAME attempt is re-armed (same stable idempotency key +
          // provider reference) and the submission proceeds below — after the
          // concurrency checks already revalidated above.
          await this.prisma.$transaction(async (tx) => {
            const current = await tx.$queryRaw<{ status: PayoutAttemptStatus }[]>`SELECT "status" FROM "PayoutAttempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
            assertAttemptTransition(current[0]?.status ?? attempt.status, PayoutAttemptStatus.INITIATED);
            await tx.payoutAttempt.update({ where: { id: attempt.id }, data: { status: PayoutAttemptStatus.INITIATED, classification: null } });
            await this.auditInTx(tx, null, 'PAYOUT_SUBMISSION_REARMED_AUTHORITATIVE_NOT_FOUND', attempt.withdrawalId, {
              attemptId: attempt.id,
              providerReference: payload.providerReference,
              correlationId: payload.correlationId,
            });
          });
          attempt.status = PayoutAttemptStatus.INITIATED;
          authoritativeNotFoundThisRun = true;
          this.metrics.inc('lookupRetriesScheduled');
          // fall through to the submission path with the SAME reference
        } else {
          // AMBIGUOUS / ERROR: existence could NOT be established. Preserve
          // the reservation and the attempt, never generate a new reference,
          // never submit a second transfer. Escalate only after the configured
          // window of unresolved uncertainty; otherwise retry the LOOKUP (not
          // the submission) with backoff.
          const windowMs = (this.config.get<number>('payouts.unknownEscalationMinutes') ?? 120) * 60_000;
          const pendingForMs = Date.now() - attempt.updatedAt.getTime();
          if (pendingForMs > windowMs) {
            await this.escalateSubmissionPending(attempt, outbox, payload.correlationId, `submission uncertainty exceeded the configured resolution window (last lookup: ${lookup.outcome}: ${lookup.reason ?? 'unclassified'})`);
            return { outboxId: outbox.id, attemptId, action: 'STATE_VIOLATION', detail: 'escalated to manual review' };
          }
          await this.prisma.payoutOutbox.update({
            where: { id: outbox.id },
            data: {
              status: PayoutOutboxStatus.PENDING,
              nextRunAt: this.nextRunAfter(outbox.attempts),
              lastError: `provider lookup ${lookup.outcome}: ${(lookup.reason ?? 'unclassified').slice(0, 200)}`,
            },
          });
          this.metrics.inc('lookupRetriesScheduled');
          await this.releaseSubmissionGuardStandalone(withdrawal.id);
          return { outboxId: outbox.id, attemptId, action: 'LOOKUP_BLOCKED', detail: `lookup ${lookup.outcome} — resubmission forbidden` };
        }
      }

      // v1.0.8 §5.3, hardened v1.0.9 §2/§7 — SAFE stale-lease recovery gate.
      // A stale lease is NOT proof that the external provider did not execute
      // the transfer. Before ANY submission when the event was reclaimed (or
      // previously claimed), the deterministic submission reference is
      // resolved against the provider with an EXPLICIT outcome:
      //   FOUND      -> adopt the existing transfer (never submit again)
      //   NOT_FOUND  -> authoritative non-existence — safe to submit
      //   AMBIGUOUS / ERROR -> the claim is released with backoff, the lookup
      //                        outcome is persisted, and NO submission happens
      if ((reclaimed || outbox.attempts > 1) && !authoritativeNotFoundThisRun) {
        const prior = await adapter.findTransferByReference(payload.providerReference);
        await this.recordLookupOutcome(outbox.id, attempt.id, prior);
        if (prior.outcome === 'FOUND' && prior.transfer) {
          await this.applyAcceptance(attempt, outbox, prior.transfer.providerTransferRef ?? payload.providerReference, prior.transfer.providerTransferId ?? undefined, prior.transfer.providerStatus ?? 'unknown', prior.transfer.evidence);
          await this.dispatchVerification(attempt.id);
          return { outboxId: outbox.id, attemptId, action: 'LOOKUP_FOUND', providerTransferRef: prior.transfer.providerTransferRef ?? undefined };
        }
        if (prior.outcome !== 'NOT_FOUND') {
          // AMBIGUOUS / ERROR: existence NOT established — releasing the
          // claim with backoff and scheduling a controlled lookup retry.
          // Never a second transfer, never a reservation release.
          await this.prisma.payoutOutbox.update({
            where: { id: outbox.id },
            data: {
              status: PayoutOutboxStatus.PENDING,
              nextRunAt: this.nextRunAfter(outbox.attempts),
              lastError: `recovery lookup ${prior.outcome}: ${(prior.reason ?? 'unclassified').slice(0, 200)}`,
            },
          });
          this.metrics.inc('lookupRetriesScheduled');
          await this.releaseSubmissionGuardStandalone(withdrawal.id);
          return { outboxId: outbox.id, attemptId, action: 'LOOKUP_BLOCKED', detail: `recovery lookup ${prior.outcome} — resubmission forbidden` };
        }
      }

      // THE provider call (no DB transaction is open here — §4.2).
      let result;
      try {
        result = await adapter.initiateTransfer({
          idempotencyKey: attempt.idempotencyKey,
          providerReference: payload.providerReference,
          amountMinor: attempt.amount,
          currency: attempt.currency,
          beneficiaryExternalRef: payload.beneficiaryExternalRef,
          beneficiaryIdentity: payload.beneficiaryIdentity ?? {},
          narration: payload.narration,
        });
      } catch (err) {
        if (err instanceof PayoutProviderRejectedError) {
          // Definite rejection: no transfer was created (authoritative 4xx).
          await this.applyDefiniteRejection(attempt, outbox, err.message, payload.correlationId);
          return { outboxId: outbox.id, attemptId, action: 'REJECTED', detail: err.message };
        }
        if (err instanceof PayoutTransportError) {
          // AMBIGUOUS: the transfer MAY exist. Never blind-retry.
          await this.applySubmissionPending(attempt, outbox, err.message, payload.correlationId);
          return { outboxId: outbox.id, attemptId, action: 'AMBIGUOUS', detail: err.message };
        }
        throw err;
      }

      await this.applyAcceptance(attempt, outbox, result.providerTransferRef, result.providerTransferId, result.providerStatus, result.evidence);
      await this.dispatchVerification(attempt.id);
      return { outboxId: outbox.id, attemptId, action: 'SUBMITTED', providerTransferRef: result.providerTransferRef };
    } catch (err) {
      // Unexpected failure (DB, config): release the claim back to PENDING
      // with backoff — the intent is durable and will be retried safely.
      await this.prisma.payoutOutbox.update({
        where: { id: outbox.id },
        data: { status: PayoutOutboxStatus.PENDING, nextRunAt: this.nextRunAfter(outbox.attempts), lastError: (err as Error).message.slice(0, 300) },
      }).catch(() => undefined);
      throw err;
    }
  }

  private nextRunAfter(attemptsSoFar: number): Date {
    // Bounded exponential backoff with jitter (§12): 30s * 2^n, max 15min.
    const base = Math.min(30_000 * Math.pow(2, Math.max(0, attemptsSoFar - 1)), 15 * 60_000);
    const jitter = Math.floor(Math.random() * base * 0.3);
    return new Date(Date.now() + base + jitter);
  }

  private async markSubmitted(attempt: { id: string }, outbox: { id: string }) {
    await this.prisma.$transaction(async (tx) => {
      await tx.payoutOutbox.update({ where: { id: outbox.id }, data: { status: PayoutOutboxStatus.SUBMITTED, submittedAt: new Date(), processedAt: new Date() } });
      const current = await tx.payoutAttempt.findUnique({ where: { id: attempt.id }, select: { status: true } });
      if (current?.status === PayoutAttemptStatus.INITIATED) {
        await tx.payoutAttempt.update({ where: { id: attempt.id }, data: { status: PayoutAttemptStatus.PROVIDER_ACCEPTED } });
      }
    });
  }

  private async applyAcceptance(
    attempt: { id: string; withdrawalId: string; status: PayoutAttemptStatus },
    outbox: { id: string; attempts: number },
    providerTransferRef: string,
    providerTransferId: string | undefined,
    providerStatus: string | undefined,
    evidence: Record<string, unknown>,
  ) {
    const target = ['pending', 'otp', 'processing', 'queued', 'new', 'in_progress'].includes((providerStatus ?? '').toLowerCase())
      ? PayoutAttemptStatus.PENDING
      : PayoutAttemptStatus.PROVIDER_ACCEPTED;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<{ status: PayoutAttemptStatus }[]>`SELECT "status" FROM "PayoutAttempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
      const from = current[0]?.status ?? attempt.status;
      assertAttemptTransition(from, target);
      await tx.payoutAttempt.update({
        where: { id: attempt.id },
        data: {
          status: target,
          providerTransferRef,
          providerTransferId: providerTransferId ?? null,
          providerStatus: providerStatus ?? null,
          classification: 'PENDING',
        },
      });
      await tx.payoutOutbox.update({ where: { id: outbox.id }, data: { status: PayoutOutboxStatus.SUBMITTED, submittedAt: new Date(), processedAt: new Date(), lastError: null } });
      // v1.0.9 §3.2 — the submission is durably recorded: release the guard.
      // The attempt is now PROVIDER_ACCEPTED/PENDING (unresolved), which keeps
      // manual settlement blocked through the in-transaction recheck.
      await this.releaseSubmissionGuard(tx, attempt.withdrawalId);
      await this.auditInTx(tx, null, 'PAYOUT_TRANSFER_ACCEPTED', attempt.withdrawalId, {
        attemptId: attempt.id,
        providerTransferRef,
        providerTransferId: providerTransferId ?? null,
        providerStatus: providerStatus ?? null,
        evidence,
      });
    });
    this.logger.warn(`Provider accepted payout transfer ${providerTransferRef} for attempt ${attempt.id}`);
  }

  private async applySubmissionPending(
    attempt: { id: string; withdrawalId: string; status: PayoutAttemptStatus },
    outbox: { id: string; attempts: number },
    reason: string,
    correlationId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<{ status: PayoutAttemptStatus }[]>`SELECT "status" FROM "PayoutAttempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
      const from = current[0]?.status ?? attempt.status;
      assertAttemptTransition(from, PayoutAttemptStatus.SUBMISSION_PENDING);
      await tx.payoutAttempt.update({
        where: { id: attempt.id },
        data: { status: PayoutAttemptStatus.SUBMISSION_PENDING, classification: 'UNKNOWN', providerStatus: 'SUBMISSION_UNKNOWN' },
      });
      await tx.payoutOutbox.update({
        where: { id: outbox.id },
        data: { status: PayoutOutboxStatus.PENDING, nextRunAt: this.nextRunAfter(outbox.attempts), lastError: reason.slice(0, 300) },
      });
      // v1.0.9 §3.2 — AMBIGUOUS outcome recorded durably: release the guard.
      // The attempt is SUBMISSION_PENDING (unresolved) — manual settlement
      // stays blocked through the in-transaction recheck until the outcome is
      // authoritatively resolved; a controlled LOOKUP retry is scheduled.
      await this.releaseSubmissionGuard(tx, attempt.withdrawalId);
      await this.auditInTx(tx, null, 'PAYOUT_SUBMISSION_AMBIGUOUS', attempt.withdrawalId, { attemptId: attempt.id, reason, correlationId });
    });
    this.logger.warn(`Payout submission AMBIGUOUS for attempt ${attempt.id}: ${reason} — provider lookup scheduled, no resubmission`);
  }

  private async escalateSubmissionPending(
    attempt: { id: string; withdrawalId: string },
    outbox: { id: string },
    correlationId: string,
    reason: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.payoutAttempt.update({ where: { id: attempt.id }, data: { status: PayoutAttemptStatus.MANUAL_REVIEW, classification: 'UNKNOWN' } });
      await tx.payoutOutbox.update({ where: { id: outbox.id }, data: { status: PayoutOutboxStatus.EXHAUSTED, lastError: reason.slice(0, 300), processedAt: new Date() } });
      // v1.0.9 §3.2 — MANUAL_REVIEW is an unresolved state: the attempt itself
      // keeps both settlement paths blocked; the guard returns to IDLE.
      await this.releaseSubmissionGuard(tx, attempt.withdrawalId);
      await this.auditInTx(tx, null, 'PAYOUT_SUBMISSION_ESCALATED', attempt.withdrawalId, { attemptId: attempt.id, reason, correlationId });
    });
    await this.manualReview.openCase({
      withdrawalId: attempt.withdrawalId,
      attemptId: attempt.id,
      category: 'PROVIDER_UNKNOWN',
      openedReason: `Submission unresolved beyond the configured window: ${reason}`,
      correlationId,
    });
  }

  private async applyDefiniteRejection(
    attempt: { id: string; withdrawalId: string; status: PayoutAttemptStatus },
    outbox: { id: string; requestFingerprint: string },
    reason: string,
    correlationId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // v1.0.8 §9.2 — lock the payout attempt and confirm the association:
      // the attempt belongs to this withdrawal and carries THIS submission's
      // fingerprint. Any mismatch aborts before a single row is mutated.
      const current = await tx.$queryRaw<{ id: string; status: PayoutAttemptStatus; withdrawalId: string; requestFingerprint: string | null }[]>`SELECT "id", "status", "withdrawalId", "requestFingerprint" FROM "PayoutAttempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
      const locked = current[0];
      if (!locked) throw new ConflictException('Definite rejection aborted: payout attempt not found');
      if (locked.withdrawalId !== attempt.withdrawalId) {
        throw new ConflictException('Definite rejection aborted: attempt does not belong to this withdrawal');
      }
      if (locked.requestFingerprint && locked.requestFingerprint !== outbox.requestFingerprint) {
        throw new ConflictException('Definite rejection aborted: attempt fingerprint does not match this provider submission');
      }
      const from = locked.status;
      assertAttemptTransition(from, PayoutAttemptStatus.FAILED);
      await tx.payoutAttempt.update({
        where: { id: attempt.id },
        data: { status: PayoutAttemptStatus.FAILED, classification: 'FAILED', failureReason: `Provider rejected transfer initiation: ${reason}`.slice(0, 500), resolvedAt: new Date() },
      });
      await tx.payoutOutbox.update({ where: { id: outbox.id }, data: { status: PayoutOutboxStatus.FAILED_PERMANENT, lastError: reason.slice(0, 300), processedAt: new Date() } });
      // v1.0.9 §3.2 — definite rejection committed atomically: release the
      // guard (FAILED attempt + FAILED withdrawal block both settlement paths
      // until the authorized retry path runs).
      await this.releaseSubmissionGuard(tx, attempt.withdrawalId);
      const updated = await tx.withdrawal.updateMany({
        where: { id: attempt.withdrawalId, status: WithdrawalStatus.PROCESSING },
        data: { status: WithdrawalStatus.FAILED, failureReason: `Provider rejected payout initiation: ${reason}`.slice(0, 500) },
      });
      if (updated.count === 0) {
        // v1.0.8 §9.2 — a zero-row conditional update is a HARD transaction
        // error: abort EVERYTHING (attempt, outbox, audit). The v1.0.7
        // behavior of committing a FAILED attempt beside a non-FAILED
        // withdrawal produced exactly the inconsistent state this fix removes.
        // Concurrent reconciliation/verification may have already moved the
        // withdrawal; re-running the pipeline resolves it safely.
        throw new ConflictException(
          'Definite rejection aborted: the withdrawal is no longer PROCESSING (concurrent authoritative state change) — nothing was committed',
        );
      }
      await this.auditInTx(tx, null, 'PAYOUT_INITIATION_REJECTED', attempt.withdrawalId, { attemptId: attempt.id, reason, correlationId });
    });
  }

  /** Schedule authoritative verification (queue optional — sweeper covers). */
  private async dispatchVerification(attemptId: string, delayMs = 5_000) {
    await this.queue.enqueue(QUEUES.PAYOUTS, 'payouts.verify-attempt', { attemptId }, { delayMs, jobId: `verify-${attemptId}` }).catch(() => undefined);
  }

  /**
   * Recovery sweep (§4.4): due outbox intents are resubmitted through the
   * safe path; stale SUBMISSION_PENDING/UNKNOWN attempts escalate; accepted
   * transfers without verification get a verification pass.
   */
  async recoverySweep(): Promise<{ claimed: number; escalated: number; verified: number }> {
    const now = new Date();
    const due = await this.prisma.payoutOutbox.findMany({
      where: { status: { in: [PayoutOutboxStatus.PENDING, PayoutOutboxStatus.IN_FLIGHT] }, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: 25,
    });
    let claimed = 0;
    for (const o of due) {
      try {
        const summary = await this.submitOutbox(o.attemptId);
        if (['SUBMITTED', 'ACCEPTED', 'LOOKUP_FOUND'].includes(summary.action)) claimed++;
      } catch (err) {
        this.logger.warn(`Outbox sweep failed for attempt ${o.attemptId}: ${(err as Error).message}`);
      }
    }

    // Verification pass for accepted/pending transfers that have not been
    // verified within the window.
    const verifyWindow = new Date(Date.now() - 5 * 60_000);
    const needingVerification = await this.prisma.payoutAttempt.findMany({
      where: {
        status: { in: [PayoutAttemptStatus.PROVIDER_ACCEPTED, PayoutAttemptStatus.PENDING] },
        OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: verifyWindow } }],
      },
      take: 25,
      orderBy: { createdAt: 'asc' },
    });
    let verified = 0;
    for (const a of needingVerification) {
      try {
        await this.queue.enqueue(QUEUES.PAYOUTS, 'payouts.verify-attempt', { attemptId: a.id }, { jobId: `verify-${a.id}` }).catch(() => undefined);
        verified++;
      } catch {
        // sweeper re-picks these up
      }
    }

    const escalated = await this.manualReview.escalateStaleUnknowns();
    return { claimed, escalated, verified };
  }
}
