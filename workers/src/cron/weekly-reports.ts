/**
 * Cron: weekly admin report (Render Cron Job → `npm run cron:weekly-reports`).
 *
 * Self-contained script (Prisma + Redis SET NX PX lock, released on exit).
 * Invokes the weekly reports aggregation inline (same shared pipeline as the
 * reports/email queue jobs — see src/lib/weekly-report.ts) and mails the
 * result to ADMIN_EMAILS. Skips with a warning (exit 0) when ADMIN_EMAILS is
 * unset; SMTP-less environments record SKIPPED_NO_SMTP EmailLog rows.
 */
import { logError, logInfo } from '../lib/logger';
import { disconnectPrisma } from '../lib/prisma';
import { acquireLock, closeRedis, releaseLock } from '../lib/redis';
import { computeWeeklySummary, sendWeeklyReportEmail } from '../lib/weekly-report';

const NAME = 'weekly-reports';
const LOCK_TTL_MS = 15 * 60 * 1000;

async function work(): Promise<string> {
  const summary = await computeWeeklySummary();
  const sent = await sendWeeklyReportEmail(summary);
  if (sent === 0) {
    return 'ADMIN_EMAILS empty — no report sent';
  }
  return (
    `weekly report emailed to ${sent} admin(s) — ` +
    `${summary.totalDonations} donation(s), ${summary.totalAmountMinor.toString()} ${summary.currency} minor over last 7 days`
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
