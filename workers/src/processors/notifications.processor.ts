/**
 * NOTIFICATIONS queue processor — `notifications` queue.
 *
 *   notifications.campaign-update {campaignId, updateId?, updateTitle}
 *       Creates an in-app Notification row for every distinct registered
 *       donor of the campaign and fans out one `push.send` job per donor
 *       (batched to avoid hammering Redis in a single tick).
 *
 * Idempotency: writes Notification rows (not money-adjacent), but a BullMQ
 * redelivery would duplicate them. Guarded with a durable IdempotencyKey on
 * the updateId when the producer provides one.
 */
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';

import { frontendUrl } from '../lib/env';
import { logInfo, logWarn } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { enqueue, QUEUES } from '../lib/queues';

import type { JobHandler } from './email.processor';

const PUSH_BATCH = 100;
const MAX_DONORS = 500;
const IDEMPOTENCY_TTL_DAYS = 30;

async function handleCampaignUpdateNotification(job: Job): Promise<void> {
  const { campaignId, updateId, updateTitle } = job.data as {
    campaignId?: string;
    updateId?: string;
    updateTitle?: string;
  };
  if (!campaignId) return;

  // Durable dedupe when the producer identifies the update.
  if (updateId) {
    try {
      await prisma.idempotencyKey.create({
        data: {
          key: `notifications.campaign-update:${updateId}`,
          scope: 'notifications.campaign-update',
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1000),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        logInfo(`[notifications] campaign-update ${updateId} already fanned out — skipping duplicate`);
        return;
      }
      throw err;
    }
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { slug: true, title: true },
  });
  if (!campaign) return;

  const donors = await prisma.donation.findMany({
    where: { campaignId, status: 'SUCCEEDED', donorUserId: { not: null } },
    distinct: ['donorUserId'],
    take: MAX_DONORS,
    select: { donorUserId: true },
  });
  const userIds = donors
    .map((d) => d.donorUserId)
    .filter((id): id is string => Boolean(id));
  if (userIds.length === 0) {
    logInfo(`[notifications] no donors to notify for campaign ${campaignId}`);
    return;
  }

  const url = `${frontendUrl()}/campaigns/${campaign.slug}`;
  const title = `New update on "${campaign.title}"`;
  const body = updateTitle ?? campaign.title;

  await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      type: 'CAMPAIGN_UPDATE',
      title,
      body,
      data: { campaignId, updateId: updateId ?? null, url } as Prisma.InputJsonValue,
    })),
  });
  logInfo(`[notifications] created ${userIds.length} CAMPAIGN_UPDATE rows for campaign ${campaignId}`);

  // Fan out pushes in batches to avoid hammering Redis in one go.
  for (let i = 0; i < userIds.length; i += PUSH_BATCH) {
    const batch = userIds.slice(i, i + PUSH_BATCH);
    await Promise.all(
      batch.map((userId) =>
        enqueue(QUEUES.PUSH, 'push.send', { userId, title, body, url }).catch((err) =>
          logWarn(`[notifications] push.send enqueue failed for ${userId}: ${(err as Error).message}`),
        ),
      ),
    );
  }
}

export const NOTIFICATIONS_HANDLERS: Record<string, JobHandler> = {
  'notifications.campaign-update': handleCampaignUpdateNotification,
};
