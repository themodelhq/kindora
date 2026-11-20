import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CreateMatchingPoolDto } from './dto/create-matching-pool.dto';

@Injectable()
export class MatchingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sponsors (any authenticated user), campaign organizers and admins may
   * create a matching pool on a campaign. The creator becomes the sponsor of
   * record; the committed amount is held against future matches.
   */
  async createPool(campaignId: string, dto: CreateMatchingPoolDto, user: AuthenticatedUser) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, title: true, currency: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');

    const totalCommitted = BigInt(dto.totalCommittedMinor);
    if (totalCommitted <= 0n) {
      throw new BadRequestException('totalCommittedMinor must be greater than zero');
    }

    const pool = await this.prisma.matchingPool.create({
      data: {
        campaignId: campaign.id,
        sponsorUserId: user.id,
        name: dto.name,
        totalCommitted,
        matchRatio: dto.matchRatio ?? 100,
        capPerDonation: dto.capPerDonationMinor != null ? BigInt(dto.capPerDonationMinor) : null,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        status: 'ACTIVE',
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'MATCHING_POOL_CREATED',
        entityType: 'MATCHING_POOL',
        entityId: pool.id,
        metadata: {
          poolId: pool.id,
          campaignId: campaign.id,
          totalCommitted: totalCommitted.toString(),
          matchRatio: pool.matchRatio,
        },
      },
    });

    return pool;
  }

  /** Public: ACTIVE pools for a campaign with their remaining (unmatched) funds. */
  async listForCampaign(slug: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { slug }, select: { id: true } });
    if (!campaign) throw new NotFoundException('Campaign not found');

    const pools = await this.prisma.matchingPool.findMany({
      where: { campaignId: campaign.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        totalCommitted: true,
        matchedAmount: true,
        matchRatio: true,
        capPerDonation: true,
        startsAt: true,
        endsAt: true,
      },
    });

    return pools.map((pool) => ({ ...pool, remaining: pool.totalCommitted - pool.matchedAmount }));
  }

  /** Pools sponsored by the caller with campaign context and application stats. */
  async listMine(userId: string) {
    return this.prisma.matchingPool.findMany({
      where: { sponsorUserId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        campaign: { select: { title: true, slug: true, currency: true } },
        _count: { select: { donations: true } },
      },
    });
  }
}
