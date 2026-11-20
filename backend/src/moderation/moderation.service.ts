import { Injectable, NotFoundException } from '@nestjs/common';
import type { FraudStatus, ModerationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CreateReportDto, ResolveCaseDto } from './dto/moderation.dto';

@Injectable()
export class ModerationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Any authenticated user can report any entity. */
  async report(dto: CreateReportDto, userId: string) {
    const moderationCase = await this.prisma.moderationCase.create({
      data: {
        entityType: dto.entityType,
        entityId: dto.entityId,
        reason: 'USER_REPORT',
        status: 'OPEN',
        reporterUserId: userId,
        description: dto.description,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'REPORT_SUBMITTED',
        entityType: dto.entityType,
        entityId: dto.entityId,
        metadata: { caseId: moderationCase.id },
      },
    });

    return { reported: true };
  }

  async listCases(status: string | undefined, skip: number, limit: number) {
    const where: Prisma.ModerationCaseWhereInput = status ? { status: status as ModerationStatus } : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.moderationCase.count({ where }),
      this.prisma.moderationCase.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    // ModerationCase stores reporter/assignee as plain ids (no relation), so
    // resolve reporter names manually where present.
    const reporterIds = [...new Set(items.map((c) => c.reporterUserId).filter((id): id is string => !!id))];
    const reporters = reporterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: reporterIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const names = new Map(reporters.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));

    return {
      total,
      items: items.map((c) => ({ ...c, reporterName: c.reporterUserId ? (names.get(c.reporterUserId) ?? null) : null })),
    };
  }

  async resolveCase(caseId: string, dto: ResolveCaseDto, admin: { id: string }) {
    const moderationCase = await this.prisma.moderationCase.findUnique({ where: { id: caseId } });
    if (!moderationCase) throw new NotFoundException('Moderation case not found');

    const resolvedStatus: ModerationStatus = dto.action === 'action' ? 'RESOLVED_ACTIONED' : 'RESOLVED_CLEARED';
    const suspendCampaign = dto.action === 'action' && moderationCase.entityType === 'CAMPAIGN';

    if (suspendCampaign) {
      // Suspension + audit trail + case resolution persist atomically.
      await this.prisma.$transaction([
        this.prisma.campaign.updateMany({
          where: { id: moderationCase.entityId },
          data: { status: 'SUSPENDED' },
        }),
        this.prisma.auditLog.create({
          data: {
            actorUserId: admin.id,
            action: 'CAMPAIGN_SUSPENDED',
            entityType: 'CAMPAIGN',
            entityId: moderationCase.entityId,
            metadata: { caseId: moderationCase.id, note: dto.note },
          },
        }),
      ]);
    }

    await this.prisma.moderationCase.update({
      where: { id: moderationCase.id },
      data: {
        status: resolvedStatus,
        resolutionNote: dto.note,
        resolvedAt: new Date(),
        assignedToId: admin.id,
      },
    });

    return { resolved: true };
  }

  async listFraudSignals(status: string | undefined, skip: number, limit: number) {
    const where: Prisma.FraudSignalWhereInput = {
      status: (status as FraudStatus | undefined) ?? 'OPEN',
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.fraudSignal.count({ where }),
      this.prisma.fraudSignal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { campaign: { select: { title: true, slug: true } } },
      }),
    ]);
    return { total, items };
  }

  async dismissFraudSignal(id: string, admin: { id: string }) {
    const signal = await this.prisma.fraudSignal.findUnique({ where: { id }, select: { id: true } });
    if (!signal) throw new NotFoundException('Fraud signal not found');

    await this.prisma.fraudSignal.update({
      where: { id },
      data: { status: 'DISMISSED', reviewedById: admin.id, reviewedAt: new Date() },
    });
    return { dismissed: true };
  }
}
