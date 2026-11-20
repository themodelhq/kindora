import Redis from 'ioredis';

import { logError } from './logger';
import { validateRedisUrl } from './redis-url.util';

let connection: Redis | null = null;

/**
 * Workers are queue consumers and cron lock holders — Redis is NOT optional.
 * Exits the process (code 1) with a clear message when REDIS_URL is missing
 * so orchestration (Render) immediately surfaces the misconfiguration.
 */
export function requireRedisUrl(): string {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    logError(
      'FATAL: REDIS_URL is not set. KINDORA workers consume BullMQ queues and take Redis locks; ' +
        'the process cannot start without Redis. Set REDIS_URL (e.g. redis://default:password@host:6379) and restart.',
    );
    process.exit(1);
  }
  // v1.0.4: strict URL validation — a malformed URL must never reach the
  // client library. Error text never contains credentials.
  const validation = validateRedisUrl(url, {
    requireTls: (process.env.REDIS_REQUIRE_TLS ?? '') === 'true',
  });
  if (!validation.ok) {
    logError(`FATAL: REDIS_URL is invalid: ${validation.reason} (${validation.sanitized})`);
    process.exit(1);
  }
  return url;
}

/**
 * Lazily-created ioredis singleton. BullMQ requires maxRetriesPerRequest:
 * null; sharing this instance with Queues is safe (Workers duplicate their
 * own blocking connection internally).
 */
export function getRedis(): Redis {
  if (!connection) {
    connection = new Redis(requireRedisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    connection.on('error', (err: Error) => logError('[redis] connection error', err.message));
  }
  return connection;
}

const LOCK_PREFIX = 'kindora:lock:';

/**
 * Distributed lock via SET NX PX. Returns a unique owner token on success,
 * or null when someone else holds the lock (caller should exit 0).
 */
export async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const redis = getRedis();
  const owner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const result = await redis.set(LOCK_PREFIX + key, owner, 'PX', Math.max(1, Math.floor(ttlMs)), 'NX');
  return result === 'OK' ? owner : null;
}

/** Compare-and-delete via Lua so a stale owner can never free a live lock. */
export async function releaseLock(key: string, owner: string): Promise<void> {
  const redis = getRedis();
  const script =
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
  await redis.eval(script, 1, LOCK_PREFIX + key, owner);
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    const conn = connection;
    connection = null;
    await conn.quit().catch(() => conn.disconnect());
  }
}
