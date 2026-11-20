/**
 * ANALYTICS queue processor — `analytics` queue.
 *
 *   analytics.record-donation {campaignId, donationId, amountMinor,
 *                             matchedMinor?, currency, tipAmountMinor?}
 *       Incremental daily rollups: CampaignStatDaily (campaignId+today UTC)
 *       and PlatformStatDaily (today UTC, unique date). Money-adjacent, so
 *       idempotent: a durable IdempotencyKey row keyed on donationId makes
 *       BullMQ redelivery a no-op (Redis-only dedupe could be lost on a
 *       Redis flush and double-count revenue).
 *   analytics.recompute-day {date?}
 *       Authoritative delete+rebuild of one UTC day from the Donation rows
 *       (naturally idempotent). Also owned here so the backend admin trigger
 *       and the daily cron agree on semantics.
 */
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';

import dayjs from '../lib/dayjs';
import { logInfo, logWarn } from '../lib/logger';
import { prisma } from '../lib/prisma';

import type { JobHandler } from './email.processor';

/** IdempotencyKey rows used for dedupe are kept for 30 days then swept by db-maintenance. */
const IDEMPOTENCY_TTL_DAYS = 30;

async function handleRecordDonation(job: Job): Promise<void> {
  const { campaignId, donationId, amountMinor, matchedMinor, currency, tipAmountMinor } = job.data as {
    campaignId?: string;
    donationId?: string;
    amountMinor?: string | number | bigint;
    matchedMinor?: string | number | bigint;
    tipAmountMinor?: string | number | bigint;
    currency?: string;
  };
  if (!campaignId) {
    logInfo(`[analytics] record-donation#${job.id ?? '-'} missing campaignId — skipping`);
    return;
  }

  // --- Idempotency: one rollup application per donation -------------------
  if (donationId) {
    try {
      await prisma.idempotencyKey.create({
        data: {
          key: `analytics.record-donation:${donationId}`,
          scope: 'analytics.record-donation',
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1000),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        logInfo(`[analytics] record-donation for ${donationId} already applied — skipping duplicate`);
        return;
      }
      throw err;
    }
  } else {
    logWarn('[analytics] record-donation payload without donationId — cannot dedupe, applying once');
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { currency: true },
  });
  if (!campaign) return;
  const cur = (currency ?? campaign.currency).toUpperCase();

  // Money math stays in BigInt minor units. matched funds and tips are part
  // of the raised totals; tips are additionally tracked in the platform-side
  // tipAmount column via tipAmountMinor when the producer includes it.
  const amount = BigInt(amountMinor ?? 0);
  const matched = BigInt(matchedMinor ?? 0);
  const tip = BigInt(tipAmountMinor ?? 0);
  const delta = amount + matched + tip;
  const day = dayjs.utc().startOf('day').toDate();

  await prisma.campaignStatDaily.upsert({
    where: { campaignId_date: { campaignId, date: day } },
    create: { campaignId, date: day, currency: cur, donationCount: 1, donationAmount: delta },
    update: { donationCount: { increment: 1 }, donationAmount: { increment: delta } },
  });

  // Platform rollup: one row per UTC day (date is @unique). newUsers /
  // newCampaigns are owned by other processes — only donation counters move.
  await prisma.platformStatDaily.upsert({
    where: { date: day },
    create: { date: day, currency: cur, donationCount: 1, donationAmount: delta, tipAmount: tip },
    update: {
      donationCount: { increment: 1 },
      donationAmount: { increment: delta },
      tipAmount: { increment: tip },
    },
  });
  logInfo(
    `[analytics] record-donation ${donationId ?? '(no id)'}: campaign ${campaignId} +${delta} ${cur}` +
      (donationId ? '' : ''),
  );
}

async function handleRecomputeDay(job: Job): Promise<void> {
  const dateArg = (job.data as { date?: string | Date }).date;
  const day = dateArg ? dayjs.utc(dateArg).startOf('day') : dayjs.utc().startOf('day');
  const dayStart = day.toDate();
  const dayEnd = day.add(1, 'day').toDate();
  logInfo(`[analytics] recompute-day ${dayStart.toISOString().slice(0, 10)} (UTC)`);

  // --- Campaign-level truth: SUCCEEDED donations grouped per campaign+currency.
  const campaignGroups = await prisma.donation.groupBy({
    by: ['campaignId', 'currency'],
    where: { status: 'SUCCEEDED', succeededAt: { gte: dayStart, lt: dayEnd } },
    _count: { _all: true },
    _sum: { amount: true, matchedAmount: true, tipAmount: true },
  });

  await prisma.campaignStatDaily.deleteMany({ where: { date: dayStart } });
  for (const group of campaignGroups) {
    const amount = (group._sum.amount ?? 0n) + (group._sum.matchedAmount ?? 0n);
    await prisma.campaignStatDaily.create({
      data: {
        campaignId: group.campaignId,
        date: dayStart,
        currency: group.currency,
        donationCount: group._count._all,
        donationAmount: amount,
      },
    });
  }

  // --- Platform-level truth: delete + recreate, preserving newUsers/newCampaigns.
  const existing = await prisma.platformStatDaily.findUnique({ where: { date: dayStart } });
  const donationCount = campaignGroups.reduce((acc, g) => acc + g._count._all, 0);
  const donationAmount = campaignGroups.reduce<bigint>(
    (acc, g) => acc + (g._sum.amount ?? 0n) + (g._sum.matchedAmount ?? 0n),
    0n,
  );
  const tipAmount = campaignGroups.reduce<bigint>((acc, g) => acc + (g._sum.tipAmount ?? 0n), 0n);
  // PlatformStatDaily has one row per day (single currency column): pick the
  // dominant currency by amount, falling back to the stored row / default.
  const dominant =
    [...campaignGroups].sort(
      (a, b) => Number(b._sum.amount ?? 0n) - Number(a._sum.amount ?? 0n),
    )[0]?.currency ??
    existing?.currency ??
    (process.env.DEFAULT_CURRENCY ?? 'NGN');

  await prisma.platformStatDaily.upsert({
    where: { date: dayStart },
    create: {
      date: dayStart,
      currency: dominant,
      donationCount,
      donationAmount,
      tipAmount,
      newUsers: existing?.newUsers ?? 0,
      newCampaigns: existing?.newCampaigns ?? 0,
    },
    update: { donationCount, donationAmount, tipAmount, currency: dominant },
  });

  logInfo(`[analytics] recompute-day done: ${campaignGroups.length} campaign row(s), platform ${donationCount} donation(s)`);
}

export const ANALYTICS_HANDLERS: Record<string, JobHandler> = {
  'analytics.record-donation': handleRecordDonation,
  'analytics.recompute-day': handleRecomputeDay,
};
