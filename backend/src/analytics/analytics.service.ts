import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';
import { RecomputeDayDto } from './dto/analytics.dto';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async platform() {
    const [users, campaigns, activeCampaigns, donationsSucceeded, pendingWithdrawals, recentDailyDesc] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.campaign.count(),
        this.prisma.campaign.count({ where: { status: 'ACTIVE' } }),
        this.prisma.donation.aggregate({
          where: { status: 'SUCCEEDED' },
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.withdrawal.count({ where: { status: 'PENDING' } }),
        this.prisma.platformStatDaily.findMany({ orderBy: { date: 'desc' }, take: 30 }),
      ]);

    return {
      totals: {
        users,
        campaigns,
        activeCampaigns,
        donationsSucceeded: {
          count: donationsSucceeded._count._all,
          amount: donationsSucceeded._sum.amount ?? 0n,
        },
        pendingWithdrawals,
      },
      recentDaily: recentDailyDesc.slice().reverse(), // last 30 days, ascending
    };
  }

  async recomputeDay(dto: RecomputeDayDto) {
    await this.queue.enqueue('analytics', 'analytics.recompute-day', { date: dto.date });
    return { queued: true };
  }

  /** Owner/admin gate for a campaign: creator, org member, or platform admin. */
  private async assertCampaignAccess(
    campaign: { createdById: string; organizationId: string | null },
    user: { id: string; role: string },
  ): Promise<void> {
    if (user.role === 'ADMIN') return;
    if (campaign.createdById === user.id) return;
    if (campaign.organizationId) {
      const member = await this.prisma.organizationMember.findFirst({
        where: { organizationId: campaign.organizationId, userId: user.id },
        select: { id: true },
      });
      if (member) return;
    }
    throw new ForbiddenException('You do not have access to this campaign');
  }

  /** Campaign analytics for the owner/admin dashboard: 14-day series + daily revenue. */
  async campaignAnalytics(campaignId: string, user: { id: string; role: string }) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        currency: true,
        viewCount: true,
        donorCount: true,
        raisedAmount: true,
        targetAmount: true,
        createdById: true,
        organizationId: true,
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    await this.assertCampaignAccess(campaign, user);

    const since = new Date();
    since.setDate(since.getDate() - 13);
    since.setUTCHours(0, 0, 0, 0);

    const series = await this.prisma.campaignStatDaily.findMany({
      where: { campaignId: campaign.id, date: { gte: since } },
      orderBy: { date: 'asc' },
      take: 14,
    });

    return {
      campaign: {
        id: campaign.id,
        title: campaign.title,
        slug: campaign.slug,
        status: campaign.status,
        currency: campaign.currency,
      },
      views: campaign.viewCount,
      donorCount: campaign.donorCount,
      raisedAmount: campaign.raisedAmount,
      targetAmount: campaign.targetAmount,
      series: series.map((s) => ({
        date: s.date.toISOString(),
        views: s.views,
        donationCount: s.donationCount,
        donationAmount: s.donationAmount, // daily revenue (minor units)
        shares: s.shares,
      })),
      totals: {
        views: series.reduce((acc, s) => acc + s.views, 0),
        donationCount: series.reduce((acc, s) => acc + s.donationCount, 0),
        donationAmount: series.reduce((acc, s) => acc + s.donationAmount, 0n),
      },
    };
  }

  /** Aggregate stats across every campaign the user created or runs via an org. */
  async organizerSummary(userId: string) {
    const orgIds = await this.prisma.organizationMember.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    const where: Prisma.CampaignWhereInput = {
      OR: [
        { createdById: userId },
        ...(orgIds.length ? [{ organizationId: { in: orgIds.map((m) => m.organizationId) } }] : []),
      ],
    };

    const [aggregate, activeCampaigns, totalCampaigns, topCampaigns] = await Promise.all([
      this.prisma.campaign.aggregate({ where, _sum: { raisedAmount: true } }),
      this.prisma.campaign.count({ where: { AND: [where, { status: 'ACTIVE' }] } }),
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        orderBy: { raisedAmount: 'desc' },
        take: 5,
        select: {
          id: true,
          slug: true,
          title: true,
          status: true,
          currency: true,
          targetAmount: true,
          raisedAmount: true,
          donorCount: true,
          viewCount: true,
          coverImageUrl: true,
          deadline: true,
        },
      }),
    ]);

    return {
      totalRaised: aggregate._sum.raisedAmount ?? 0n,
      activeCampaigns,
      totalCampaigns,
      topCampaigns,
    };
  }
}
