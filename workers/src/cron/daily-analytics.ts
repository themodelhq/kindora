/**
 * Cron: daily analytics completeness sweep (Render Cron Job → `npm run cron:daily-analytics`).
 *
 * Self-contained script (Prisma + Redis SET NX PX lock, released on exit).
 * Rebuilds YESTERDAY's PlatformStatDaily row directly from the authoritative
 * Donation rows — count/sum grouped by actual currency (falls back to the
 * existing row's currency, then DEFAULT_CURRENCY/NGN) — and upserts it.
 * newUsers/newCampaigns are owned by other processes and preserved.
 *
 * Safe to re-run: the upsert overwrites the donation counters for the day;
 * the Redis lock only prevents concurrent runs.
 */
import dayjs from '../lib/dayjs';
import { logError, logInfo } from '../lib/logger';
import { disconnectPrisma, prisma } from '../lib/prisma';
import { acquireLock, closeRedis, releaseLock } from '../lib/redis';

const NAME = 'daily-analytics';
const LOCK_TTL_MS = 10 * 60 * 1000;

async function work(): Promise<string> {
  const day = dayjs.utc().subtract(1, 'day').startOf('day');
  const dayStart = day.toDate();
  const dayEnd = day.add(1, 'day').toDate();
  const dateLabel = day.format('YYYY-MM-DD');

  // Authoritative truth: SUCCEEDED donations that resolved yesterday (UTC).
  const groups = await prisma.donation.groupBy({
    by: ['currency'],
    where: { status: 'SUCCEEDED', succeededAt: { gte: dayStart, lt: dayEnd } },
    _count: { _all: true },
    _sum: { amount: true, matchedAmount: true, tipAmount: true },
  });

  const donationCount = groups.reduce((acc, g) => acc + g._count._all, 0);
  const donationAmount = groups.reduce<bigint>(
    (acc, g) => acc + (g._sum.amount ?? 0n) + (g._sum.matchedAmount ?? 0n),
    0n,
  );
  const tipAmount = groups.reduce<bigint>((acc, g) => acc + (g._sum.tipAmount ?? 0n), 0n);

  const existing = await prisma.platformStatDaily.findUnique({ where: { date: dayStart } });
  const currency =
    [...groups].sort((a, b) => Number(b._sum.amount ?? 0n) - Number(a._sum.amount ?? 0n))[0]
      ?.currency ??
    existing?.currency ??
    (process.env.DEFAULT_CURRENCY ?? 'NGN');

  await prisma.platformStatDaily.upsert({
    where: { date: dayStart },
    create: {
      date: dayStart,
      currency,
      donationCount,
      donationAmount,
      tipAmount,
      newUsers: existing?.newUsers ?? 0,
      newCampaigns: existing?.newCampaigns ?? 0,
    },
    update: { currency, donationCount, donationAmount, tipAmount },
  });

  return (
    `${dateLabel}: ${donationCount} donation(s), donationAmount=${donationAmount.toString()} ` +
    `tipAmount=${tipAmount.toString()} ${currency} ` +
    `(previous row: ${existing ? `present (count=${existing.donationCount})` : 'missing — created'})`
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
