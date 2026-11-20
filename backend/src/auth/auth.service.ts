import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { hashToken, randomToken } from '../common/utils/crypto.util';
import { QueueService } from '../common/queue.service';
import { Prisma } from '@prisma/client';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly queue: QueueService,
  ) {}

  async register(email: string, password: string, firstName: string, lastName: string, ip?: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) throw new BadRequestException('An account with this email already exists');

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        notificationPreference: { create: {} },
      },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, emailVerifiedAt: true, createdAt: true },
    });

    await this.issueEmailVerification(user.id, normalizedEmail);
    await this.prisma.auditLog.create({
      data: { actorUserId: user.id, action: 'AUTH_REGISTER', entityType: 'USER', entityId: user.id, ip },
    });

    return user;
  }

  async login(email: string, password: string, meta: { userAgent?: string; ip?: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.status === 'DELETED') throw new UnauthorizedException('Invalid email or password');
    if (user.status === 'SUSPENDED') throw new UnauthorizedException('Account suspended. Contact support.');
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    const tokens = await this.issueTokens(user.id, user.email, meta);
    await this.prisma.auditLog.create({
      data: { actorUserId: user.id, action: 'AUTH_LOGIN', entityType: 'USER', entityId: user.id, ip: meta.ip },
    });
    return tokens;
  }

  async issueTokens(userId: string, email: string, meta: { userAgent?: string; ip?: string }): Promise<TokenPair> {
    const accessTtl = this.config.get<number>('jwt.accessTtlSeconds') ?? 900;
    const accessToken = await this.jwtService.signAsync(
      { sub: userId, email },
      { expiresIn: accessTtl },
    );
    const refreshToken = randomToken(48);
    const ttlDays = this.config.get<number>('jwt.refreshTtlDays') ?? 30;
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        userAgent: meta.userAgent?.slice(0, 250),
        ip: meta.ip,
        expiresAt: new Date(Date.now() + ttlDays * 24 * 3600 * 1000),
      },
    });
    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  /** Refresh-token rotation with reuse detection. */
  async refresh(rawRefreshToken: string, meta: { userAgent?: string; ip?: string }): Promise<TokenPair> {
    const tokenHash = hashToken(rawRefreshToken);
    const session = await this.prisma.session.findUnique({ where: { tokenHash } });
    if (!session) throw new UnauthorizedException('Invalid refresh token');

    if (session.revokedAt) {
      // Token reuse detected -> revoke the whole family for this user.
      await this.prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.prisma.auditLog.create({
        data: { actorUserId: session.userId, action: 'AUTH_REFRESH_REUSE_DETECTED', entityType: 'USER', entityId: session.userId },
      });
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    if (session.expiresAt < new Date()) throw new UnauthorizedException('Session expired. Please sign in again.');

    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account unavailable');

    const tokens = await this.issueTokens(user.id, user.email, meta);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    return tokens;
  }

  async logout(rawRefreshToken: string | undefined) {
    if (!rawRefreshToken) return;
    await this.prisma.session.updateMany({
      where: { tokenHash: hashToken(rawRefreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async issueEmailVerification(userId: string, email: string) {
    const token = randomToken(24);
    await this.prisma.authToken.create({
      data: {
        userId,
        purpose: 'VERIFY_EMAIL',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    await this.queue.enqueue('email', 'email.verify-email', { email, userId, token, name: '' });
  }

  async verifyEmail(token: string) {
    const record = await this.prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.purpose !== 'VERIFY_EMAIL' || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Verification link is invalid or expired');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
      this.prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    return { verified: true };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Always report success to avoid account enumeration.
    if (user) {
      const token = randomToken(24);
      await this.prisma.authToken.create({
        data: {
          userId: user.id,
          purpose: 'PASSWORD_RESET',
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 3600 * 1000),
        },
      });
      await this.queue.enqueue('email', 'email.password-reset', { email: user.email, userId: user.id, token });
    }
    return { ok: true };
  }

  async resetPassword(token: string, newPassword: string) {
    const record = await this.prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.purpose !== 'PASSWORD_RESET' || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Reset link is invalid or expired');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
      }),
      this.prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.prisma.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { ok: true };
  }

  hashPassword(password: string) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  /**
   * TEST-ONLY: completes email verification without the email round-trip.
   * Available exclusively when PROVIDER_MODE=mock (automated tests / offline
   * demo). Hard-blocked in any live configuration.
   */
  async devCompleteVerification(email: string) {
    if ((this.config.get<string>('providerMode') ?? 'live') !== 'mock') {
      throw new ForbiddenException('Not available outside mock mode');
    }
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) throw new BadRequestException('User not found');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
    return { verified: true };
  }
}
