import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { validateRedisUrl } from './utils/redis-url.util';

/**
 * Redis access with graceful degradation.
 * When REDIS_URL is absent (or Redis is unreachable) cache/lock calls become
 * no-ops and report availability=false instead of crashing the request path.
 *
 * v1.0.4:
 *  - REDIS_URL is strictly validated before connecting (see redis-url.util).
 *    An invalid URL never reaches the client; the reason is logged without
 *    credentials.
 *  - MFA challenges rely on this service and FAIL CLOSED when it is
 *    unavailable (MfaService.assertRedisOrFailClosed).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private available = false;

  constructor() {
    const url = process.env.REDIS_URL ?? '';
    if (url) {
      const validation = validateRedisUrl(url, {
        requireTls: (process.env.REDIS_REQUIRE_TLS ?? '') === 'true',
      });
      if (!validation.ok) {
        // Credential-free message; the app stays up but degraded, and the
        // readiness probe (/health/redis) reports unhealthy.
        this.logger.warn(`Invalid REDIS_URL (${validation.sanitized}): ${validation.reason}`);
        this.client = null;
        this.available = false;
        return;
      }
      try {
        this.client = new Redis(url, {
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => Math.min(times * 500, 5000),
          lazyConnect: true,
        });
        this.client
          .connect()
          .then(() => {
            this.available = true;
            this.logger.log('Redis connected');
          })
          .catch((err) => {
            this.available = false;
            this.logger.warn(`Redis unavailable: ${(err as Error).message}`);
          });
        this.client.on('error', (err) => {
          this.available = false;
          this.logger.warn(`Redis error: ${err.message}`);
        });
      } catch (err) {
        this.logger.warn(`Redis init failed: ${(err as Error).message}`);
        this.client = null;
      }
    } else {
      this.logger.warn('REDIS_URL not set - caching and distributed locks are disabled');
    }
  }

  isAvailable(): boolean {
    return this.available && this.client !== null;
  }

  async ping(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      const res = await this.client!.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      return await this.client!.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      if (ttlSeconds) await this.client!.set(key, value, 'EX', ttlSeconds);
      else await this.client!.set(key, value);
      return true;
    } catch {
      return false;
    }
  }

  async del(key: string): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await this.client!.del(key);
    } catch {
      /* degraded */
    }
  }

  /**
   * Distributed lock (SET key value NX PX ttl). Returns true if acquired.
   * Used by cron jobs and workers to guarantee single execution across
   * instances/restarts (duplicate-safety for recurring donations etc).
   */
  async acquireLock(key: string, ttlMs: number, owner?: string): Promise<string | null> {
    if (!this.isAvailable()) return null; // null = lock unavailable, caller must decide
    const id = owner ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const res = await this.client!.set(key, id, 'PX', ttlMs, 'NX');
      return res === 'OK' ? id : null;
    } catch {
      return null;
    }
  }

  async releaseLock(key: string, owner: string): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await this.client!.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        key,
        owner,
      );
    } catch {
      /* degraded */
    }
  }

  /**
   * Atomic read-and-delete for single-use tokens (MFA challenges).
   * Returns the value when consumed; null when absent/unavailable.
   * Callers must treat null-after-assertAvailable as "already consumed".
   */
  async consume(key: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      // GETDEL (Redis >= 6.2; Render Key Value runs Redis 7).
      return await this.client!.getdel(key);
    } catch {
      return null;
    }
  }

  async onModuleDestroy() {
    if (this.client) await this.client.quit().catch(() => this.client?.disconnect());
  }
}
