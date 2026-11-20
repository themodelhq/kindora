import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma.service';
import { ChangePasswordDto, SubmitKycDto, UpdateNotificationPrefsDto, UpdateProfileDto, PushSubscriptionDto } from './dto/user.dto';

const BCRYPT_ROUNDS = 12;

const SAFE_PROFILE_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  phone: true,
  country: true,
  locale: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Profile fields safe to expose back to the authenticated owner. */
  safeProfileSelect() {
    return SAFE_PROFILE_SELECT;
  }

  private async requireUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SAFE_PROFILE_SELECT,
    });
    if (!user) throw new UnauthorizedException('Account not found');
    return user;
  }

  async getProfile(userId: string) {
    const [profile, notificationPreference] = await Promise.all([
      this.requireUser(userId),
      this.ensurePreferences(userId),
    ]);
    return { ...profile, notificationPreference };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const data: Prisma.UserUpdateInput = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;

    await this.prisma.user.update({ where: { id: userId }, data });
    return this.getProfile(userId);
  }

  async ensurePreferences(userId: string) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  async getPreferences(userId: string) {
    return this.ensurePreferences(userId);
  }

  async updatePreferences(userId: string, dto: UpdateNotificationPrefsDto) {
    const data: Prisma.NotificationPreferenceUpdateInput = {};
    if (dto.emailDonations !== undefined) data.emailDonations = dto.emailDonations;
    if (dto.emailUpdates !== undefined) data.emailUpdates = dto.emailUpdates;
    if (dto.emailMarketing !== undefined) data.emailMarketing = dto.emailMarketing;
    if (dto.emailSecurity !== undefined) data.emailSecurity = dto.emailSecurity;
    if (dto.pushEnabled !== undefined) data.pushEnabled = dto.pushEnabled;
    if (dto.smsEnabled !== undefined) data.smsEnabled = dto.smsEnabled;

    return this.prisma.notificationPreference.upsert({
      where: { userId },
      update: data,
      create: { userId },
    });
  }

  async listNotifications(userId: string, skip: number, limit: number) {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return { total, items };
  }

  /** Marks every unread notification of the user as read (updateMany on readAt). */
  async markAllNotificationsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  /** Verifies the current password (bcryptjs), rotates the hash and revokes every session. */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS) },
      }),
      // Password change invalidates every active session, including this one.
      this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'AUTH_PASSWORD_CHANGED',
          entityType: 'USER',
          entityId: userId,
        },
      }),
    ]);
    return { changed: true };
  }

  /** Submits a BASIC-level identity verification record for review.
   *
   * Document fields must be storage KEYS from this account's own uploads
   * (document/<userId>/...), registered in the StoredFile registry. Arbitrary
   * URLs or other users' keys are rejected — an attacker cannot make an admin
   * review console fetch arbitrary or third-party content.
   */
  async submitKyc(userId: string, dto: SubmitKycDto) {
    const docKeys: string[] = [];
    for (const raw of [dto.idDocumentUrl, dto.selfieUrl, dto.addressDocumentUrl]) {
      if (!raw) continue;
      const key = raw.replace(/^\/+/, '');
      const allowedPrefix = [`document/${userId}/`, `identity/${userId}/`, `expense-evidence/${userId}/`];
      if (!allowedPrefix.some((p) => key.startsWith(p))) {
        throw new BadRequestException('KYC documents must be storage keys from your own uploads (document/<your-id>/...)');
      }
      const file = await this.prisma.storedFile.findUnique({ where: { key } });
      if (!file || file.uploaderId !== userId) {
        throw new BadRequestException('KYC document was not found among your uploads — upload it through /storage/uploads first');
      }
      docKeys.push(key);
    }

    const record = await this.prisma.kycRecord.create({
      data: {
        userId,
        level: dto.level ?? 'BASIC',
        status: 'PENDING',
        legalName: dto.legalName,
        idType: dto.idType,
        idNumberLast4: dto.idNumberLast4,
        idDocumentUrl: dto.idDocumentUrl,
        selfieUrl: dto.selfieUrl,
        addressDocumentUrl: dto.addressDocumentUrl,
        country: dto.country,
      },
    });

    // Link the submitted files to the KYC record (ownership metadata stays intact).
    if (docKeys.length > 0) {
      await this.prisma.storedFile.updateMany({ where: { key: { in: docKeys }, uploaderId: userId }, data: { kycRecordId: record.id } });
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'KYC_SUBMITTED',
        entityType: 'KYC_RECORD',
        entityId: record.id,
        metadata: { level: record.level } as Prisma.InputJsonValue,
      },
    });
    return record;
  }

  async listKyc(userId: string) {
    return this.prisma.kycRecord.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, ip: true, createdAt: true, expiresAt: true, revokedAt: true },
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Session not found');
    return { revoked: true };
  }

  async upsertPushSubscription(userId: string, dto: PushSubscriptionDto) {
    return this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      update: {
        userId,
        p256dh: dto.p256dh,
        auth: dto.auth,
        userAgent: dto.userAgent,
      },
      create: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.p256dh,
        auth: dto.auth,
        userAgent: dto.userAgent,
      },
    });
  }
}
