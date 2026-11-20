import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MfaCredentialStatus } from '@prisma/client';
import { MfaService, MfaPurpose } from './mfa.service';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { base32Decode, base32Encode, hotp } from './totp.util';

/**
 * Unit tests for the fresh-MFA service (v1.0.4 §7). Real TOTP math, mocked
 * storage: challenges MUST be single-use, purpose- and scope-bound, and the
 * service MUST fail closed when Redis is unavailable.
 */

type PrismaMfaMock = {
  mfaCredential: { findUnique: jest.Mock; upsert: jest.Mock; update: jest.Mock };
  auditLog: { create: jest.Mock };
};

type RedisMock = {
  isAvailable: jest.Mock;
  set: jest.Mock;
  get: jest.Mock;
  consume: jest.Mock;
  acquireLock: jest.Mock;
};

/** In-memory Redis double with GETDEL + SET-NX semantics. */
function makeRedis(): RedisMock {
  const store = new Map<string, string>();
  return {
    isAvailable: jest.fn(() => true),
    set: jest.fn(async (key: string, value: string, _ttl?: number) => {
      store.set(key, value);
      return true;
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    consume: jest.fn(async (key: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      store.delete(key);
      return v;
    }),
    acquireLock: jest.fn(async (key: string) => {
      if (store.has(key)) return null;
      store.set(key, 'owner');
      return 'owner';
    }),
  };
}

function makeService(overrides?: { prisma?: Partial<PrismaMfaMock>; redis?: RedisMock; config?: Record<string, string> }) {
  const prisma: PrismaMfaMock = {
    mfaCredential: {
      findUnique: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    ...(overrides?.prisma ?? {}),
  };
  const redis = overrides?.redis ?? makeRedis();
  const configMap: Record<string, string> = { 'jwt.secret': 'unit-test-jwt-secret', ...(overrides?.config ?? {}) };
  const configGet = (key: string) => configMap[key];
  const service = new MfaService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    { get: jest.fn(configGet) } as unknown as ConfigService,
  );
  return { service, prisma, redis };
}

/** RFC 4648 base32 secret (what an authenticator app would display). */
const MFA_SECRET_B32 = base32Encode(Buffer.from('test-secret-ascii', 'utf8'));

/** Real TOTP code computed the way authenticator apps do: over the base32-DECODED key bytes. */
function codeFor(secretEnc: string, secretPlain: string, offset = 0): string {
  void secretEnc;
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30)) + BigInt(offset);
  return hotp(base32Decode(secretPlain), counter);
}

const ACTIVE_CRED = { userId: 'admin-1', secretEnc: '', status: MfaCredentialStatus.ACTIVE, lastUsedAt: null };

describe('MFA challenge lifecycle (fail-closed, single-use, scope-bound)', () => {
  it('issues a challenge bound to user+purpose+scope and consumes it exactly once', async () => {
    const { service, prisma, redis } = makeService();
    // Encrypt a real secret through the service itself so decryptSecret works.
    prisma.mfaCredential.findUnique.mockResolvedValue({
      ...ACTIVE_CRED,
      secretEnc: encryptVia(service, MFA_SECRET_B32),
    });
    const { challengeToken } = await service.issueChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, codeFor('', MFA_SECRET_B32), 'wd-1');

    const first = await service.consumeChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, 'wd-1', challengeToken);
    expect(first.fresh).toBe(true);

    // Second consumption MUST fail (single use): the challenge is gone from
    // storage, so the token is "invalid or expired" for any further use.
    await expect(
      service.consumeChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, 'wd-1', challengeToken),
    ).rejects.toThrow(ForbiddenException);
    expect(redis.consume).toHaveBeenCalledTimes(1);
  });

  it('rejects a challenge issued for a different purpose', async () => {
    const { service, prisma } = makeService();
    prisma.mfaCredential.findUnique.mockResolvedValue({
      ...ACTIVE_CRED,
      secretEnc: encryptVia(service, MFA_SECRET_B32),
    });
    const { challengeToken } = await service.issueChallenge('admin-1', MfaPurpose.PAYOUT_FIRST_APPROVAL, codeFor('', MFA_SECRET_B32), 'wd-1');
    await expect(
      service.consumeChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, 'wd-1', challengeToken),
    ).rejects.toThrow(/purpose mismatch/);
  });

  it('rejects a challenge whose scope does not match the target resource', async () => {
    const { service, prisma } = makeService();
    prisma.mfaCredential.findUnique.mockResolvedValue({
      ...ACTIVE_CRED,
      secretEnc: encryptVia(service, MFA_SECRET_B32),
    });
    const { challengeToken } = await service.issueChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, codeFor('', MFA_SECRET_B32), 'wd-1');
    await expect(
      service.consumeChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, 'wd-other', challengeToken),
    ).rejects.toThrow(/scope does not match/);
  });

  it('rejects a challenge that belongs to another user', async () => {
    const { service, prisma } = makeService();
    prisma.mfaCredential.findUnique.mockResolvedValue({
      ...ACTIVE_CRED,
      secretEnc: encryptVia(service, MFA_SECRET_B32),
    });
    const { challengeToken } = await service.issueChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, codeFor('', MFA_SECRET_B32), 'wd-1');
    await expect(
      service.consumeChallenge('admin-2', MfaPurpose.PAYOUT_SETTLEMENT, 'wd-1', challengeToken),
    ).rejects.toThrow(/does not belong/);
  });

  it('FAILS CLOSED when Redis is unavailable (challenge issuance and consumption)', async () => {
    const { service, prisma, redis } = makeService();
    redis.isAvailable.mockReturnValue(false);
    prisma.mfaCredential.findUnique.mockResolvedValue({
      ...ACTIVE_CRED,
      secretEnc: encryptVia(service, MFA_SECRET_B32),
    });
    await expect(
      service.issueChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, codeFor('', MFA_SECRET_B32), 'wd-1'),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      service.consumeChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, 'wd-1', 'a'.repeat(32)),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('rejects TOTP replay: one code cannot mint two challenges within the same step', async () => {
    const { service, prisma, redis } = makeService();
    prisma.mfaCredential.findUnique.mockResolvedValue({
      ...ACTIVE_CRED,
      secretEnc: encryptVia(service, MFA_SECRET_B32),
    });
    const code = codeFor('', MFA_SECRET_B32);
    await service.issueChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, code, 'wd-1');
    await expect(
      service.issueChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, code, 'wd-2'),
    ).rejects.toThrow(/already been used/);
    expect(redis.set).toHaveBeenCalled();
  });

  it('rejects a wrong TOTP code and an inactive credential', async () => {
    const { service, prisma } = makeService();
    prisma.mfaCredential.findUnique.mockResolvedValue({
      ...ACTIVE_CRED,
      secretEnc: encryptVia(service, MFA_SECRET_B32),
    });
    await expect(
      service.issueChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, '000000', 'wd-1'),
    ).rejects.toThrow(/Invalid or expired MFA code/);

    prisma.mfaCredential.findUnique.mockResolvedValue({ userId: 'admin-1', status: MfaCredentialStatus.ENROLLING, secretEnc: '' });
    await expect(
      service.issueChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, codeFor('', MFA_SECRET_B32), 'wd-1'),
    ).rejects.toThrow(/Fresh MFA is required|not active|enroll/);
  });

  it('refuses consumption of structurally invalid tokens without touching Redis', async () => {
    const { service, redis } = makeService();
    await expect(service.consumeChallenge('admin-1', MfaPurpose.PAYOUT_SETTLEMENT, null, 'short')).rejects.toThrow(ForbiddenException);
    expect(redis.isAvailable).not.toHaveBeenCalled();
  });
});

/** Helper: exercise the real encryption path to produce a decryptable record. */
function encryptVia(service: MfaService, secret: string): string {
  // encryptSecret is private; access it through enroll() with mocked upsert
  // is awkward in unit scope, so reflectively call the private method.
  const anyService = service as unknown as { encryptSecret: (s: string) => string };
  return anyService.encryptSecret(secret);
}
