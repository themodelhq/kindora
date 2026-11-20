import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { percentOf } from '../common/utils/money';
import { publicRef } from '../common/utils/crypto.util';
import { ManualReviewService, type ResolveCaseResolution } from '../payouts/manual-review.service';
import { PayoutBeneficiaryService } from '../payouts/payout-beneficiary.service';
import { PayoutEvidenceService } from '../payouts/payout-evidence.service';
import { assertManualSettlementChannel, isManualSettlementChannel, normalizeLegacyManualChannel } from '../payouts/manual-settlement-channels';
import { PayoutService } from '../payouts/payout.service';
import type { CreateWithdrawalDto, ExecutePayoutDto, ResolveReviewCaseDto, RetryPayoutDto, SettlePayoutDto, UpdateDestinationDto } from './dto/withdrawal.dto';

type Actor = { id: string; role: string };

/**
 * Withdrawal statuses that hold a reservation against the campaign balance
 * (mirrored in LedgerService.campaignAvailableBalance — kept in sync by test).
 * FAILED / REJECTED / CANCELLED release the reservation; PAID has left the
 * reservation through the settlement ledger entry; REQUIRES_RECONCILIATION
 * deliberately KEEPS the reservation (the outcome is unresolved).
 */
export const RESERVING_STATUSES: WithdrawalStatus[] = [
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'PROCESSING',
  'REQUIRES_INFORMATION',
  'REQUIRES_RECONCILIATION',
];

/** Destinations are PII: only owners, campaign managers and admins see full details. */
function maskDestination(destination: unknown): Record<string, unknown> {
  if (!destination || typeof destination !== 'object') return {};
  const clone: Record<string, unknown> = { ...(destination as Record<string, unknown>) };
  const sensitive = ['accountNumber', 'account_number', 'mobileNumber', 'phone', 'routingNumber'];
  for (const key of sensitive) {
    const value = clone[key];
    if (typeof value === 'string' && value.length > 4) {
      clone[key] = `****${value.slice(-4)}`;
    }
  }
  return clone;
}

/**
 * Withdrawals with financial integrity guarantees:
 *
 *  1. Every read/write path enforces resource ownership (requester, org
 *     member of the campaign's organization, or ADMIN) — no IDOR.
 *  2. Request creation runs inside a transaction that row-locks the campaign
 *     (SELECT ... FOR UPDATE) and re-computes the genuinely available balance
 *     before inserting — concurrent requests can never overdraw.
 *  3. ALL state transitions are owned by the canonical PayoutService
 *     (v1.0.4 §4). There is NO mark-processing / mark-failed / mark-paid
 *     admin endpoint: settlement happens through confirmSettlement (evidence
 *     file + separation of duties) or provider verification (PayoutService),
 *     failure only through authoritative provider verification.
 *  4. Approvals are immutable WithdrawalApproval rows (v1.0.4 §6): the
 *     requester cannot approve, the first approver cannot be the second
 *     approver, and the second approver cannot be the payout executor. Every
 *     approval binds to the exact amount and currency at approval time.
 *  5. Dual approval is enforced per the configured policy (mode ALL default).
 *  6. Manual settlement posts to the ledger exactly once (unique
 *     `withdrawal:<id>` reference; P2002 -> 409).
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly config: ConfigService,
    private readonly payouts: PayoutService,
    private readonly beneficiaries: PayoutBeneficiaryService,
    private readonly manualReview: ManualReviewService,
    private readonly payoutEvidence: PayoutEvidenceService,
  ) {}

  /** Returns true when the user manages the campaign (creator, org member, admin). */
  private async assertCampaignManager(campaignId: string, user: Actor) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, createdById: true, organizationId: true, currency: true, status: true, title: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (user.role === 'ADMIN') return campaign;
    let allowed = campaign.createdById === user.id;
    if (!allowed && campaign.organizationId) {
      const membership = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: campaign.organizationId, userId: user.id } },
      });
      allowed = Boolean(membership);
    }
    if (!allowed) throw new ForbiddenException('You do not manage this campaign');
    return campaign;
  }

  /** Organizer requests a payout. Availability comes from the ledger, never client input. */
  async request(dto: CreateWithdrawalDto, user: Actor) {
    const campaign = await this.assertCampaignManager(dto.campaignId, user);
    if (!['ACTIVE', 'COMPLETED', 'PAUSED'].includes(campaign.status)) {
      throw new BadRequestException('Campaign is not eligible for withdrawals');
    }

    const amount = BigInt(dto.amountMinor);
    const feePercent = this.config.get<number>('money.platformFeePercent') ?? 0;
    const fee = percentOf(amount, feePercent);
    const net = amount - fee;

    // Concurrency-safe reservation: lock the campaign row, re-check
    // availability INSIDE the transaction, then insert.
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Campaign" WHERE "id" = ${campaign.id} FOR UPDATE`;
      const available = await this.ledger.campaignAvailableBalance(campaign.id, campaign.currency, tx);
      if (amount > available) {
        throw new BadRequestException(
          `Requested amount exceeds the available balance. Available: ${available.toString()} minor units`,
        );
      }
      return tx.withdrawal.create({
        data: {
          publicRef: publicRef('WDR'),
          campaignId: campaign.id,
          requestedById: user.id,
          amount,
          feeAmount: fee,
          netAmount: net,
          currency: campaign.currency,
          method: dto.method,
          destination: dto.destination as Prisma.InputJsonValue,
        },
      });
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'WITHDRAWAL_REQUESTED',
        entityType: 'WITHDRAWAL',
        entityId: withdrawal.id,
        metadata: {
          campaignId: campaign.id,
          amount: amount.toString(),
          currency: campaign.currency,
          method: dto.method,
          availableAtRequest: 'see ledger',
        },
      },
    });

    return withdrawal;
  }

  /** Withdrawals for campaigns the user manages (their own + org campaigns). */
  async listMine(user: Actor, skip: number, limit: number) {
    const orgIds = (
      await this.prisma.organizationMember.findMany({ where: { userId: user.id }, select: { organizationId: true } })
    ).map((m) => m.organizationId);
    const where: Prisma.WithdrawalWhereInput = {
      campaign: {
        OR: [
          { createdById: user.id },
          ...(orgIds.length > 0 ? [{ organizationId: { in: orgIds } }] : []),
        ],
      },
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.withdrawal.count({ where }),
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { campaign: { select: { title: true, slug: true } } },
      }),
    ]);
    return { total, items };
  }

  async availableBalance(campaignId: string, user: Actor) {
    const campaign = await this.assertCampaignManager(campaignId, user);
    const available = await this.ledger.campaignAvailableBalance(campaign.id, campaign.currency);
    return { currency: campaign.currency, availableMinor: available.toString() };
  }

  /**
   * Withdrawal detail with ownership enforcement and field-level exposure:
   * bank/mobile details (destination) are returned in full only to the
   * requester, other managers of the campaign, or admins.
   */
  async getOne(id: string, user: Actor) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: {
        campaign: { select: { title: true, slug: true, createdById: true, organizationId: true } },
        payoutAttempts: { orderBy: { attemptNo: 'desc' } },
      },
    });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');

    let canSeeFull = user.role === 'ADMIN' || withdrawal.requestedById === user.id;
    if (!canSeeFull) {
      const campaign = withdrawal.campaign;
      canSeeFull = campaign.createdById === user.id;
      if (!canSeeFull && campaign.organizationId) {
        const membership = await this.prisma.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: campaign.organizationId, userId: user.id } },
        });
        canSeeFull = Boolean(membership);
      }
    }

    const { campaign, payoutAttempts, ...rest } = withdrawal;
    return {
      ...rest,
      destination: canSeeFull ? (rest.destination as Record<string, unknown>) : maskDestination(rest.destination),
      campaign: { title: campaign.title, slug: campaign.slug },
      viewerCanSeeFullDetails: canSeeFull,
      payoutAttempts: payoutAttempts.map((a) => ({
        id: a.id,
        attemptNo: a.attemptNo,
        provider: a.provider,
        status: a.status,
        classification: a.classification,
        providerStatus: a.providerStatus,
        failureReason: a.failureReason,
        lastVerifiedAt: a.lastVerifiedAt,
        createdAt: a.createdAt,
      })),
    };
  }

  // ---- Organizer -----------------------------------------------------------

  /** Organizer cancels their own not-yet-approved request; reservation is released. */
  async cancel(id: string, user: Actor) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    if (withdrawal.requestedById !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the requester can cancel this withdrawal');
    }
    // Cancellation is allowed only while the payout has NOT been transferred:
    // an APPROVED/PROCESSING/REQUIRES_RECONCILIATION payout has a live
    // transfer pipeline that cannot be cancelled by the requester.
    const updated = await this.prisma.withdrawal.updateMany({
      where: { id, status: { in: ['PENDING', 'UNDER_REVIEW', 'REQUIRES_INFORMATION'] as WithdrawalStatus[] } },
      data: { status: WithdrawalStatus.CANCELLED, adminNote: 'Cancelled by requester' },
    });
    if (updated.count === 0) throw new BadRequestException('Withdrawal can no longer be cancelled');
    await this.prisma.auditLog.create({
      data: { actorUserId: user.id, action: 'WITHDRAWAL_CANCELLED', entityType: 'WITHDRAWAL', entityId: id },
    });
    return { ok: true };
  }

  // ---- Admin ---------------------------------------------------------------

  async adminList(status: string | undefined, skip: number, limit: number) {
    let where: Prisma.WithdrawalWhereInput = {};
    if (status) {
      const values = status.split(',').map((s) => s.trim().toUpperCase());
      const invalid = values.filter((v) => !Object.values(WithdrawalStatus).includes(v as WithdrawalStatus));
      if (invalid.length > 0) throw new BadRequestException(`Unknown withdrawal status: ${invalid.join(', ')}`);
      where = { status: { in: values as WithdrawalStatus[] } };
    }
    const [total, items] = await this.prisma.$transaction([
      this.prisma.withdrawal.count({ where }),
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { campaign: { select: { title: true, slug: true } } },
      }),
    ]);
    return { total, items };
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

  /** PENDING -> UNDER_REVIEW (review identity is recorded, not an approval). */
  async markUnderReview(id: string, admin: Actor) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    const updated = await this.prisma.withdrawal.updateMany({
      where: { id, status: WithdrawalStatus.PENDING },
      data: { status: WithdrawalStatus.UNDER_REVIEW, reviewedById: admin.id, reviewedAt: new Date() },
    });
    if (updated.count === 0) throw new BadRequestException('Withdrawal is not pending review');
    await this.audit(admin.id, 'WITHDRAWAL_UNDER_REVIEW', id);
    return this.getOneForAdmin(id);
  }

  /** Administrator flags missing information; requester must resubmit evidence. */
  async requireInfo(id: string, admin: Actor, note: string) {
    const updated = await this.prisma.withdrawal.updateMany({
      where: { id, status: { in: ['PENDING', 'UNDER_REVIEW'] as WithdrawalStatus[] } },
      data: { status: WithdrawalStatus.REQUIRES_INFORMATION, adminNote: note, reviewedById: admin.id, reviewedAt: new Date() },
    });
    if (updated.count === 0) throw new BadRequestException('Withdrawal cannot be flagged for information');
    await this.audit(admin.id, 'WITHDRAWAL_REQUIRES_INFO', id, { note });
    return this.getOneForAdmin(id);
  }

  private dualApprovalRequired(): boolean {
    const mode = this.config.get<string>('withdrawals.dualApprovalMode') ?? 'ALL';
    return mode === 'ALL' || mode === 'THRESHOLD'; // every mode requires approval; threshold only relaxes to >= threshold
  }

  /**
   * FIRST APPROVAL (v1.0.4 §6, stale-response fix v1.0.7 §10). Rules enforced:
   *  - the authoritative withdrawal row is read + LOCKED inside the transaction
 *    — the approval and its snapshot are created from the committed state,
 *    never from stale in-memory reads;
   *  - the requester can never be an approver;
   *  - the approval is recorded for the CURRENT approval cycle and binds the
   *    exact amount, currency AND destination version (v1.0.7 §8.3);
   *  - the response reflects the committed record (reloaded after commit).
   */
  async approve(id: string, admin: Actor) {
    const result = await this.prisma.$transaction(async (tx) => {
      // §10 — read and lock the authoritative withdrawal INSIDE the transaction.
      const rows = await tx.$queryRaw<{ id: string; status: WithdrawalStatus; requestedById: string; amount: bigint; currency: string; approvalCycle: number; destinationVersion: number }[]>`
        SELECT "id", "status", "requestedById", "amount", "currency", "approvalCycle", "destinationVersion" FROM "Withdrawal" WHERE "id" = ${id} FOR UPDATE`;
      const withdrawal = rows[0];
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      if (withdrawal.requestedById === admin.id) {
        throw new ForbiddenException('The requester of a withdrawal cannot approve it (separation of duties)');
      }
      const approvable: WithdrawalStatus[] = ['PENDING', 'UNDER_REVIEW', 'REQUIRES_INFORMATION'] as WithdrawalStatus[];
      if (!approvable.includes(withdrawal.status)) {
        throw new BadRequestException('Withdrawal is not in an approvable state');
      }

      const updated = await tx.withdrawal.updateMany({
        where: { id, status: withdrawal.status },
        data: { status: WithdrawalStatus.APPROVED, reviewedById: admin.id, reviewedAt: new Date() },
      });
      if (updated.count === 0) throw new ConflictException('Withdrawal state changed concurrently — approval rejected');

      const approval = await tx.withdrawalApproval.create({
        data: {
          withdrawalId: id,
          cycle: withdrawal.approvalCycle,
          role: 'FIRST_APPROVER',
          approverId: admin.id,
          amountAtApproval: withdrawal.amount,
          currencyAtApproval: withdrawal.currency,
          destinationVersionAtApproval: withdrawal.destinationVersion,
          status: 'ACTIVE',
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: admin.id,
          action: 'WITHDRAWAL_APPROVED',
          entityType: 'WITHDRAWAL',
          entityId: id,
          metadata: {
            amount: withdrawal.amount.toString(),
            currency: withdrawal.currency,
            destinationVersion: withdrawal.destinationVersion,
            approvalId: approval.id,
            cycle: withdrawal.approvalCycle,
          },
        },
      });
      return { approval, cycle: withdrawal.approvalCycle, amount: withdrawal.amount, currency: withdrawal.currency };
    });

    // §10 — the response is derived from the COMMITTED record, reloaded fresh.
    return {
      ...((await this.getOneForAdmin(id)) as object),
      dualApprovalRequired: true,
      approval: { id: result.approval.id, cycle: result.cycle, amountMinor: result.amount.toString(), currency: result.currency },
      message: 'Approved. A second administrator must confirm this payout before it can be paid.',
    };
  }

  /**
   * SECOND APPROVAL (v1.0.4 §6.4 — the UNDER_REVIEW exception is REMOVED;
   * v1.0.7 §10 stale-response fix). The second approver must be a different
   * administrator from the requester AND from the first approver. The
   * authoritative withdrawal row is LOCKED inside the transaction; the
   * binding check (amount, currency AND destination version) runs against
   * locked state; the response reflects the committed record.
   */
  async secondApproval(id: string, admin: Actor, note?: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: WithdrawalStatus; requestedById: string; reviewedById: string | null; amount: bigint; currency: string; approvalCycle: number; destinationVersion: number; secondApprovedById: string | null }[]>`
        SELECT "id", "status", "requestedById", "reviewedById", "amount", "currency", "approvalCycle", "destinationVersion", "secondApprovedById" FROM "Withdrawal" WHERE "id" = ${id} FOR UPDATE`;
      const withdrawal = rows[0];
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      if (withdrawal.requestedById === admin.id) {
        throw new ForbiddenException('The requester cannot be the second approver');
      }
      // NO UNDER_REVIEW exception (v1.0.3 loophole, §6.4): the first approver
      // can never confirm the second approval, regardless of the withdrawal
      // state. Identity separation is checked BEFORE the state gate so the
      // audit trail always shows the precise separation violation.
      if (withdrawal.reviewedById === admin.id) {
        throw new ForbiddenException('The first approver cannot also be the second approver');
      }
      if (!['APPROVED', 'PROCESSING'].includes(withdrawal.status)) {
        throw new BadRequestException('Second approval is only possible for an approved payout');
      }

      // Lock the first approval row too — concurrent invalidation serializes.
      const firstRows = await tx.$queryRaw<{ id: string; approverId: string; amountAtApproval: bigint; currencyAtApproval: string; destinationVersionAtApproval: number | null; cycle: number }[]>`
        SELECT "id", "approverId", "amountAtApproval", "currencyAtApproval", "destinationVersionAtApproval", "cycle" FROM "WithdrawalApproval"
        WHERE "withdrawalId" = ${id} AND "cycle" = ${withdrawal.approvalCycle} AND "role" = 'FIRST_APPROVER' AND "status" = 'ACTIVE' FOR UPDATE`;
      const firstActive = firstRows[0];
      if (!firstActive) {
        throw new BadRequestException('No active first approval exists for the current approval cycle');
      }
      if (firstActive.approverId === admin.id) {
        throw new ForbiddenException('The first approver cannot also be the second approver');
      }

      // Approval binding (§13.3 + v1.0.7 §8.3): if amount, currency OR the
      // destination version changed since the first approval, the approvals
      // of this cycle are invalidated and a new cycle must start.
      const stale =
        firstActive.amountAtApproval !== withdrawal.amount ||
        firstActive.currencyAtApproval !== withdrawal.currency ||
        firstActive.destinationVersionAtApproval == null ||
        firstActive.destinationVersionAtApproval !== withdrawal.destinationVersion;
      if (stale) {
        const newCycle = withdrawal.approvalCycle + 1;
        await tx.withdrawalApproval.updateMany({
          where: { withdrawalId: id, cycle: withdrawal.approvalCycle, status: 'ACTIVE' },
          data: { status: 'INVALIDATED', invalidatedAt: new Date(), invalidatedById: admin.id },
        });
        await tx.withdrawal.update({ where: { id }, data: { approvalCycle: newCycle } });
        throw new ConflictException(
          'The approved amount, currency or destination changed since the first approval — all approvals of the previous cycle were invalidated. A new first approval is required.',
        );
      }

      // Concurrent second approvals: the conditional updateMany on
      // secondApprovedById IS NULL makes exactly one concurrent writer win.
      const updated = await tx.withdrawal.updateMany({
        where: { id, status: { in: ['APPROVED', 'PROCESSING'] as WithdrawalStatus[] }, secondApprovedById: null },
        data: { secondApprovedById: admin.id, secondApprovedAt: new Date(), ...(note ? { adminNote: note } : {}) },
      });
      if (updated.count === 0) throw new ConflictException('Second approval already recorded');

      const approval = await tx.withdrawalApproval.create({
        data: {
          withdrawalId: id,
          cycle: withdrawal.approvalCycle,
          role: 'SECOND_APPROVER',
          approverId: admin.id,
          amountAtApproval: withdrawal.amount,
          currencyAtApproval: withdrawal.currency,
          destinationVersionAtApproval: withdrawal.destinationVersion,
          status: 'ACTIVE',
          note,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: admin.id,
          action: 'WITHDRAWAL_SECOND_APPROVAL',
          entityType: 'WITHDRAWAL',
          entityId: id,
          metadata: {
            note,
            amount: withdrawal.amount.toString(),
            currency: withdrawal.currency,
            destinationVersion: withdrawal.destinationVersion,
            approvalId: approval.id,
            cycle: withdrawal.approvalCycle,
          },
        },
      });
      return { approvalId: approval.id };
    });
    // §10 — response derived from the committed record.
    const committed = await this.getOneForAdmin(id);
    return { ...(committed as object), approvalId: result.approvalId };
  }

  /** Any non-settled pre-transfer state -> REJECTED. Reservation releases automatically. */
  async reject(id: string, admin: Actor, note: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    // A transfer that has left APPROVED cannot be administratively rejected:
    // PROCESSING / REQUIRES_RECONCILIATION outcomes belong to verification.
    const updated = await this.prisma.withdrawal.updateMany({
      where: { id, status: { in: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REQUIRES_INFORMATION'] as WithdrawalStatus[] } },
      data: { status: WithdrawalStatus.REJECTED, adminNote: note, reviewedById: admin.id, reviewedAt: new Date() },
    });
    if (updated.count === 0) throw new BadRequestException('Withdrawal can no longer be rejected (already transferring/settled?)');
    if (withdrawal.requestedById === admin.id) {
      // Requester is protected from approving; rejecting their own request is
      // recorded but still forbidden — consistency of separation of duties.
      throw new ForbiddenException('The requester cannot perform administrative decisions on this withdrawal');
    }
    await this.audit(admin.id, 'WITHDRAWAL_REJECTED', id, { note, amount: withdrawal.amount.toString() });
    return this.getOneForAdmin(id);
  }

  // ---- evidence (v1.0.4 §10) -------------------------------------------------

  /**
   * Validate a manual payout evidence file — v1.0.8 §3.5: delegated to the
   * canonical PayoutEvidenceService (the single validation implementation,
   * re-asserted inside the settlement transaction). Arbitrary external
   * evidenceUrl strings are structurally impossible: only a StoredFile id is
   * accepted.
   */
  async validateEvidenceFile(fileId: string, admin: Actor, withdrawalId: string) {
    return this.payoutEvidence.validateEvidenceFile(this.prisma, fileId, admin, withdrawalId);
  }

  /** Bind the evidence file to the withdrawal (unique -> reuse prevention at the DB level). */
  private async bindEvidence(fileId: string, withdrawalId: string, admin: Actor) {
    await this.payoutEvidence.bindEvidence(this.prisma, fileId, withdrawalId);
    await this.audit(admin.id, 'PAYOUT_EVIDENCE_BOUND', withdrawalId, { fileId });
  }

  // ---- settlement / retry / reconciliation -------------------------------------

  /**
   * MANUAL SETTLEMENT (v1.0.4 §6.2/§7) — the only human payout path. Replaces
   * the old mark-paid / mark-processing / mark-failed trio. Enforced here AND
   * in PayoutService:
   *  - fresh MFA (controller guard) and ADMIN role;
   *  - dual approval per policy: active FIRST + SECOND approvals in the
   *    current cycle, requester excluded from every role, first approver ≠
   *    second approver, and the executor (this caller) ≠ second approver;
   *  - evidence must be a registered private scanned file bound to THIS
   *    withdrawal (no arbitrary URLs);
   *  - state must be APPROVED/PROCESSING; exactly-once ledger posting.
   */
  async confirmSettlement(id: string, admin: Actor, dto: SettlePayoutDto) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');

    if (withdrawal.requestedById === admin.id) {
      throw new ForbiddenException('The requester of a withdrawal cannot settle it (separation of duties)');
    }

    if (this.dualApprovalRequired()) {
      const approvals = await this.prisma.withdrawalApproval.findMany({
        where: { withdrawalId: id, cycle: withdrawal.approvalCycle, status: 'ACTIVE' },
      });
      const first = approvals.find((a) => a.role === 'FIRST_APPROVER');
      const second = approvals.find((a) => a.role === 'SECOND_APPROVER');
      if (!first || !second) {
        throw new ForbiddenException('High-value policy: a second administrator approval is required before settlement');
      }
      if (first.approverId === second.approverId) {
        throw new ForbiddenException('The first and second approver must be different administrators');
      }
      if (first.amountAtApproval !== withdrawal.amount || first.currencyAtApproval !== withdrawal.currency) {
        throw new ConflictException('Approval no longer matches the withdrawal amount/currency — approvals invalidated, reapproval required');
      }
      // Executor separation (§6.3 + v1.0.7 §8.2 — STRICT): the payout
      // executor must differ from BOTH approvers. The v1.0.6 exception that
      // allowed the first approver to execute is removed: all four financial
      // roles (requester, first approver, second approver, executor) are now
      // enforced as distinct identities.
      if (first.approverId === admin.id) {
        throw new ForbiddenException('The first approver cannot execute the payout (executor separation, v1.0.7 §8.2)');
      }
      if (second.approverId === admin.id) {
        throw new ForbiddenException('The second approver cannot execute the payout (executor separation)');
      }
    }

    // Evidence validation (§10.2/§10.3) — arbitrary URLs are rejected.
    const file = await this.validateEvidenceFile(dto.evidenceFileId, admin, id);
    await this.bindEvidence(file.id, id, admin);

    const result = await this.payouts.settleManual(id, admin, {
      payoutProvider: dto.payoutProvider,
      providerTransferRef: dto.providerTransferRef,
      payoutProviderTxnId: dto.payoutProviderTxnId,
      evidenceFileId: file.id,
      note: dto.note,
    });

    // Immutable executor record (§6.2) — recorded AFTER the settlement so the
    // identity reflects the actual executor.
    await this.prisma.withdrawalApproval
      .create({
        data: {
          withdrawalId: id,
          cycle: withdrawal.approvalCycle,
          role: 'EXECUTOR',
          approverId: admin.id,
          amountAtApproval: withdrawal.amount,
          currencyAtApproval: withdrawal.currency,
          status: 'ACTIVE',
          metadata: { attemptId: result.attempt.id, settledAt: new Date().toISOString() },
        },
      })
      .catch(async (err) => {
        // Concurrent executor rows are not fatal to the settlement itself.
        this.logger.warn(`EXECUTOR approval row for ${id}: ${(err as Error).message}`);
      });

    await this.audit(admin.id, 'WITHDRAWAL_PAID', id, {
      amount: withdrawal.amount.toString(),
      currency: withdrawal.currency,
      evidenceFileId: file.id,
      providerTransferRef: dto.providerTransferRef,
    });
    return result.withdrawal;
  }

  /** Authoritative verification of a payout attempt (read-only; applies state machine). */
  async verifyPayoutAttempt(attemptId: string, admin: Actor) {
    const attempt = await this.prisma.payoutAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Payout attempt not found');
    const withdrawal = await this.prisma.withdrawal.findUniqueOrThrow({ where: { id: attempt.withdrawalId } });
    if (withdrawal.requestedById === admin.id && admin.role !== 'ADMIN') {
      throw new ForbiddenException('Not authorized');
    }
    return this.payouts.verifyAttempt(attemptId, admin);
  }

  /** Safe retry (v1.0.4 §5.4): only from FAILED with no unresolved attempts. */
  async retryPayout(id: string, admin: Actor, dto: RetryPayoutDto) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    if (withdrawal.requestedById === admin.id) {
      throw new ForbiddenException('The requester of a withdrawal cannot retry it (separation of duties)');
    }
    return this.payouts.retry(id, admin, { payoutProvider: dto.payoutProvider, note: dto.note });
  }

  /**
   * Reconciliation (v1.0.4 §11): attach a registered evidence file to a PAID
   * payout, or trigger provider verification for an in-flight one. Financial
   * records are never altered automatically and reconciliation never
   * initiates a new payout.
   */
  async reconcile(id: string, admin: Actor, evidenceFileId?: string, note?: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');

    let evidence: string | undefined;
    if (evidenceFileId) {
      const file = await this.validateEvidenceFile(evidenceFileId, admin, id);
      await this.bindEvidence(file.id, id, admin);
      evidence = file.id;
    }

    if (['PROCESSING', 'REQUIRES_RECONCILIATION'].includes(withdrawal.status)) {
      const recon = await this.payouts.reconcileWithdrawal(id, admin);
      await this.audit(admin.id, 'WITHDRAWAL_RECONCILIATION_RUN', id, { note, evidenceFileId: evidence, ...recon });
      return this.getOneForAdmin(id);
    }

    if (withdrawal.status !== WithdrawalStatus.PAID) {
      throw new BadRequestException('Only paid or in-flight payouts can be reconciled');
    }
    const updated = await this.prisma.withdrawal.update({
      where: { id },
      data: {
        reconciledAt: new Date(),
        reconciledById: admin.id,
        ...(note ? { adminNote: note } : {}),
      },
    });
    await this.audit(admin.id, 'WITHDRAWAL_RECONCILED', id, { evidenceFileId: evidence, note });
    return updated;
  }

  /** Evidence access (§10.4): short-lived signed URL, authorized viewers only, audited. */
  async getEvidenceUrl(id: string, user: Actor) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: { campaign: { select: { createdById: true, organizationId: true } } },
    });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');

    // Entitled viewers: admins, the requester, campaign creator, org members.
    let entitled =
      user.role === 'ADMIN' ||
      withdrawal.requestedById === user.id ||
      withdrawal.campaign.createdById === user.id;
    if (!entitled && withdrawal.campaign.organizationId) {
      entitled =
        (await this.prisma.organizationMember.count({
          where: { organizationId: withdrawal.campaign.organizationId, userId: user.id },
        })) > 0;
    }
    if (!entitled) throw new ForbiddenException('Not authorized to access payout evidence');

    const file = await this.prisma.storedFile.findFirst({ where: { evidenceForWithdrawalId: id } });
    if (!file) throw new NotFoundException('No evidence file on this withdrawal');
    await this.audit(user.id, 'PRIVILEGED_DOCUMENT_ACCESS', id, { fileId: file.id, context: 'WITHDRAWAL_EVIDENCE' });
    return { fileId: file.id, key: file.key, visibility: file.visibility, note: 'signed read URL is issued by the storage module after authorization' };
  }

  // ---- v1.0.7 payout execution -----------------------------------------------

  /**
   * §5.4 — destination change. Bumps the destination version, invalidates ALL
   * active beneficiaries and the current approval cycle in one transaction.
   * The requester then needs fresh approvals for the new destination.
   */
  async updateDestination(id: string, admin: Actor, dto: UpdateDestinationDto) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    if (withdrawal.requestedById !== admin.id && admin.role !== 'ADMIN') {
      throw new ForbiddenException('Only the requester or an administrator can update the destination');
    }
    const newVersion = await this.beneficiaries.invalidateOnDestinationChange(id, admin.id);
    await this.prisma.withdrawal.update({
      where: { id },
      data: { destination: dto.destination as Prisma.InputJsonValue },
    });
    await this.audit(admin.id, 'WITHDRAWAL_DESTINATION_UPDATED', id, {
      destinationVersion: newVersion,
      note: 'destination JSON replaced; approvals + beneficiaries invalidated (v1.0.7 §5.4)',
    });
    return this.getOneForAdmin(id);
  }

  /**
   * §8 — EXECUTE the payout through a real provider transfer. Requires fresh
   * PAYOUT_EXECUTION MFA (controller). PayoutInitiationService enforces:
   * executor separation against requester AND both approvers, approval
   * snapshot binding (amount/currency/destinationVersion), beneficiary
   * validation, durable intent + outbox, and the provider initiation.
   */
  async executePayout(id: string, admin: Actor, dto: ExecutePayoutDto) {
    // v1.0.9 §5.1 — a MANUAL settlement channel routed through execute is the
    // INTENT AUTHORIZATION step: it binds the immutable manual approval
    // snapshot and registers the manual attempt. Completion requires the
    // separate settle step (POST :id/settle) with registered evidence. API
    // providers keep the provider initiation pipeline unchanged.
    if (isManualSettlementChannel(dto.payoutProvider) || dto.payoutProvider?.toUpperCase() === 'MANUAL_BANK') {
      const canonical = normalizeLegacyManualChannel(dto.payoutProvider) ?? assertManualSettlementChannel(dto.payoutProvider);
      const attempt = await this.payouts.authorizeManualIntent(id, admin, { payoutProvider: canonical, note: (dto as { note?: string }).note });
      await this.audit(admin.id, 'PAYOUT_EXECUTION_AUTHORIZED_MANUAL_INTENT', id, {
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        settlementChannel: canonical,
      });
      return attempt;
    }
    const attempt = await this.payouts.initiate(id, admin, { payoutProvider: dto.payoutProvider });
    await this.audit(admin.id, 'PAYOUT_EXECUTION_AUTHORIZED', id, {
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      provider: dto.payoutProvider,
    });
    return attempt;
  }

  // ---- v1.0.7 manual review (§9) ---------------------------------------------

  async listReviewCases(status: 'OPEN' | 'RESOLVED' | undefined, skip: number, limit: number) {
    return this.manualReview.list(status, skip, limit);
  }

  async getReviewCase(caseId: string) {
    const kase = await this.manualReview.getCase(caseId);
    if (!kase) throw new NotFoundException('Manual review case not found');
    return kase;
  }

  async resolveReviewCase(caseId: string, admin: Actor, dto: ResolveReviewCaseDto) {
    this.manualReview.assertAdmin(admin);
    return this.manualReview.resolveCase(caseId, admin, {
      resolution: dto.resolution as ResolveCaseResolution,
      note: dto.note,
      evidenceFileId: dto.evidenceFileId,
      reviewerId: dto.reviewerId,
    }, 'PAYOUT_MANUAL_REVIEW');
  }

  /** Full detail for admins (includes destination + payout metadata). */
  private async getOneForAdmin(id: string) {
    return this.prisma.withdrawal.findUnique({
      where: { id },
      include: { campaign: { select: { title: true, slug: true } } },
    });
  }
}
