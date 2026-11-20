import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PayoutAttemptStatus, Prisma, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { sha256Hex } from '../common/utils/crypto.util';
import { assertAttemptTransition } from './payout-state-machine';

export type Actor = { id: string; role: string };

export interface OpenCaseInput {
  withdrawalId: string;
  attemptId?: string;
  category: string;
  openedReason: string;
  evidence?: Record<string, unknown>;
  correlationId?: string;
}

export type ResolveCaseResolution =
  | 'RETURN_TO_VERIFICATION'
  | 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE'
  | 'RECORD_REVERSAL_DECISION'
  | 'NO_INTERNAL_CHANGE';

export interface ResolveCaseInput {
  resolution: ResolveCaseResolution;
  note: string;
  evidenceFileId?: string;
  /** Independent reviewer (ADMIN) — required for CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE. */
  reviewerId?: string;
}

/**
 * KINDORA v1.0.7 §9 — controlled manual review workflow.
 *
 * Manual intervention NEVER becomes a shortcut around provider verification:
 *  - A case is opened automatically whenever reconciliation fails closed
 *    (mismatch, incomplete evidence, unknown outcome, reversal, stuck intent).
 *  - Resolution is permission-protected, requires FRESH purpose-bound MFA
 *    (controller), a recorded reason, immutable evidence and an audit event.
 *  - `CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE` does NOT settle the payout. It
 *    only moves the attempt into MANUAL_REVIEW-resolved verification queue
 *    with the evidence bound; the withdrawal remains REQUIRES_RECONCILIATION
 *    and settlement still requires authoritative provider verification or the
 *    separate manual-settlement path (evidence file + dual approval + MFA).
 *    An administrator cannot declare an unverified transfer successful merely
 *    by entering a reference.
 *  - Cases, like all financial audit records, are never deleted (DB trigger).
 */
@Injectable()
export class ManualReviewService {
  private readonly logger = new Logger(ManualReviewService.name);

  constructor(private readonly prisma: PrismaService) {}

  async openCase(input: OpenCaseInput) {
    const category = input.category as Prisma.EnumManualReviewCategoryFilter['equals'];
    return this.prisma.manualReviewCase.create({
      data: {
        withdrawalId: input.withdrawalId,
        attemptId: input.attemptId,
        category: category as never,
        openedReason: input.openedReason.slice(0, 1000),
        evidence: input.evidence ? (input.evidence as Prisma.InputJsonValue) : Prisma.JsonNull,
        correlationId: input.correlationId,
      },
    });
  }

  list(status: 'OPEN' | 'RESOLVED' | undefined, skip = 0, limit = 50) {
    return this.prisma.$transaction([
      this.prisma.manualReviewCase.count({ where: status ? { status } : {} }),
      this.prisma.manualReviewCase.findMany({
        where: status ? { status } : {},
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { attempt: { select: { id: true, attemptNo: true, provider: true, status: true, providerTransferRef: true } } },
      }),
    ]);
  }

  getCase(id: string) {
    return this.prisma.manualReviewCase.findUnique({
      where: { id },
      include: { attempt: true, withdrawal: { select: { id: true, publicRef: true, status: true, amount: true, currency: true } } },
    });
  }

  /**
   * Resolve an OPEN case. Fresh MFA (PAYOUT_MANUAL_REVIEW) is enforced by the
   * controller; the caller must be ADMIN. Independent-reviewer binding is
   * required for success-confirmations (two distinct administrators).
   */
  async resolveCase(caseId: string, admin: Actor, input: ResolveCaseInput, mfaPurposeUsed: string) {
    const kase = await this.prisma.manualReviewCase.findUnique({ where: { id: caseId }, include: { attempt: true } });
    if (!kase) throw new NotFoundException('Manual review case not found');
    if (kase.status === 'RESOLVED') throw new ConflictException('Case is already resolved');
    if (input.resolution === 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE') {
      if (!input.evidenceFileId) {
        throw new BadRequestException('Confirming provider success requires a registered private evidence file');
      }
      if (!input.reviewerId || input.reviewerId === admin.id) {
        throw new BadRequestException('Confirming provider success requires an independent reviewer (a second, different administrator)');
      }
      const reviewer = await this.prisma.user.findUnique({ where: { id: input.reviewerId } });
      if (!reviewer || reviewer.role !== 'ADMIN') throw new BadRequestException('Reviewer must be an administrator');
    }

    const evidenceHash = input.evidenceFileId ? sha256Hex(`${kase.id}:${input.evidenceFileId}:${input.note}`) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.manualReviewCase.update({
        where: { id: caseId, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolution: input.resolution,
          resolutionNote: input.note.slice(0, 1000),
          resolvedById: admin.id,
          reviewerId: input.reviewerId ?? null,
          mfaPurposeUsed,
          evidence: {
            ...(input.evidenceFileId ? { evidenceFileId: input.evidenceFileId, evidenceHash } : {}),
            resolutionAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: admin.id,
          action: 'MANUAL_REVIEW_CASE_RESOLVED',
          entityType: 'WITHDRAWAL',
          entityId: kase.withdrawalId,
          metadata: {
            caseId,
            category: kase.category,
            resolution: input.resolution,
            reviewerId: input.reviewerId ?? null,
            mfaPurposeUsed,
            attemptId: kase.attemptId,
          },
        },
      });
      return row;
    });

    // Attempt state follow-ups — always fail-closed, never direct settlement.
    if (kase.attempt) {
      const attempt = kase.attempt;
      if (input.resolution === 'RETURN_TO_VERIFICATION' && attempt.status === PayoutAttemptStatus.MANUAL_REVIEW) {
        assertAttemptTransition(PayoutAttemptStatus.MANUAL_REVIEW, PayoutAttemptStatus.UNKNOWN);
        await this.prisma.payoutAttempt.update({
          where: { id: attempt.id },
          data: { status: PayoutAttemptStatus.UNKNOWN, classification: 'UNKNOWN' },
        });
      } else if (input.resolution === 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE') {
        // Evidence-backed confirmation: the attempt enters MANUAL_REVIEW with
        // the case bound as evidence. Settlement STILL requires either
        // authoritative provider verification or the manual-settlement path
        // (separate approval + MFA + evidence) — this resolution only unblocks
        // the human workflow with a recorded independent review.
        if (attempt.status !== PayoutAttemptStatus.SUCCESSFUL) {
          assertAttemptTransition(attempt.status, PayoutAttemptStatus.MANUAL_REVIEW);
          await this.prisma.payoutAttempt.update({
            where: { id: attempt.id },
            data: { status: PayoutAttemptStatus.MANUAL_REVIEW, classification: 'MANUAL_CONFIRMED_WITH_EVIDENCE' },
          });
        }
      } else if (input.resolution === 'RECORD_REVERSAL_DECISION') {
        await this.prisma.auditLog.create({
          data: {
            actorUserId: admin.id,
            action: 'PAYOUT_REVERSAL_DECISION_RECORDED',
            entityType: 'WITHDRAWAL',
            entityId: kase.withdrawalId,
            metadata: { caseId, attemptId: attempt.id, note: input.note.slice(0, 500) },
          },
        });
      }
      // NO_INTERNAL_CHANGE: only the case is closed; attempt + withdrawal untouched.
    }

    // Withdrawal state: confirm-success resolution keeps REQUIRES_RECONCILIATION
    // (settlement still gated); other resolutions leave the status untouched.
    if (input.resolution === 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE') {
      const w = await this.prisma.withdrawal.findUnique({ where: { id: kase.withdrawalId } });
      if (w && w.status === WithdrawalStatus.PROCESSING) {
        await this.prisma.withdrawal.updateMany({
          where: { id: w.id, status: WithdrawalStatus.PROCESSING },
          data: { status: WithdrawalStatus.REQUIRES_RECONCILIATION },
        });
      }
    }

    this.logger.warn(`Manual review case ${caseId} resolved (${input.resolution}) by ${admin.id}`);
    return updated;
  }

  /**
   * Escalation sweep (§7.4/§12): attempts stuck UNKNOWN / SUBMISSION_PENDING
   * beyond the configured window get MANUAL_REVIEW + an OPEN case (once).
   * Called from the recovery sweep and the worker cron.
   */
  async escalateStaleUnknowns(): Promise<number> {
    const windowMs = Number(process.env.PAYOUT_UNKNOWN_ESCALATION_MINUTES ?? 120) * 60_000;
    const cutoff = new Date(Date.now() - windowMs);
    const stale = await this.prisma.payoutAttempt.findMany({
      where: { status: { in: [PayoutAttemptStatus.UNKNOWN, PayoutAttemptStatus.SUBMISSION_PENDING] }, updatedAt: { lt: cutoff } },
      take: 50,
      orderBy: { updatedAt: 'asc' },
    });
    let escalated = 0;
    for (const attempt of stale) {
      const openCase = await this.prisma.manualReviewCase.findFirst({ where: { attemptId: attempt.id, status: 'OPEN' } });
      if (openCase) continue;
      try {
        await this.prisma.$transaction(async (tx) => {
          assertAttemptTransition(attempt.status, PayoutAttemptStatus.MANUAL_REVIEW);
          await tx.payoutAttempt.update({ where: { id: attempt.id }, data: { status: PayoutAttemptStatus.MANUAL_REVIEW } });
          await tx.manualReviewCase.create({
            data: {
              withdrawalId: attempt.withdrawalId,
              attemptId: attempt.id,
              category: 'PROVIDER_UNKNOWN',
              openedReason: `Attempt unresolved in state ${attempt.status} beyond the ${windowMs / 60_000}min escalation window`,
            },
          });
        });
        escalated++;
      } catch (err) {
        this.logger.warn(`Escalation skipped for attempt ${attempt.id}: ${(err as Error).message}`);
      }
    }
    return escalated;
  }

  /** Guard used by controllers: only ADMIN may act on manual review cases. */
  assertAdmin(actor: Actor) {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('Manual review resolution requires an administrator');
  }
}
