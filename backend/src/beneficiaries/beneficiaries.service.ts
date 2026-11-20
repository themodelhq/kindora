import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CreateBeneficiaryDto, UpdateBeneficiaryDto } from './dto/beneficiaries.dto';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class BeneficiariesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateBeneficiaryDto, userId: string) {
    if (dto.organizationId) {
      const organization = await this.prisma.organization.findUnique({
        where: { id: dto.organizationId },
        select: { id: true },
      });
      if (!organization) throw new NotFoundException('Organization not found');
      const membership = await this.prisma.organizationMember.findFirst({
        where: { organizationId: dto.organizationId, userId },
        select: { id: true },
      });
      if (!membership) throw new ForbiddenException('You are not a member of this organization');
    }

    return this.prisma.beneficiary.create({
      data: {
        name: dto.name,
        type: dto.type,
        description: dto.description,
        organizationId: dto.organizationId,
        // Individual beneficiaries are personally guarded by their creator;
        // org/community ones are guarded via the organization instead.
        guardianUserId: dto.type === 'INDIVIDUAL' ? userId : null,
      },
    });
  }

  /** Beneficiaries the user guards personally plus all beneficiaries of their organizations. */
  async listMine(userId: string, skip: number, limit: number) {
    const orgIds = (
      await this.prisma.organizationMember.findMany({
        where: { userId },
        select: { organizationId: true },
      })
    ).map((m) => m.organizationId);

    const where: Prisma.BeneficiaryWhereInput = {
      OR: [
        { guardianUserId: userId },
        ...(orgIds.length ? [{ organizationId: { in: orgIds } }] : []),
      ],
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.beneficiary.count({ where }),
      this.prisma.beneficiary.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { organization: { select: { slug: true, name: true } } },
      }),
    ]);
    return { total, items };
  }

  /** Only the guardian of an individual beneficiary, a member of the owning organization, or an admin may edit. */
  async update(id: string, dto: UpdateBeneficiaryDto, user: AuthenticatedUser) {
    const beneficiary = await this.prisma.beneficiary.findUnique({
      where: { id },
      select: { id: true, guardianUserId: true, organizationId: true },
    });
    if (!beneficiary) throw new NotFoundException('Beneficiary not found');

    const isGuardian = beneficiary.guardianUserId === user.id;
    const isOrgMember = beneficiary.organizationId
      ? await this.prisma.organizationMember.findFirst({
          where: { organizationId: beneficiary.organizationId, userId: user.id },
          select: { id: true },
        })
      : null;
    if (!isGuardian && !isOrgMember && user.role !== 'ADMIN') {
      throw new ForbiddenException('You do not manage this beneficiary');
    }

    return this.prisma.beneficiary.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
      },
    });
  }
}
