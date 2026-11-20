/**
 * Cron: campaign ending-soon reminders (Render Cron Job → `npm run cron:campaign-reminders`).
 *
 * Self-contained script (Prisma + Redis SET NX PX lock, released on exit).
 * For ACTIVE campaigns whose deadline falls within the next 3 days, notify
 * the organizer ONCE per day:
 *   1. an in-app Notification row, and
 *   2. a `push.send` job on the push queue.
 *
 * The once-per-day guard is a durable IdempotencyKey
 *   key = `campaign-reminder:<campaignId>:<YYYY-MM-DD>`
 * created first; a unique-violation (P2002) means today's reminder already
 * went out and the campaign is skipped. If the process dies between the key
 * and the fanout, the reminder for that day is lost (advisory reminder —
 * accepted trade-off for at-most-once semantics).
 */
import { Prisma } from '@prisma/client';

import dayjs from '../lib/dayjs';
import { frontendUrl } from '../lib/env';
import { logError, logInfo } from '../lib/logger';
import { disconnectPrisma, prisma } from '../lib/prisma';
import { QUEUES, enqueue } from '../lib/queues';
import { acquireLock, closeRedis, releaseLock } from '../lib/redis';

const NAME = 'campaign-reminders';
const LOCK_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TAKE = 200;

async function work(): Promise<string> {
  const now = new Date();
  const horizon = dayjs.utc(now).add(3, 'day').toDate();
  const today = dayjs.utc().format('YYYY-MM-DD');

  const campaigns = await prisma.campaign.findMany({
    where: { status: 'ACTIVE', deadline: { not: null, gte: now, lte: horizon } },
    select: { id: true, slug: true, title: true, deadline: true, createdById: true },
    take: TAKE,
    orderBy: { deadline: 'asc' },
  });

  let notified = 0;
  let skipped = 0;

  for (const campaign of campaigns) {
    if (!campaign.deadline) continue;

    try {
      await prisma.idempotencyKey.create({
        data: {
          key: `campaign-reminder:${campaign.id}:${today}`,
          scope: 'campaign-reminder',
          expiresAt: new Date(Date.now() + 2 * DAY_MS),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        skipped += 1; // already reminded today
        continue;
      }
      throw err;
    }

    const daysLeft = Math.max(
      0,
      dayjs.utc(campaign.deadline).startOf('day').diff(dayjs.utc().startOf('day'), 'day'),
    );
    const title = 'Your campaign is ending soon';
    const body =
      daysLeft === 0 ? `"${campaign.title}" ends today` : `"${campaign.title}" ends in ${daysLeft} day(s)`;
    const url = `${frontendUrl()}/campaigns/${campaign.slug}`;

    await prisma.notification.create({
      data: {
        userId: campaign.createdById,
        type: 'CAMPAIGN_ENDING',
        title,
        body,
        data: { campaignId: campaign.id, slug: campaign.slug, daysLeft, url } as Prisma.InputJsonValue,
      },
    });
    await enqueue(QUEUES.PUSH, 'push.send', {
      userId: campaign.createdById,
      title,
      body,
      url,
    });

    notified += 1;
    logInfo(`[cron:${NAME}] notified organizer of "${campaign.title}" (daysLeft=${daysLeft})`);
  }

  return `${notified} organizer notification(s) sent, ${skipped} already reminded today, of ${campaigns.length} eligible campaign(s)`;
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
