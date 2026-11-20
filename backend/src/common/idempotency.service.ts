import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Database-backed idempotency for critical POST operations (donation creation,
 * provider re-verifications). The client sends an `Idempotency-Key` header;
 * the first response body is stored and replayed on retries.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async acquire(key: string | undefined, scope: string, userId?: string): Promise<boolean> {
    if (!key) return true; // no key provided: proceed (caller-level guards still apply)
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: `${scope}:${userId ?? 'anon'}:${key}`,
          scope,
          userId,
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
      });
      return true;
    } catch {
      throw new ConflictException('This request was already processed (idempotency key reused)');
    }
  }

  async store(key: string | undefined, scope: string, userId: string | undefined, response: object): Promise<void> {
    if (!key) return;
    await this.prisma.idempotencyKey.updateMany({
      where: { key: `${scope}:${userId ?? 'anon'}:${key}` },
      data: { response: response as object },
    });
  }
}
