/**
 * Cron: database housekeeping (Render Cron Job → `npm run cron:db-maintenance`).
 *
 * Self-contained script (Prisma + Redis SET NX PX lock, released on exit).
 * Directly purges expired/transient rows so indexes stay lean:
 *   - AuthToken        : expired > 7 days ago (consumed ones older than 7d too)
 *   - Session          : expired > 30 days ago (revoked ones older than 30d too)
 *   - IdempotencyKey   : expiresAt < now
 *   - WebhookEvent     : older than 90 days, but FAILED events are kept for
 *                        only 30 days (debug window, then purged)
 *   - EmailLog         : older than 180 days
 *
 * Idempotent: deleteMany by timestamp conditions — running twice deletes
 * nothing extra.
 */
import dayjs from '../lib/dayjs';
import { logError, logInfo } from '../lib/logger';
import { disconnectPrisma, prisma } from '../lib/prisma';
import { acquireLock, closeRedis, releaseLock } from '../lib/redis';

const NAME = 'db-maintenance';
const LOCK_TTL_MS = 20 * 60 * 1000;

async function work(): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = dayjs.utc(now).subtract(7, 'day').toDate();
  const thirtyDaysAgo = dayjs.utc(now).subtract(30, 'day').toDate();
  const ninetyDaysAgo = dayjs.utc(now).subtract(90, 'day').toDate();
  const oneEightyDaysAgo = dayjs.utc(now).subtract(180, 'day').toDate();

  const [authTokens, sessions, idempotencyKeys, webhookEventsOld, webhookEventsFailed, emailLogs] =
    await Promise.all([
      prisma.authToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: sevenDaysAgo } }, { usedAt: { lt: sevenDaysAgo } }] },
      }),
      prisma.session.deleteMany({
        where: { OR: [{ expiresAt: { lt: thirtyDaysAgo } }, { revokedAt: { lt: thirtyDaysAgo } }] },
      }),
      prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } }),
      // Non-FAILED webhook events: 90-day retention.
      prisma.webhookEvent.deleteMany({ where: { createdAt: { lt: ninetyDaysAgo }, status: { not: 'FAILED' } } }),
      // FAILED webhook events: kept 30 days for debugging, then purged.
      prisma.webhookEvent.deleteMany({ where: { createdAt: { lt: thirtyDaysAgo }, status: 'FAILED' } }),
      prisma.emailLog.deleteMany({ where: { createdAt: { lt: oneEightyDaysAgo } } }),
    ]);

  const webhookEvents = webhookEventsOld.count + webhookEventsFailed.count;
  return (
    `purged authTokens=${authTokens.count} sessions=${sessions.count} ` +
    `idempotencyKeys=${idempotencyKeys.count} webhookEvents=${webhookEvents} ` +
    `emailLogs=${emailLogs.count}`
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let owner: string | null = null;
  let exitCode = 0;
  try {
    owner = await acquireLock(`cron:${NAME}`, LOCK_TTL_MS);
    if (!owner) {
      logInfo(`[cron:${NAME}] lock held by another instance — exiting 0`);
    } else {
      const summary = await work();
      logInfo(`[cron:${NAME}] done in ${Date.now() - startedAt}ms — ${summary}`);
    }
  } catch (err) {
    exitCode = 1;
    logError(
      `[cron:${NAME}] failed after ${Date.now() - startedAt}ms`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
  } finally {
    if (owner) {
      await releaseLock(`cron:${NAME}`, owner).catch((err) =>
        logError(`[cron:${NAME}] lock release failed: ${(err as Error).message}`),
      );
    }
    await disconnectPrisma().catch(() => undefined);
    await closeRedis().catch(() => undefined);
  }
  process.exit(exitCode);
}

process.on('unhandledRejection', (reason) => logError(`[cron:${NAME}] unhandled rejection`, reason));
process.on('uncaughtException', (err) => {
  logError(`[cron:${NAME}] uncaught exception — exiting 1`, err.message);
  process.exit(1);
});

void main();
