import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { MfaCredentialStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { randomToken } from '../common/utils/crypto.util';
import { base32Decode, generateTotpSecret, totpProvisioningUri, totpVerify } from './totp.util';

/**
 * Fresh MFA for sensitive payout operations (v1.0.4 §7).
 *
 * Flow:
 *   1. Admin enrolls once:      POST /mfa/enroll  -> otpauth:// URI (+secret, shown once)
 *   2. Admin confirms enrollment: POST /mfa/confirm { code }
 *   3. For every sensitive operation the admin exchanges a *current* TOTP code
 *      for a short-lived, purpose- and scope-bound challenge token:
 *                                   POST /mfa/challenge { purpose, scope, code }
 *   4. The guard consumes the token exactly once via the operation header
 *      `x-mfa-challenge`.
 *
 * Guarantees enforced here:
 *   - Challenges live ONLY in Redis with a short TTL (default 120s) — nothing
 *     persists that could be replayed after expiry.
 *   - Consumption is atomic (Lua compare-and-delete): two concurrent uses of
 *     the same token can never both succeed (single-use).
 *   - A challenge issued for purpose P cannot authorize purpose Q, and a
 *     challenge scoped to withdrawal A cannot authorize withdrawal B.
 *   - Redis unavailability FAILS CLOSED: challenge issuance and consumption
 *     throw 503 and the protected operation is rejected. There is no
 *     per-process fallback that could bypass replay protection.
 *   - The TOTP secret is stored AES-256-GCM encrypted; the key is derived
 *     with scrypt from JWT_SECRET (domain-separated) or MFA_ENCRYPTION_KEY.
 *   - TOTP codes are single-use per credential via the matched counter
 *     (replay of the same code at the same step is rejected).
 */

export const MFA_CHALLENGE_TTL_SECONDS = 120;
const ENCRYPTION_DOMAIN = 'kindora-mfa-v1';

export enum MfaPurpose {
  PAYOUT_FIRST_APPROVAL = 'PAYOUT_FIRST_APPROVAL',
  PAYOUT_SECOND_APPROVAL = 'PAYOUT_SECOND_APPROVAL',
  PAYOUT_SETTLEMENT = 'PAYOUT_SETTLEMENT',
  PAYOUT_RETRY = 'PAYOUT_RETRY',
  PAYOUT_EXECUTION = 'PAYOUT_EXECUTION',
  PAYOUT_STATE_CHANGE = 'PAYOUT_STATE_CHANGE',
  PAYOUT_RECONCILIATION = 'PAYOUT_RECONCILIATION',
  PAYOUT_MANUAL_REVIEW = 'PAYOUT_MANUAL_REVIEW',
  REFUND_EXECUTION = 'REFUND_EXECUTION',
  FINANCIAL_CONFIG = 'FINANCIAL_CONFIG',
}

export interface StoredChallenge {
  userId: string;
  purpose: MfaPurpose;
  scope: string | null;
  issuedAt: number;
}

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  // ---- secret encryption ----------------------------------------------------

  private encryptionKey(): Buffer {
    const dedicated = this.config.get<string>('mfa.encryptionKey');
    const base = dedicated || this.config.get<string>('jwt.secret') || '';
    if (!base) throw new ServiceUnavailableException('MFA encryption material is not configured');
    return scryptSync(base, ENCRYPTION_DOMAIN, 32);
  }

  private encryptSecret(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
  }

  private decryptSecret(secretEnc: string): string {
    const [ivB64, tagB64, dataB64] = secretEnc.split(':');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Corrupt MFA secret record');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  // ---- enrollment ------------------------------------------------------------

  async enroll(userId: string, email: string) {
    const existing = await this.prisma.mfaCredential.findUnique({ where: { userId } });
    if (existing?.status === MfaCredentialStatus.ACTIVE) {
      throw new BadRequestException('MFA is already active for this account');
    }
    const secret = generateTotpSecret();
    const data = { secretEnc: this.encryptSecret(secret), status: MfaCredentialStatus.ENROLLING };
    await this.prisma.mfaCredential.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return {
      otpauthUri: totpProvisioningUri(email, 'KINDORA', secret),
      // Displayed exactly once for authenticator setup; never returned again.
      secret,
      message: 'Add this secret to your authenticator app, then POST /mfa/confirm with a current code.',
    };
  }

  async confirm(userId: string, code: string) {
    const cred = await this.getUsableCredential(userId, MfaCredentialStatus.ENROLLING);
    // RFC 6238 keys are the base32-DECODED bytes of the enrolled secret —
    // exactly what Google Authenticator/Authy compute codes over. Verifying
    // over the ASCII text of the base32 string would make real codes unverifiable.
    const secret = base32Decode(this.decryptSecret(cred.secretEnc));
    const counter = totpVerify(secret, code);
    if (counter === null) throw new ForbiddenException('Invalid MFA code — enrollment not confirmed');
    await this.prisma.mfaCredential.update({
      where: { userId },
      data: { status: MfaCredentialStatus.ACTIVE, confirmedAt: new Date(), lastUsedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: { actorUserId: userId, action: 'MFA_ENROLLED', entityType: 'USER', entityId: userId },
    });
    return { ok: true, message: 'MFA is now active for this account.' };
  }

  async disable(userId: string) {
    const cred = await this.prisma.mfaCredential.findUnique({ where: { userId } });
    if (!cred || cred.status !== MfaCredentialStatus.ACTIVE) {
      throw new BadRequestException('MFA is not active for this account');
    }
    await this.prisma.mfaCredential.update({
      where: { userId },
      data: { status: MfaCredentialStatus.DISABLED },
    });
    await this.prisma.auditLog.create({
      data: { actorUserId: userId, action: 'MFA_DISABLED', entityType: 'USER', entityId: userId },
    });
    return { ok: true, message: 'MFA disabled. Enroll again before performing payout approvals.' };
  }

  async status(userId: string) {
    const cred = await this.prisma.mfaCredential.findUnique({ where: { userId } });
    return {
      enrolled: Boolean(cred),
      active: cred?.status === MfaCredentialStatus.ACTIVE,
      confirmedAt: cred?.confirmedAt ?? null,
    };
  }

  /** MFA must be ACTIVE before any payout step-up is possible. */
  async requireActive(userId: string) {
    const cred = await this.prisma.mfaCredential.findUnique({ where: { userId } });
    if (!cred || cred.status !== MfaCredentialStatus.ACTIVE) {
      throw new ForbiddenException('Fresh MFA is required for this operation — enroll with POST /mfa/enroll first');
    }
    return cred;
  }

  private async getUsableCredential(userId: string, expected: MfaCredentialStatus) {
    const cred = await this.prisma.mfaCredential.findUnique({ where: { userId } });
    if (!cred || cred.status !== expected) {
      throw new BadRequestException(
        expected === MfaCredentialStatus.ENROLLING
          ? 'No pending MFA enrollment for this account'
          : 'MFA is not active for this account',
      );
    }
    return cred;
  }

  // ---- challenge lifecycle ----------------------------------------------------

  /**
   * Exchange a current TOTP code for a fresh, purpose+scope-bound challenge.
   * Fails closed when Redis is unavailable.
   */
  async issueChallenge(userId: string, purpose: MfaPurpose, code: string, scope?: string) {
    this.assertRedisOrFailClosed();
    const cred = await this.requireActive(userId);
    // RFC 6238: verify over the base32-DECODED key bytes (authenticator semantics).
    const secret = base32Decode(this.decryptSecret(cred.secretEnc));
    const counter = totpVerify(secret, code);
    if (counter === null) throw new ForbiddenException('Invalid or expired MFA code');

    // Code replay suppression: a code verified for one challenge cannot be
    // re-verified for another within the same time step. acquireLock is a
    // single atomic SET NX PX — exactly one issuer can claim a given
    // (user, counter) pair; a second use is a replay and is rejected.
    const replayKey = `mfa:code:${userId}:${counter}`;
    const acquired = await this.redis.acquireLock(replayKey, MFA_CHALLENGE_TTL_SECONDS * 1000);
    if (!acquired) throw new ForbiddenException('This MFA code has already been used — wait for the next code');

    const token = randomToken(32);
    const payload: StoredChallenge = {
      userId,
      purpose,
      scope: scope ?? null,
      issuedAt: Date.now(),
    };
    const ok = await this.redis.set(`mfa:chal:${token}`, JSON.stringify(payload), MFA_CHALLENGE_TTL_SECONDS);
    if (!ok) throw new ServiceUnavailableException('MFA challenge could not be stored (fail-closed)');

    await this.prisma.mfaCredential.update({ where: { userId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { challengeToken: token, expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS, purpose, scope: scope ?? null };
  }

  /**
   * Atomically consume a challenge for (userId, purpose, scope).
   * Order of checks is deliberately identity-first; every failure path
   * removes replay ambiguity by consuming the token only on success of the
   * identity+purpose+scope match, so a wrong-scope request does not burn a
   * valid challenge (auditor-friendly), while a matched challenge is always
   * exactly-once.
   */
  async consumeChallenge(userId: string, purpose: MfaPurpose, scope: string | null, token: string) {
    if (!token || typeof token !== 'string' || token.length < 16) {
      throw new ForbiddenException('Fresh MFA verification required for this operation');
    }
    this.assertRedisOrFailClosed();
    const raw = await this.redis.get(`mfa:chal:${token}`);
    if (!raw) {
      throw new ForbiddenException('MFA challenge is invalid or expired — request a fresh verification');
    }
    let challenge: StoredChallenge;
    try {
      challenge = JSON.parse(raw) as StoredChallenge;
    } catch {
      throw new ForbiddenException('MFA challenge is invalid');
    }
    if (challenge.userId !== userId) {
      throw new ForbiddenException('MFA challenge does not belong to the authenticated user');
    }
    if (challenge.purpose !== purpose) {
      throw new ForbiddenException(
        `MFA challenge purpose mismatch: authorized for ${challenge.purpose}, used for ${purpose}`,
      );
    }
    if ((challenge.scope ?? null) !== (scope ?? null)) {
      throw new ForbiddenException('MFA challenge scope does not match the target resource');
    }
    const consumed = await this.redis.consume(`mfa:chal:${token}`);
    if (!consumed) {
      // Lost a race against a concurrent consumer — never allow double use.
      throw new ForbiddenException('MFA challenge was already used');
    }
    return { fresh: true, purpose, scope, issuedAt: new Date(challenge.issuedAt) };
  }

  private assertRedisOrFailClosed() {
    if (!this.redis.isAvailable()) {
      throw new ServiceUnavailableException(
        'MFA verification backend is unavailable — sensitive payout operations are rejected (fail-closed)',
      );
    }
  }
}
