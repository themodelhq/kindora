import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { KycLevel, KycStatus, OrgMemberRole, Prisma, PayoutMethodType } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { slugify } from '../common/utils/slug.util';
import { PaginationDto } from '../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  AddOrganizationMemberDto,
  CreateOrganizationDto,
  CreatePayoutMethodDto,
  UpdateOrganizationDto,
} from './dto/create-organization.dto';

const PUBLIC_CAMPAIGN_STATUSES = ['ACTIVE', 'COMPLETED', 'PAUSED'] as const;

const ORG_LIST_INCLUDE = {
  owner: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { members: true, campaigns: true } },
} satisfies Prisma.OrganizationInclude;

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateOrganizationDto, user: AuthenticatedUser) {
    const organization = await this.prisma.organization.create({
      data: {
        slug: slugify(dto.name),
        name: dto.name,
        description: dto.description,
        website: dto.website,
        country: dto.country,
        registrationNumber: dto.registrationNumber,
        status: 'PENDING',
        ownerUserId: user.id,
        members: { create: { userId: user.id, role: OrgMemberRole.OWNER } },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'ORG_CREATED',
        entityType: 'ORGANIZATION',
        entityId: organization.id,
        metadata: {
          organization: {
            id: organization.id,
            slug: organization.slug,
            name: organization.name,
            status: organization.status,
          },
        },
      },
    });

    return organization;
  }

  /**
   * Public directory: VERIFIED organizations rank first, all others follow.
   * Pagination slices across both groups deterministically.
   */
  async listPublic(pagination: PaginationDto) {
    const search = pagination.q ? { name: { contains: pagination.q, mode: 'insensitive' as const } } : {};
    const verifiedWhere: Prisma.OrganizationWhereInput = { status: 'VERIFIED', ...search };
    const othersWhere: Prisma.OrganizationWhereInput = { status: { not: 'VERIFIED' }, ...search };

    const [verifiedTotal, othersTotal] = await this.prisma.$transaction([
      this.prisma.organization.count({ where: verifiedWhere }),
      this.prisma.organization.count({ where: othersWhere }),
    ]);

    const skip = pagination.skip;
    const take = pagination.limit;
    const verifiedTake = Math.min(take, Math.max(0, verifiedTotal - skip));

    const [verifiedItems, othersItems] = await Promise.all([
      verifiedTake > 0
        ? this.prisma.organization.findMany({
            where: verifiedWhere,
            orderBy: { createdAt: 'desc' },
            skip,
            take: verifiedTake,
            include: ORG_LIST_INCLUDE,
          })
        : Promise.resolve([]),
      take - verifiedTake > 0
        ? this.prisma.organization.findMany({
            where: othersWhere,
            orderBy: { createdAt: 'desc' },
            skip: Math.max(0, skip - verifiedTotal),
            take: take - verifiedTake,
            include: ORG_LIST_INCLUDE,
          })
        : Promise.resolve([]),
    ]);

    return { total: verifiedTotal + othersTotal, items: [...verifiedItems, ...othersItems] };
  }

  /** Organizations the caller owns or belongs to, with the caller's member role. */
  async listMine(user: AuthenticatedUser) {
    const orgs = await this.prisma.organization.findMany({
      where: {
        OR: [{ ownerUserId: user.id }, { members: { some: { userId: user.id } } }],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        members: { where: { userId: user.id }, select: { role: true } },
        _count: { select: { members: true } },
      },
    });
    return orgs.map((org) => ({
      ...org,
      role: org.members[0]?.role ?? (org.ownerUserId === user.id ? OrgMemberRole.OWNER : null),
      members: undefined,
    }));
  }

  /**
   * Public detail page for VERIFIED organizations. Non-verified organizations
   * (PENDING/REJECTED/SUSPENDED) are only visible to their members or an admin.
   */
  async getBySlug(slug: string, user: AuthenticatedUser | null) {
    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true } },
        members: {
          orderBy: { joinedAt: 'asc' },
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
    });
    if (!organization) throw new NotFoundException('Organization not found');

    if (organization.status !== 'VERIFIED') {
      const isMember = user ? organization.members.some((m) => m.userId === user.id) : false;
      const isAdmin = user?.role === 'ADMIN';
      if (!isMember && !isAdmin) throw new NotFoundException('Organization not found');
    }

    const campaigns = await this.prisma.campaign.findMany({
      where: { organizationId: organization.id, status: { in: [...PUBLIC_CAMPAIGN_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        slug: true,
        title: true,
        excerpt: true,
        coverImageUrl: true,
        status: true,
        targetAmount: true,
        raisedAmount: true,
        donorCount: true,
        currency: true,
        createdAt: true,
      },
    });

    return { ...organization, campaigns };
  }

  async update(id: string, dto: UpdateOrganizationDto, user: AuthenticatedUser) {
    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) throw new NotFoundException('Organization not found');
    this.assertCanManage(organization, user);

    const updated = await this.prisma.organization.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.website !== undefined ? { website: dto.website } : {}),
        ...(dto.country !== undefined ? { country: dto.country } : {}),
        ...(dto.registrationNumber !== undefined ? { registrationNumber: dto.registrationNumber } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
      },
    });
    return updated;
  }

  async addMember(id: string, dto: AddOrganizationMemberDto, user: AuthenticatedUser) {
    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) throw new NotFoundException('Organization not found');
    this.assertCanManage(organization, user);

    const target = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!target) throw new NotFoundException('User with that email was not found');

    const existing = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: id, userId: target.id } },
    });

    // Upsert, but never downgrade an existing OWNER.
    const member = existing
      ? existing.role === OrgMemberRole.OWNER
        ? existing
        : await this.prisma.organizationMember.update({ where: { id: existing.id }, data: { role: dto.role } })
      : await this.prisma.organizationMember.create({
          data: { organizationId: id, userId: target.id, role: dto.role },
        });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'ORG_MEMBER_UPSERTED',
        entityType: 'ORGANIZATION',
        entityId: id,
        metadata: { memberUserId: target.id, role: member.role },
      },
    });

    return { member };
  }

  /** Removes a member. The caller cannot remove themselves, and the owner can never be removed. */
  async removeMember(id: string, targetUserId: string, user: AuthenticatedUser) {
    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) throw new NotFoundException('Organization not found');
    this.assertCanManage(organization, user);

    if (targetUserId === user.id) throw new BadRequestException('You cannot remove yourself from the organization');
    if (targetUserId === organization.ownerUserId) throw new BadRequestException('The organization owner cannot be removed');

    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: id, userId: targetUserId } },
    });
    if (!membership) throw new NotFoundException('That user is not a member of this organization');

    await this.prisma.organizationMember.delete({ where: { id: membership.id } });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'ORG_MEMBER_REMOVED',
        entityType: 'ORGANIZATION',
        entityId: id,
        metadata: { removedUserId: targetUserId },
      },
    });

    return { removed: true };
  }

  /** Owner files a KYC verification request for the organization (reviewed by admins). */
  async requestVerification(id: string, user: AuthenticatedUser) {
    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) throw new NotFoundException('Organization not found');
    if (organization.ownerUserId !== user.id) {
      throw new ForbiddenException('Only the organization owner can request verification');
    }
    if (organization.status === 'VERIFIED') {
      throw new BadRequestException('Organization is already verified');
    }

    const pending = await this.prisma.kycRecord.findFirst({
      where: { organizationId: id, status: KycStatus.PENDING },
      select: { id: true },
    });
    if (pending) throw new BadRequestException('A verification request is already pending for this organization');

    const [kycRecord] = await this.prisma.$transaction([
      this.prisma.kycRecord.create({
        data: {
          organizationId: organization.id,
          level: KycLevel.VERIFIED,
          legalName: organization.name,
          status: KycStatus.PENDING,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'ORG_VERIFICATION_REQUESTED',
          entityType: 'ORGANIZATION',
          entityId: organization.id,
          metadata: { organizationId: organization.id, organizationName: organization.name },
        },
      }),
    ]);

    return { kycRecord };
  }

  async listPayoutMethods(id: string, user: AuthenticatedUser) {
    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) throw new NotFoundException('Organization not found');
    this.assertCanManage(organization, user);

    return this.prisma.payoutMethod.findMany({
      where: { organizationId: id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createPayoutMethod(id: string, dto: CreatePayoutMethodDto, user: AuthenticatedUser) {
    const organization = await this.prisma.organization.findUnique({ where: { id } });
    if (!organization) throw new NotFoundException('Organization not found');
    if (organization.ownerUserId !== user.id) {
      throw new ForbiddenException('Only the organization owner can add payout methods');
    }

    const payoutMethod = await this.prisma.payoutMethod.create({
      data: {
        organizationId: id,
        type: dto.type as PayoutMethodType,
        details: {
          accountName: dto.accountName,
          accountNumber: dto.accountNumber,
          ...(dto.bankName ? { bankName: dto.bankName } : {}),
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'ORG_PAYOUT_METHOD_ADDED',
        entityType: 'ORGANIZATION',
        entityId: id,
        metadata: { payoutMethodId: payoutMethod.id, type: payoutMethod.type },
      },
    });

    return payoutMethod;
  }

  private assertCanManage(organization: { ownerUserId: string }, user: { id: string; role: string }) {
    if (organization.ownerUserId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the organization owner or an admin can manage it');
    }
  }
}
