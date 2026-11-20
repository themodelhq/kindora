import * as bcrypt from 'bcryptjs';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';

/**
 * Unit tests for the auth service (no database, no HTTP).
 * PrismaService, JwtService, ConfigService and QueueService are jest.fn()
 * shells; bcryptjs runs for real so password verification is exercised.
 */

const PASSWORD = 'Correct-Passw0rd';

type PrismaAuthMock = {
  user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  session: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  authToken: { create: jest.Mock; findUnique: jest.Mock };
  auditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};

type JwtMock = JwtService & { signAsync: jest.Mock };
type QueueMock = QueueService & { enqueue: jest.Mock };

function makeService() {
  const prisma: PrismaAuthMock = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    session: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    authToken: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  const jwtService = { signAsync: jest.fn().mockResolvedValue('signed-access-token') } as unknown as JwtMock;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  const queue = { enqueue: jest.fn().mockResolvedValue(null) } as unknown as QueueMock;
  const service = new AuthService(prisma as unknown as PrismaService, jwtService, config, queue);
  return { service, prisma, jwtService, queue };
}

describe('AuthService.register', () => {
  it('rejects duplicate emails with BadRequestException and creates nothing', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u-existing', email: 'taken@kindora.test' });

    await expect(
      service.register('taken@kindora.test', 'LongEnough1', 'Ada', 'Obi'),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('normalises the email before the uniqueness lookup', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u-existing' });
    await expect(service.register('  Mixed@Kindora.Test  ', 'LongEnough1', 'A', 'B')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'mixed@kindora.test' } });
  });
});

describe('AuthService.login', () => {
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 12);
  });

  it('rejects a wrong password with UnauthorizedException and issues nothing', async () => {
    const { service, prisma, jwtService, queue } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'donor@kindora.test',
      status: 'ACTIVE',
      passwordHash,
    });

    await expect(
      service.login('donor@kindora.test', 'WrongPassword1', { userAgent: 'jest' }),
    ).rejects.toThrow(UnauthorizedException);

    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects unknown users and deleted accounts with a generic message (no enumeration)', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.login('ghost@kindora.test', 'Whatever-1', {})).rejects.toThrow(
      'Invalid email or password',
    );

    prisma.user.findUnique.mockResolvedValue({ id: 'u2', status: 'DELETED', passwordHash });
    await expect(service.login('deleted@kindora.test', 'Whatever-1', {})).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('issues an access token + opaque refresh token and creates a session on success', async () => {
    const { service, prisma, jwtService } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'donor@kindora.test',
      status: 'ACTIVE',
      passwordHash,
    });
    prisma.session.create.mockResolvedValue({ id: 's1' });

    const tokens = await service.login('donor@kindora.test', PASSWORD, { userAgent: 'jest', ip: '127.0.0.1' });

    expect(tokens.accessToken).toBe('signed-access-token');
    expect(tokens.refreshToken).toMatch(/^[0-9a-f]{96}$/); // randomToken(48)
    expect(tokens.expiresIn).toBe(900); // default access TTL
    expect(jwtService.signAsync).toHaveBeenCalledWith({ sub: 'u1', email: 'donor@kindora.test' }, { expiresIn: 900 });
    expect(prisma.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: expect.any(Date),
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'AUTH_LOGIN', actorUserId: 'u1' }),
    });
  });
});

describe('AuthService.refresh (reuse detection)', () => {
  it('rejects a revoked token with UnauthorizedException and revokes ALL user sessions', async () => {
    const { service, prisma } = makeService();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      revokedAt: new Date('2026-01-01T00:00:00Z'), // reuse of a rotated token
      expiresAt: new Date(Date.now() + 86400000),
    });

    await expect(service.refresh('stolen-refresh-token', {})).rejects.toThrow(UnauthorizedException);

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'AUTH_REFRESH_REUSE_DETECTED', actorUserId: 'u1' }),
    });
    expect(prisma.session.update).not.toHaveBeenCalled(); // no rotation happened
  });

  it('rejects tokens that are not in the database', async () => {
    const { service, prisma } = makeService();
    prisma.session.findUnique.mockResolvedValue(null);
    await expect(service.refresh('unknown-token', {})).rejects.toThrow('Invalid refresh token');
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('rejects expired (non-revoked) sessions without revoking the family', async () => {
    const { service, prisma } = makeService();
    prisma.session.findUnique.mockResolvedValue({
      id: 's2',
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(service.refresh('expired-token', {})).rejects.toThrow('Session expired');
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });
});

describe('AuthService.forgotPassword', () => {
  it('never throws for an unknown email (enumeration safety) and sends nothing', async () => {
    const { service, prisma, queue } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.forgotPassword('ghost@kindora.test')).resolves.toEqual({ ok: true });

    expect(prisma.authToken.create).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('creates a PASSWORD_RESET token and queues the email for a known user', async () => {
    const { service, prisma, queue } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'donor@kindora.test' });

    await expect(service.forgotPassword('donor@kindora.test')).resolves.toEqual({ ok: true });

    expect(prisma.authToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', purpose: 'PASSWORD_RESET', tokenHash: expect.any(String) }),
    });
    expect(queue.enqueue).toHaveBeenCalledWith(
      'email',
      'email.password-reset',
      expect.objectContaining({ email: 'donor@kindora.test', userId: 'u1' }),
    );
  });
});

describe('AuthService.logout', () => {
  it('revokes the session matching the raw refresh token', async () => {
    const { service, prisma } = makeService();
    await service.logout('some-refresh-token');
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('is a no-op without a token', async () => {
    const { service, prisma } = makeService();
    await service.logout(undefined);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });
});
