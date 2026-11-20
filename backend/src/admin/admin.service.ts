import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CampaignStatus, DonationStatus, KycStatus, Organization, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';
import { LedgerService } from '../ledger/ledger.service';
import { RefundProcessorService } from '../payments/refund-processor.service';
import { PaginationDto } from '../common/dto/pagination.dto';

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  createdAt: true,
  emailVerifiedAt: true,
} satisfies Prisma.UserSelect;

const SAFE_KYC_SELECT = {
  id: true,
  userId: true,
  organizationId: true,
  level: true,
  status: true,
  legalName: true,
  idType: true,
  idNumberLast4: true,
  idDocumentUrl: true,
  selfieUrl: true,
  addressDocumentUrl: true,
  country: true,
  rejectionReason: true,
  reviewedAt: true,
  createdAt: true,
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  organization: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.KycRecordSelect;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly ledger: LedgerService,
    private readonly refundProcessor: RefundProcessorService,
  ) {}

  // ---- Dashboard stats ------------------------------------------------------

  async stats() {
    const [users, campaigns, campaignsPending, donationsAggregate, donationsCount, withdrawalsPending, moderationOpen, fraudOpen] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.campaign.count(),
        this.prisma.campaign.count({ where: { status: CampaignStatus.PENDING_REVIEW } }),
        this.prisma.donation.aggregate({
          where: { status: DonationStatus.SUCCEEDED },
          _sum: { amount: true, tipAmount: true },
        }),
        this.prisma.donation.count({ where: { status: DonationStatus.SUCCEEDED } }),
        this.prisma.withdrawal.count({ where: { status: 'PENDING' } }),
        this.prisma.moderationCase.count({ where: { status: 'OPEN' } }),
        this.prisma.fraudSignal.count({ where: { status: 'OPEN' } }),
      ]);

    return {
      users,
      campaigns,
      campaignsPending,
      donationsAmountMinor: donationsAggregate._sum.amount ?? 0n,
      donationsTipsMinor: donationsAggregate._sum.tipAmount ?? 0n,
      donationsCount,
      withdrawalsPending,
      moderationOpen,
      fraudOpen,
    };
  }

  // ---- Campaign moderation --------------------------------------------------

  async listCampaigns(dto: PaginationDto & { status?: string }) {
    const where: Prisma.CampaignWhereInput = dto.status
      ? { status: dto.status as CampaignStatus }
      : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: dto.skip,
        take: dto.limit,
        include: {
          category: { select: { slug: true, name: true } },
          createdBy: { select: { firstName: true, lastName: true } },
          organization: { select: { name: true } },
        },
      }),
    ]);
    return { total, items };
  }

  async approveCampaign(id: string, admin: { id: string }, note?: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status !== CampaignStatus.PENDING_REVIEW) {
      throw new BadRequestException('Campaign is not pending review');
    }

    const updated = await this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.ACTIVE, publishedAt: new Date(), approvalNote: note ?? null },
    });

    await this.queue.enqueue('email', 'email.campaign-approved', {
      userId: campaign.createdById,
      campaignId: campaign.id,
      campaignTitle: campaign.title,
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'ADMIN_CAMPAIGN_APPROVE',
        entityType: 'CAMPAIGN',
        entityId: id,
        metadata: { campaign: { id: updated.id, slug: updated.slug, title: updated.title, status: updated.status }, note: note ?? null },
      },
    });

    return updated;
  }

  async rejectCampaign(id: string, admin: { id: string }, note: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status !== CampaignStatus.PENDING_REVIEW) {
      throw new BadRequestException('Campaign is not pending review');
    }

    const updated = await this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.REJECTED, approvalNote: note },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'ADMIN_CAMPAIGN_REJECT',
        entityType: 'CAMPAIGN',
        entityId: id,
        metadata: { campaign: { id: updated.id, slug: updated.slug, title: updated.title, status: updated.status }, note },
      },
    });

    return updated;
  }

  async suspendCampaign(id: string, admin: { id: string }, note?: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!([CampaignStatus.ACTIVE, CampaignStatus.PAUSED] as CampaignStatus[]).includes(campaign.status)) {
      throw new BadRequestException('Only ACTIVE or PAUSED campaigns can be suspended');
    }

    const updated = await this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.SUSPENDED },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'ADMIN_CAMPAIGN_SUSPEND',
        entityType: 'CAMPAIGN',
        entityId: id,
        metadata: { campaign: { id: updated.id, slug: updated.slug, title: updated.title, status: updated.status }, note: note ?? null },
      },
    });

    return updated;
  }

  async featureCampaign(id: string, admin: { id: string }, featured: boolean) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaign not found');

    const updated = await this.prisma.campaign.update({ where: { id }, data: { isFeatured: featured } });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: featured ? 'ADMIN_CAMPAIGN_FEATURE' : 'ADMIN_CAMPAIGN_UNFEATURE',
        entityType: 'CAMPAIGN',
        entityId: id,
        metadata: { campaign: { id: updated.id, slug: updated.slug, title: updated.title, isFeatured: updated.isFeatured } },
      },
    });

    return updated;
  }

  // ---- User administration --------------------------------------------------

  async listUsers(dto: PaginationDto) {
    const where: Prisma.UserWhereInput = dto.q
      ? {
          OR: [
            { email: { contains: dto.q, mode: 'insensitive' } },
            { firstName: { contains: dto.q, mode: 'insensitive' } },
            { lastName: { contains: dto.q, mode: 'insensitive' } },
          ],
        }
      : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: dto.skip,
        take: dto.limit,
        select: SAFE_USER_SELECT,
      }),
    ]);
    return { total, items };
  }

  async suspendUser(id: string, admin: { id: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: 'SUSPENDED' },
      select: SAFE_USER_SELECT,
    });

    // Kill every live session for the suspended account.
    await this.prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'ADMIN_USER_SUSPEND',
        entityType: 'USER',
        entityId: id,
        metadata: { user: { id: updated.id, email: updated.email } },
      },
    });

    return updated;
  }

  async activateUser(id: string, admin: { id: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: 'ACTIVE' },
      select: SAFE_USER_SELECT,
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'ADMIN_USER_ACTIVATE',
        entityType: 'USER',
        entityId: id,
        metadata: { user: { id: updated.id, email: updated.email } },
      },
    });

    return updated;
  }

  // ---- Ledger ---------------------------------------------------------------

  async listTransactions(dto: PaginationDto) {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.ledgerTransaction.count(),
      this.prisma.ledgerTransaction.findMany({
        orderBy: { postedAt: 'desc' },
        skip: dto.skip,
        take: dto.limit,
        select: {
          id: true,
          reference: true,
          type: true,
          description: true,
          postedAt: true,
          entries: { select: { direction: true, amount: true, currency: true } },
        },
      }),
    ]);
    return { total, items };
  }

  // ---- Refunds --------------------------------------------------------------

  /**
   * Manual full refund. All DB mutations happen atomically in one interactive
   * transaction: the donation state change is guarded by a conditional UPDATE
   * (only SUCCEEDED donations move), the double-entry reversal is posted via
   * LedgerService (unique reference `refund:<id>` makes postings exactly-once)
   * and campaign counters are decremented under guard.
   */
  /**
   * Administrator-initiated refund. Delegates to the shared RefundProcessor
   * which (a) executes the refund against the provider API when the provider
   * supports it, (b) posts compensating ledger entries inside the same
   * transaction as the state change, (c) reverses sponsor matching on full
   * refunds and (d) writes an immutable audit record. Marking a refund
   * PROCESSED without a provider confirmation is no longer possible.
   */
  async refund(dto: { donationRef: string; reason: string }, admin: { id: string }) {
    const outcome = await this.refundProcessor.refundDonation({
      publicRef: dto.donationRef,
      reason: dto.reason,
      requestedById: admin.id,
      source: 'ADMIN',
      executeWithProvider: true,
    });

    const refund = await this.prisma.refund.findUnique({ where: { id: outcome.refundId } });
    return {
      refund: {
        ...refund,
        donationId: outcome.donationId,
        publicRef: outcome.publicRef,
        full: outcome.full,
        tipPart: outcome.tipMinor.toString(),
      },
    };
  }

  // ---- KYC ------------------------------------------------------------------

  async listKyc(dto: PaginationDto & { status?: string }) {
    const where: Prisma.KycRecordWhereInput = dto.status
      ? { status: dto.status as KycStatus }
      : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.kycRecord.count({ where }),
      this.prisma.kycRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: dto.skip,
        take: dto.limit,
        select: SAFE_KYC_SELECT,
      }),
    ]);
    return { total, items };
  }

  async reviewKyc(id: string, admin: { id: string }, dto: { decision: 'APPROVED' | 'REJECTED'; reason?: string }) {
    const record = await this.prisma.kycRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('KYC record not found');

    const { updated, organization } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.kycRecord.update({
        where: { id },
        data: {
          status: dto.decision === 'APPROVED' ? KycStatus.APPROVED : KycStatus.REJECTED,
          reviewedById: admin.id,
          reviewedAt: new Date(),
          rejectionReason: dto.decision === 'REJECTED' ? (dto.reason ?? null) : null,
        },
      });

      // Approving an organization KYC record verifies the organization itself.
      let organization: Organization | null = null;
      if (dto.decision === 'APPROVED' && record.organizationId) {
        organization = await tx.organization.update({
          where: { id: record.organizationId },
          data: { status: 'VERIFIED', verifiedAt: new Date() },
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: admin.id,
          action: 'ADMIN_KYC_REVIEW',
          entityType: 'KYC_RECORD',
          entityId: id,
          metadata: {
            decision: dto.decision,
            reason: dto.reason ?? null,
            organizationId: record.organizationId ?? null,
          },
        },
      });

      return { updated, organization };
    });

    return { record: updated, organization };
  }

  // ---- Reconciliation -------------------------------------------------------

  /**
   * Point-in-time reconciliation view. `mismatches` is the slot for the
   * worker's comparison output; the informational checks below surface the
   * two signal rows admins care about (stale pending charges, failed webhooks).
   */
  async reconciliation() {
    const now = Date.now();
    const thirtyMinutesAgo = new Date(now - 30 * 60 * 1000);
    const dayAgo = new Date(now - 24 * 3600 * 1000);

    const [lastProcessedWebhook, stalePendingCount, stalePendingSample, failedWebhooks24h] = await Promise.all([
      this.prisma.webhookEvent.findFirst({
        where: { processedAt: { not: null } },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
      this.prisma.donation.count({
        where: { status: DonationStatus.PENDING, createdAt: { lt: thirtyMinutesAgo } },
      }),
      this.prisma.donation.findMany({
        where: { status: DonationStatus.PENDING, createdAt: { lt: thirtyMinutesAgo } },
        orderBy: { createdAt: 'asc' },
        take: 10,
        select: {
          publicRef: true,
          provider: true,
          amount: true,
          currency: true,
          createdAt: true,
          campaign: { select: { title: true } },
        },
      }),
      this.prisma.webhookEvent.count({
        where: { status: 'FAILED', createdAt: { gte: dayAgo } },
      }),
    ]);

    return {
      lastRunAt: lastProcessedWebhook?.processedAt ?? null,
      mismatches: [],
      checks: {
        stalePendingDonations: {
          window: 'older than 30 minutes',
          count: stalePendingCount,
          sample: stalePendingSample,
        },
        failedWebhooks24h: {
          window: 'last 24 hours',
          count: failedWebhooks24h,
        },
      },
    };
  }

  async runReconciliation(admin: { id: string }) {
    await this.queue.enqueue('payments', 'payments.reconcile', {});

    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'ADMIN_RECONCILIATION_RUN',
        entityType: 'SYSTEM',
        metadata: { triggeredBy: admin.id },
      },
    });

    return { started: true };
  }
}
