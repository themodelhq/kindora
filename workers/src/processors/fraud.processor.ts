/**
 * FRAUD queue processor — `fraud` queue.
 *
 *   fraud.score-donation {donationId, ip?} — runs advisory rules and writes
 *   FraudSignal rows. IMPORTANT: signals NEVER block money flow; they are
 *   review cues for moderation. Rules (per spec):
 *
 *   (a) donation_velocity      MEDIUM — same guestEmail or donorUserId with
 *                              >= 5 PENDING/SUCCEEDED donations created in
 *                              the last 10 minutes.
 *   (b) large_first_donation   HIGH   — first donation ever recorded on the
 *                              campaign, amount > 2,000,000 minor units (or,
 *                              judged by amount alone as a crude USD-
 *                              equivalent without FX conversion, a major
 *                              value > 2000), created within 1h of the
 *                              campaign's publishedAt.
 *   (c) duplicate_message      LOW    — >= 3 donations on the same campaign
 *                              carrying the exact same donor message text.
 *
 * Idempotent across BullMQ retries: one FraudSignal row per (donationId, rule).
 */
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';

import { logInfo, logWarn } from '../lib/logger';
import { majorValue } from '../lib/format';
import { prisma } from '../lib/prisma';

import type { JobHandler } from './email.processor';

const VELOCITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const VELOCITY_THRESHOLD = 5;
const LARGE_DONATION_MINOR = 2_000_000n; // 2,000,000 minor units in the donation currency
const LARGE_DONATION_MAJOR_EQUIV = 2000; // "2000 USD-equivalent by amount alone" (no FX)
const FIRST_HOUR_OF_CAMPAIGN_MS = 60 * 60 * 1000; // 1h after publishedAt
const DUPLICATE_MESSAGE_THRESHOLD = 3;

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskIp(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.***.***`;
  return `${ip.slice(0, Math.min(6, ip.length))}***`;
}

type SignalDraft = {
  rule: 'donation_velocity' | 'large_first_donation' | 'duplicate_message';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  details: Record<string, unknown>;
};

async function handleScoreDonation(job: Job): Promise<void> {
  const { donationId, ip } = job.data as { donationId?: string; ip?: string | null };
  if (!donationId) {
    logInfo(`[fraud] score-donation#${job.id ?? '-'} missing donationId — skipping`);
    return;
  }
  if ((process.env.PROVIDER_MODE ?? '').toLowerCase() === 'mock') {
    logInfo(`[fraud] PROVIDER_MODE=mock — skipping scoring of donation ${donationId}`);
    return;
  }
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: {
      id: true,
      campaignId: true,
      donorUserId: true,
      guestEmail: true,
      amount: true,
      currency: true,
      message: true,
      createdAt: true,
      donor: { select: { email: true } },
      campaign: { select: { publishedAt: true } },
    },
  });
  if (!donation) return;

  const signals: SignalDraft[] = [];
  const email = donation.guestEmail ?? donation.donor?.email ?? null;

  // (a) donation_velocity — >= 5 PENDING/SUCCEEDED donations for the same
  //     identity (guestEmail or donorUserId) within the last 10 minutes.
  const identityWhere: Prisma.DonationWhereInput | null = donation.donorUserId
    ? {
        donorUserId: donation.donorUserId,
        status: { in: ['PENDING', 'SUCCEEDED'] },
        createdAt: { gte: new Date(Date.now() - VELOCITY_WINDOW_MS) },
      }
    : email
      ? {
          guestEmail: email,
          status: { in: ['PENDING', 'SUCCEEDED'] },
          createdAt: { gte: new Date(Date.now() - VELOCITY_WINDOW_MS) },
        }
      : null;
  if (identityWhere) {
    const recent = await prisma.donation.count({ where: identityWhere });
    if (recent >= VELOCITY_THRESHOLD) {
      signals.push({
        rule: 'donation_velocity',
        severity: 'MEDIUM',
        details: {
          windowMinutes: VELOCITY_WINDOW_MS / 60_000,
          count: recent,
          identity: donation.donorUserId ? `user:${donation.donorUserId}` : `email:${maskEmail(email ?? '')}`,
        },
      });
    }
  }

  // (b) large_first_donation — first donation on the campaign, large amount,
  //     created within 1h of the campaign going live.
  const publishedAt = donation.campaign.publishedAt;
  if (publishedAt) {
    const withinFirstHour =
      donation.createdAt.getTime() - publishedAt.getTime() >= 0 &&
      donation.createdAt.getTime() - publishedAt.getTime() <= FIRST_HOUR_OF_CAMPAIGN_MS;
    const amountExceedsThreshold =
      donation.amount > LARGE_DONATION_MINOR ||
      majorValue(donation.amount, donation.currency) > LARGE_DONATION_MAJOR_EQUIV;
    if (withinFirstHour && amountExceedsThreshold) {
      const prior = await prisma.donation.count({
        where: { campaignId: donation.campaignId, id: { not: donation.id }, createdAt: { lt: donation.createdAt } },
      });
      if (prior === 0) {
        signals.push({
          rule: 'large_first_donation',
          severity: 'HIGH',
          details: {
            amountMinor: donation.amount.toString(),
            currency: donation.currency,
            minutesAfterPublish: Math.round((donation.createdAt.getTime() - publishedAt.getTime()) / 60_000),
          },
        });
      }
    }
  }

  // (c) duplicate_message — >= 3 donations on the campaign with the exact
  //     same non-empty message text.
  const message = donation.message?.trim();
  if (message) {
    const sameMessage = await prisma.donation.count({
      where: { campaignId: donation.campaignId, message: message },
    });
    if (sameMessage >= DUPLICATE_MESSAGE_THRESHOLD) {
      signals.push({
        rule: 'duplicate_message',
        severity: 'LOW',
        details: {
          count: sameMessage,
          excerpt: message.slice(0, 120),
          length: message.length,
        },
      });
    }
  }

  if (signals.length === 0) return;

  // The producer's request IP is attached (masked) to every raised signal as
  // reviewer context — it never triggers a rule by itself.
  const ipContext: Record<string, unknown> = ip ? { ipMasked: maskIp(ip) } : {};

  for (const signal of signals) {
    // Idempotent across retries: one row per (donation, rule).
    const existing = await prisma.fraudSignal.findFirst({
      where: { donationId, rule: signal.rule },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.fraudSignal.create({
      data: {
        donationId,
        campaignId: donation.campaignId,
        userId: donation.donorUserId ?? null,
        rule: signal.rule,
        severity: signal.severity,
        details: { ...signal.details, ...ipContext } as Prisma.InputJsonValue,
      },
    });
    logWarn(`[fraud] ${signal.severity} signal "${signal.rule}" raised for donation ${donationId} (advisory — money flow unaffected)`);
  }
}

export const FRAUD_HANDLERS: Record<string, JobHandler> = {
  'fraud.score-donation': handleScoreDonation,
};
