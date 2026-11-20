import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CirclePrivacy, CircleRole, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { inviteCode, slugify } from '../common/utils/slug.util';
import { toMinor } from '../common/utils/money';
import { PaginationDto } from '../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CreateCircleContributionDto, CreateCircleDto, JoinCircleDto, UpdateCircleDto } from './dto/create-circle.dto';

@Injectable()
export class CirclesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCircleDto, user: AuthenticatedUser) {
    let campaignId: string | null = null;
    if (dto.campaignSlug) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { slug: dto.campaignSlug },
        select: { id: true },
      });
      if (!campaign) throw new NotFoundException('Campaign not found');
      campaignId = campaign.id;
    }

    const privacy = dto.privacy ?? CirclePrivacy.PUBLIC;
    const currency = (dto.currency ?? 'NGN').toUpperCase();

    const circle = await this.prisma.circle.create({
      data: {
        slug: slugify(dto.name),
        name: dto.name,
        description: dto.description,
        privacy,
        inviteCode: privacy === CirclePrivacy.PRIVATE ? inviteCode() : null,
        goalAmount: dto.goalAmountMajor != null ? toMinor(dto.goalAmountMajor, currency) : null,
        currency,
        campaignId,
        createdById: user.id,
        members: { create: { userId: user.id, role: CircleRole.OWNER } },
      },
      include: { members: true, campaign: { select: { slug: true, title: true } } },
    });

    return circle;
  }

  /** PUBLIC circles for everyone; PRIVATE circles only appear for their members (authed). */
  async list(pagination: PaginationDto, user: AuthenticatedUser | null) {
    const where: Prisma.CircleWhereInput = {
      OR: [
        { privacy: CirclePrivacy.PUBLIC },
        ...(user
          ? [{ privacy: CirclePrivacy.PRIVATE, members: { some: { userId: user.id } } }]
          : []),
      ],
      ...(pagination.q ? { name: { contains: pagination.q, mode: 'insensitive' } } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.circle.count({ where }),
      this.prisma.circle.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          campaign: { select: { slug: true, title: true } },
          _count: { select: { members: true, contributions: true } },
        },
      }),
    ]);
    return { total, items };
  }

  /** Circles the caller owns or is a member of. */
  async listMine(user: AuthenticatedUser, skip: number, limit: number) {
    const where: Prisma.CircleWhereInput = {
      OR: [{ createdById: user.id }, { members: { some: { userId: user.id } } }],
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.circle.count({ where }),
      this.prisma.circle.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          campaign: { select: { slug: true, title: true } },
          _count: { select: { members: true, contributions: true } },
        },
      }),
    ]);
    return { total, items };
  }

  async getBySlug(slug: string, user: AuthenticatedUser | null) {
    const circle = await this.prisma.circle.findUnique({
      where: { slug },
      include: {
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        campaign: { select: { slug: true, title: true } },
        members: {
          orderBy: { joinedAt: 'asc' },
          include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
        },
      },
    });
    if (!circle) throw new NotFoundException('Circle not found');
    this.assertCircleVisible(circle, user);

    const contributions = await this.prisma.circleContribution.findMany({
      where: { circleId: circle.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
    });

    return { ...circle, contributions };
  }

  /** Only the circle owner (or an admin) may edit it. */
  async update(id: string, dto: UpdateCircleDto, user: AuthenticatedUser) {
    const circle = await this.prisma.circle.findUnique({ where: { id } });
    if (!circle) throw new NotFoundException('Circle not found');
    if (circle.createdById !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the circle owner can update it');
    }

    let campaignId: string | null | undefined;
    if (dto.campaignSlug === null) {
      campaignId = null;
    } else if (dto.campaignSlug !== undefined) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { slug: dto.campaignSlug },
        select: { id: true },
      });
      if (!campaign) throw new NotFoundException('Campaign not found');
      campaignId = campaign.id;
    }

    const updated = await this.prisma.circle.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.coverImageUrl !== undefined ? { coverImageUrl: dto.coverImageUrl } : {}),
        ...(dto.goalAmountMajor != null ? { goalAmount: toMinor(dto.goalAmountMajor, circle.currency) } : {}),
        ...(campaignId !== undefined ? { campaignId } : {}),
        ...(dto.privacy
          ? {
              privacy: dto.privacy,
              // Going PRIVATE (re)issues an invite code; going PUBLIC clears it.
              inviteCode: dto.privacy === CirclePrivacy.PRIVATE ? (circle.inviteCode ?? inviteCode()) : null,
            }
          : {}),
      },
    });
    return updated;
  }

  async join(slug: string, dto: JoinCircleDto, user: AuthenticatedUser) {
    const circle = await this.prisma.circle.findUnique({ where: { slug } });
    if (!circle) throw new NotFoundException('Circle not found');

    if (circle.privacy === CirclePrivacy.PRIVATE && dto.inviteCode !== circle.inviteCode) {
      throw new ForbiddenException('Invalid invite code');
    }

    // Upsert without an update payload: existing ADMIN/OWNER roles are preserved.
    await this.prisma.circleMember.upsert({
      where: { circleId_userId: { circleId: circle.id, userId: user.id } },
      create: { circleId: circle.id, userId: user.id, role: CircleRole.MEMBER },
      update: {},
    });

    return { joined: true };
  }

  /**
   * Records a contribution in the circle feed. Circles never move money:
   * DONATION kind links an existing SUCCEEDED donation owned by the caller
   * (its amount is authoritative); PLEDGE records an intent only.
   */
  async contribute(slug: string, dto: CreateCircleContributionDto, user: AuthenticatedUser) {
    const circle = await this.prisma.circle.findUnique({ where: { slug } });
    if (!circle) throw new NotFoundException('Circle not found');

    if (dto.circleId && dto.circleId !== circle.id) {
      throw new BadRequestException('circleId does not match this circle');
    }

    const membership = await this.prisma.circleMember.findUnique({
      where: { circleId_userId: { circleId: circle.id, userId: user.id } },
    });
    if (!membership && user.role !== 'ADMIN') {
      throw new ForbiddenException('You must be a member of this circle to contribute');
    }

    if (dto.campaignSlug) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { slug: dto.campaignSlug },
        select: { id: true },
      });
      if (!campaign) throw new NotFoundException('Campaign not found');
    }

    if (dto.donationRef) {
      // Linked-donation path: the succeeded donation is the source of truth.
      const donation = await this.prisma.donation.findUnique({ where: { publicRef: dto.donationRef } });
      if (!donation) throw new NotFoundException('Donation not found');
      if (donation.status !== 'SUCCEEDED') {
        throw new BadRequestException('Only succeeded donations can be linked to a circle contribution');
      }
      if (donation.donorUserId !== user.id) {
        throw new ForbiddenException('This donation belongs to another user');
      }
      const existingLink = await this.prisma.circleContribution.findUnique({
        where: { donationId: donation.id },
      });
      if (existingLink) throw new BadRequestException('Donation is already linked to a contribution');

      const contribution = await this.prisma.circleContribution.create({
        data: {
          circleId: circle.id,
          userId: user.id,
          donationId: donation.id,
          kind: 'DONATION',
          amount: donation.amount,
          currency: donation.currency,
          note: dto.note,
        },
      });
      return { contribution };
    }

    // Pledge path: no money moved, amount is the stated intent.
    if (dto.kind === 'DONATION') {
      throw new BadRequestException('A donationRef of a succeeded donation is required for DONATION contributions');
    }

    const contribution = await this.prisma.circleContribution.create({
      data: {
        circleId: circle.id,
        userId: user.id,
        kind: 'PLEDGE',
        amount: BigInt(dto.amountMinor),
        currency: circle.currency,
        note: dto.note,
      },
    });
    return { contribution };
  }

  async leaderboard(slug: string, user: AuthenticatedUser | null) {
    const circle = await this.prisma.circle.findUnique({
      where: { slug },
      include: { members: { select: { userId: true } } },
    });
    if (!circle) throw new NotFoundException('Circle not found');
    this.assertCircleVisible(circle, user);

    const rows = await this.prisma.circleContribution.groupBy({
      by: ['userId'],
      where: { circleId: circle.id, currency: circle.currency },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, firstName: true, lastName: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    return rows.map((r) => ({
      user: byId.get(r.userId) ?? null,
      total: r._sum.amount ?? 0n,
      contributions: r._count._all,
    }));
  }

  private assertCircleVisible(
    circle: { privacy: CirclePrivacy; members: { userId: string }[] },
    user: AuthenticatedUser | null,
  ) {
    if (circle.privacy !== CirclePrivacy.PRIVATE) return;
    const isMember = user ? circle.members.some((m) => m.userId === user.id) : false;
    if (!isMember && user?.role !== 'ADMIN') throw new NotFoundException('Circle not found');
  }
}
