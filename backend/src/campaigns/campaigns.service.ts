import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CampaignStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';
import { toMinor } from '../common/utils/money';
import { slugify } from '../common/utils/slug.util';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { CreateCampaignUpdateDto, CampaignQueryDto } from './dto/campaign-query.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';

const PUBLIC_CAMPAIGN_STATUSES: CampaignStatus[] = ['ACTIVE', 'PAUSED', 'COMPLETED'];

/** The 12 KINDORA categories (mirrors frontend/src/lib/constants.ts + prisma/seed.ts). */
export const DEFAULT_CATEGORIES: { slug: string; name: string; icon: string }[] = [
  { slug: 'education', name: 'Education', icon: 'GraduationCap' },
  { slug: 'health', name: 'Medical & Health', icon: 'HeartPulse' },
  { slug: 'water', name: 'Water & Sanitation', icon: 'Droplets' },
  { slug: 'environment', name: 'Environment', icon: 'Sprout' },
  { slug: 'emergency', name: 'Emergency Relief', icon: 'ShieldAlert' },
  { slug: 'children', name: 'Children & Family', icon: 'Baby' },
  { slug: 'community', name: 'Community', icon: 'Users' },
  { slug: 'animals', name: 'Animals', icon: 'PawPrint' },
  { slug: 'sports', name: 'Sports', icon: 'Trophy' },
  { slug: 'arts', name: 'Arts & Culture', icon: 'Palette' },
  { slug: 'tech', name: 'Technology Access', icon: 'Laptop' },
  { slug: 'housing', name: 'Housing', icon: 'Home' },
];
const CAMPAIGN_LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  status: true,
  type: true,
  targetAmount: true,
  raisedAmount: true,
  donorCount: true,
  viewCount: true,
  currency: true,
  deadline: true,
  country: true,
  city: true,
  coverImageUrl: true,
  isFeatured: true,
  allowComments: true,
  createdAt: true,
  category: { select: { slug: true, name: true } },
  createdBy: { select: { firstName: true, lastName: true } },
  organization: { select: { slug: true, name: true } },
} satisfies Prisma.CampaignSelect;

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Owner = creator or a member of the owning organization; admins bypass. */
  private async assertOwnership(
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
    throw new ForbiddenException('You do not manage this campaign');
  }

  private async myOrganizationIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    return memberships.map((m) => m.organizationId);
  }

  // ---------------------------------------------------------------------------
  // Public browsing
  // ---------------------------------------------------------------------------

  async list(query: CampaignQueryDto) {
    const requested = (query.status ?? 'ACTIVE')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is CampaignStatus => (PUBLIC_CAMPAIGN_STATUSES as string[]).includes(s));
    const statuses: CampaignStatus[] = requested.length ? requested : ['ACTIVE'];

    const where: Prisma.CampaignWhereInput = {
      status: { in: statuses },
      ...(query.country ? { country: query.country } : {}),
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { excerpt: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    let orderBy: Prisma.CampaignOrderByWithRelationInput;
    switch (query.sort) {
      case 'newest':
        orderBy = { createdAt: 'desc' };
        break;
      case 'deadline':
        // Ending soon first; campaigns without a deadline sink to the bottom.
        orderBy = { deadline: { sort: 'asc', nulls: 'last' } };
        break;
      case 'target':
        orderBy = { targetAmount: 'desc' };
        break;
      case 'trending':
      default:
        orderBy = { raisedAmount: 'desc' };
        break;
    }

    const [total, items] = await this.prisma.$transaction([
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.limit,
        select: CAMPAIGN_LIST_SELECT,
      }),
    ]);
    return { total, items };
  }

  async categories() {
    // Seed-if-empty: fresh deployments get the canonical 12 categories without
    // requiring a manual `prisma db seed` run.
    const existingCount = await this.prisma.category.count();
    if (existingCount === 0) {
      await this.prisma.category.createMany({ data: DEFAULT_CATEGORIES, skipDuplicates: true });
    }

    const grouped = await this.prisma.campaign.groupBy({
      by: ['categoryId'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    });
    const counts = new Map<string, number>(grouped.map((g) => [g.categoryId, g._count._all]));
    const categories = await this.prisma.category.findMany({ orderBy: { name: 'asc' } });
    return categories.map((c) => ({ slug: c.slug, name: c.name, icon: c.icon, count: counts.get(c.id) ?? 0 }));
  }

  async mine(userId: string, skip: number, limit: number) {
    const orgIds = await this.myOrganizationIds(userId);
    const where: Prisma.CampaignWhereInput = {
      OR: [{ createdById: userId }, ...(orgIds.length ? [{ organizationId: { in: orgIds } }] : [])],
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: CAMPAIGN_LIST_SELECT,
      }),
    ]);
    return { total, items };
  }

  async detail(slug: string, user: { id: string; role: string } | null) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { slug },
      include: {
        media: { orderBy: { orderIndex: 'asc' } },
        category: { select: { id: true, slug: true, name: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        organization: { select: { id: true, slug: true, name: true, logoUrl: true } },
        beneficiary: { select: { id: true, name: true, type: true } },
        matchingPools: {
          where: { status: 'ACTIVE' },
          select: {
            id: true,
            name: true,
            totalCommitted: true,
            matchedAmount: true,
            matchRatio: true,
            status: true,
            startsAt: true,
            endsAt: true,
          },
        },
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');

    const isHiddenStatus = campaign.status === 'DRAFT' || campaign.status === 'REJECTED';
    if (isHiddenStatus && user) {
      await this.assertOwnership(campaign, user);
    } else if (isHiddenStatus) {
      throw new NotFoundException('Campaign not found');
    }

    if (!isHiddenStatus) {
      // Fire-and-forget: a slow stat write must never delay the response.
      void this.trackView(campaign.id, campaign.currency).catch(() => undefined);
    }
    return campaign;
  }

  /** Increments viewCount and today's CampaignStatDaily views by 1. */
  async trackView(campaignId: string, currency: string) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await Promise.all([
      this.prisma.campaign.update({
        where: { id: campaignId },
        data: { viewCount: { increment: 1 } },
        select: { id: true },
      }),
      this.prisma.campaignStatDaily.upsert({
        where: { campaignId_date: { campaignId, date: today } },
        update: { views: { increment: 1 } },
        create: { campaignId, date: today, views: 1, currency },
      }),
    ]);
    return { ok: true };
  }

  async recordView(slug: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { slug },
      select: { id: true, currency: true, status: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.trackView(campaign.id, campaign.currency);
  }

  /** Raw campaign for owner dashboards: matching pools + media, no public filtering. */
  async byId(id: string, user: { id: string; role: string }) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        media: { orderBy: { orderIndex: 'asc' } },
        category: { select: { id: true, slug: true, name: true } },
        organization: { select: { id: true, slug: true, name: true, status: true } },
        beneficiary: { select: { id: true, name: true, type: true } },
        matchingPools: {
          select: {
            id: true,
            name: true,
            totalCommitted: true,
            matchedAmount: true,
            matchRatio: true,
            status: true,
            startsAt: true,
            endsAt: true,
          },
        },
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    await this.assertOwnership(campaign, user);
    return { campaign };
  }

  // ---------------------------------------------------------------------------
  // Creation & management
  // ---------------------------------------------------------------------------

  async create(dto: CreateCampaignDto, user: { id: string; emailVerified: boolean }) {
    if (!user.emailVerified) {
      throw new ForbiddenException('Verify your email address before creating campaigns');
    }

    // Category is resolved by slug (preferred) or id; exactly one must resolve.
    let categoryId: string | undefined;
    if (dto.categorySlug) {
      const category = await this.prisma.category.findUnique({
        where: { slug: dto.categorySlug },
        select: { id: true },
      });
      if (!category) throw new BadRequestException('Unknown category');
      categoryId = category.id;
    } else if (dto.categoryId) {
      const category = await this.prisma.category.findUnique({
        where: { id: dto.categoryId },
        select: { id: true },
      });
      if (!category) throw new BadRequestException('Unknown category');
      categoryId = category.id;
    } else {
      throw new BadRequestException('categorySlug or categoryId is required');
    }

    if (dto.type === 'ORGANIZATION' && !dto.organizationId) {
      throw new BadRequestException('ORGANIZATION campaigns require organizationId');
    }

    if (dto.organizationId) {
      const membership = await this.prisma.organizationMember.findFirst({
        where: { organizationId: dto.organizationId, userId: user.id },
        select: { id: true },
      });
      if (!membership) throw new ForbiddenException('You are not a member of this organization');
    }

    if (dto.beneficiaryId) {
      const beneficiary = await this.prisma.beneficiary.findUnique({
        where: { id: dto.beneficiaryId },
        select: { id: true },
      });
      if (!beneficiary) throw new BadRequestException('Unknown beneficiary');
    }

    const currency = (dto.currency ?? 'NGN').toUpperCase();
    let deadline: Date | null = null;
    if (dto.deadline) {
      deadline = new Date(dto.deadline);
      if (Number.isNaN(deadline.getTime())) throw new BadRequestException('Invalid deadline');
      if (deadline.getTime() <= Date.now()) throw new BadRequestException('Deadline must be in the future');
    }

    const campaign = await this.prisma.campaign.create({
      data: {
        slug: slugify(dto.title),
        title: dto.title,
        excerpt: dto.excerpt,
        story: dto.story,
        status: 'DRAFT',
        type: dto.type ?? 'INDIVIDUAL',
        targetAmount: toMinor(dto.targetAmountMajor, currency),
        currency,
        deadline,
        country: dto.country,
        city: dto.city,
        coverImageUrl: dto.coverImageUrl,
        videoUrl: dto.videoUrl,
        categoryId,
        createdById: user.id,
        organizationId: dto.organizationId,
        beneficiaryId: dto.beneficiaryId,
      },
      select: CAMPAIGN_LIST_SELECT,
    });
    return { campaign };
  }

  async update(id: string, dto: UpdateCampaignDto, user: { id: string; role: string }) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { id: true, createdById: true, organizationId: true, status: true, currency: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    await this.assertOwnership(campaign, user);

    if (dto.status) {
      if (dto.status === 'ACTIVE' && campaign.status !== 'PAUSED') {
        throw new BadRequestException('Campaigns can only be activated while paused');
      }
      if (dto.status === 'PAUSED' && !['ACTIVE', 'PAUSED'].includes(campaign.status)) {
        throw new BadRequestException(`A ${campaign.status.toLowerCase()} campaign cannot be paused`);
      }
    }

    const data: Prisma.CampaignUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.excerpt !== undefined) data.excerpt = dto.excerpt;
    if (dto.story !== undefined) data.story = dto.story;
    if (dto.allowComments !== undefined) data.allowComments = dto.allowComments;
    if (dto.deadline !== undefined) {
      const deadline = new Date(dto.deadline);
      if (Number.isNaN(deadline.getTime())) throw new BadRequestException('Invalid deadline');
      data.deadline = deadline;
    }
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.coverImageUrl !== undefined) data.coverImageUrl = dto.coverImageUrl;
    if (dto.videoUrl !== undefined) data.videoUrl = dto.videoUrl;
    const nextCurrency = dto.currency !== undefined ? dto.currency.toUpperCase() : campaign.currency;
    if (dto.currency !== undefined) data.currency = nextCurrency;
    if (dto.targetAmountMajor !== undefined) {
      data.targetAmount = toMinor(dto.targetAmountMajor, nextCurrency);
    }
    if (dto.categoryId !== undefined) {
      const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId }, select: { id: true } });
      if (!category) throw new BadRequestException('Unknown category');
      data.category = { connect: { id: dto.categoryId } };
    }
    if (dto.status) data.status = dto.status;

    const updated = await this.prisma.campaign.update({
      where: { id: campaign.id },
      data,
      select: CAMPAIGN_LIST_SELECT,
    });
    return { campaign: updated };
  }

  /** Owner toggle: ACTIVE -> PAUSED. */
  async pause(id: string, user: { id: string; role: string }) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { id: true, status: true, createdById: true, organizationId: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    await this.assertOwnership(campaign, user);
    if (campaign.status !== 'ACTIVE') {
      throw new BadRequestException(`A ${campaign.status.toLowerCase()} campaign cannot be paused`);
    }
    const paused = await this.prisma.campaign.update({
      where: { id },
      data: { status: 'PAUSED' },
      select: CAMPAIGN_LIST_SELECT,
    });
    return { campaign: paused };
  }

  /** Owner toggle: PAUSED -> ACTIVE. */
  async resume(id: string, user: { id: string; role: string }) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { id: true, status: true, createdById: true, organizationId: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    await this.assertOwnership(campaign, user);
    if (campaign.status !== 'PAUSED') {
      throw new BadRequestException(`A ${campaign.status.toLowerCase()} campaign cannot be resumed`);
    }
    const resumed = await this.prisma.campaign.update({
      where: { id },
      data: { status: 'ACTIVE' },
      select: CAMPAIGN_LIST_SELECT,
    });
    return { campaign: resumed };
  }

  async submit(id: string, user: { id: string; role: string }) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { id: true, slug: true, title: true, createdById: true, organizationId: true, status: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    await this.assertOwnership(campaign, user);

    if (campaign.status !== 'DRAFT' && campaign.status !== 'REJECTED') {
      throw new BadRequestException(`A ${campaign.status.toLowerCase()} campaign cannot be submitted for review`);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'PENDING_REVIEW' },
        select: CAMPAIGN_LIST_SELECT,
      }),
      this.prisma.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'CAMPAIGN_SUBMITTED',
          entityType: 'CAMPAIGN',
          entityId: campaign.id,
          metadata: { slug: campaign.slug, previousStatus: campaign.status },
        },
      }),
    ]);
    return { campaign: updated };
  }

  // ---------------------------------------------------------------------------
  // Updates (posts from the organizer)
  // ---------------------------------------------------------------------------

  async createUpdate(identifier: string, dto: CreateCampaignUpdateDto, user: { id: string; role: string }) {
    // Identifier may be a campaign id (owner dashboards) or a slug (public page).
    const campaign =
      (await this.prisma.campaign.findUnique({
        where: { id: identifier },
        select: { id: true, title: true, createdById: true, organizationId: true },
      })) ??
      (await this.prisma.campaign.findUnique({
        where: { slug: identifier },
        select: { id: true, title: true, createdById: true, organizationId: true },
      }));
    if (!campaign) throw new NotFoundException('Campaign not found');
    await this.assertOwnership(campaign, user);

    const update = await this.prisma.campaignUpdate.create({
      data: {
        campaignId: campaign.id,
        authorId: user.id,
        title: dto.title,
        body: dto.body,
      },
    });

    await Promise.all([
      this.queue.enqueue('notifications', 'notifications.campaign-update', {
        campaignId: campaign.id,
        updateId: update.id,
        updateTitle: update.title,
      }),
      this.queue.enqueue('email', 'email.campaign-update', {
        campaignId: campaign.id,
        campaignTitle: campaign.title,
        updateTitle: update.title,
      }),
    ]);

    return { update };
  }

  async listUpdates(slug: string, skip: number, limit: number) {
    const campaign = await this.prisma.campaign.findUnique({ where: { slug }, select: { id: true } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    const [total, items] = await this.prisma.$transaction([
      this.prisma.campaignUpdate.count({ where: { campaignId: campaign.id } }),
      this.prisma.campaignUpdate.findMany({
        where: { campaignId: campaign.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { author: { select: { firstName: true, lastName: true } } },
      }),
    ]);
    return { total, items };
  }

  // ---------------------------------------------------------------------------
  // Owner analytics
  // ---------------------------------------------------------------------------

  async analytics(id: string, user: { id: string; role: string }) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: { id: true, viewCount: true, donorCount: true, raisedAmount: true, currency: true, createdById: true, organizationId: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    await this.assertOwnership(campaign, user);

    const since = new Date();
    since.setDate(since.getDate() - 13);
    since.setHours(0, 0, 0, 0);

    const series = await this.prisma.campaignStatDaily.findMany({
      where: { campaignId: campaign.id, date: { gte: since } },
      orderBy: { date: 'asc' },
      take: 14,
      select: { date: true, views: true, donationCount: true, donationAmount: true },
    });

    return {
      views: campaign.viewCount,
      donorCount: campaign.donorCount,
      raisedAmount: campaign.raisedAmount,
      currency: campaign.currency,
      series: series.map((s) => ({
        date: s.date.toISOString(),
        views: s.views,
        donationCount: s.donationCount,
        donationAmount: s.donationAmount,
      })),
      totals: {
        views: series.reduce((acc, s) => acc + s.views, 0),
        donationCount: series.reduce((acc, s) => acc + s.donationCount, 0),
      },
    };
  }
}
