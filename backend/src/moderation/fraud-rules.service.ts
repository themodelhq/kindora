import { Injectable, NotFoundException } from '@nestjs/common';
import type { FraudSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

/**
 * Fraud rule thresholds.
 *  - velocity: a donor with MORE than 5 PENDING donations inside 10 minutes.
 *  - guest-email-burst: the same guest email creating more than 5 PENDING
 *    donations inside 10 minutes (duplicate submission bursts).
 *  - new-campaign-large-first: a donation above 2,000,000 minor units placed
 *    within the first hour after the campaign was published.
 */
const VELOCITY_WINDOW_MS = 10 * 60 * 1000;
const VELOCITY_THRESHOLD = 5; // strictly greater than
const LARGE_AMOUNT_MINOR = 2_000_000n;
const FIRST_HOUR_MS = 60 * 60 * 1000;

interface RuleSignal {
  rule: string;
  severity: FraudSeverity;
  details: Record<string, unknown>;
}

/**
 * Rule-based fraud scoring for donations. Called by the fraud worker
 * (`fraud.score-donation`) after a donation is created; each triggered rule
 * raises one FraudSignal row (idempotent per donation+rule across retries).
 */
@Injectable()
export class FraudRuleService {
  constructor(private readonly prisma: PrismaService) {}

  /** Evaluates every rule against one donation and persists FraudSignal rows. */
  async scoreDonation(donationId: string) {
    const donation = await this.prisma.donation.findUnique({
      where: { id: donationId },
      select: {
        id: true,
        campaignId: true,
        donorUserId: true,
        guestEmail: true,
        amount: true,
        currency: true,
        createdAt: true,
        campaign: { select: { id: true, title: true, publishedAt: true } },
      },
    });
    if (!donation) throw new NotFoundException('Donation not found');

    const signals: RuleSignal[] = [];
    const windowStart = new Date(donation.createdAt.getTime() - VELOCITY_WINDOW_MS);

    // (1) velocity: donor has more than 5 PENDING donations in the last 10 minutes.
    if (donation.donorUserId) {
      const pendingCount = await this.prisma.donation.count({
        where: {
          donorUserId: donation.donorUserId,
          status: 'PENDING',
          createdAt: { gte: windowStart, lte: donation.createdAt },
        },
      });
      if (pendingCount > VELOCITY_THRESHOLD) {
        signals.push({
          rule: 'velocity',
          severity: 'HIGH',
          details: { pendingCount, windowMinutes: 10, donorUserId: donation.donorUserId },
        });
      }
    }

    // (2) duplicate guest-email burst: same guest email, >5 PENDING in 10 minutes.
    if (donation.guestEmail) {
      const burstCount = await this.prisma.donation.count({
        where: {
          guestEmail: donation.guestEmail,
          status: 'PENDING',
          createdAt: { gte: windowStart, lte: donation.createdAt },
        },
      });
      if (burstCount > VELOCITY_THRESHOLD) {
        signals.push({
          rule: 'guest-email-burst',
          severity: 'MEDIUM',
          details: { pendingCount: burstCount, windowMinutes: 10, guestEmailDomain: donation.guestEmail.split('@')[1] ?? null },
        });
      }
    }

    // (3) new-campaign large first donation: > 2,000,000 minor within 1h of publish.
    const publishedAt = donation.campaign?.publishedAt ?? null;
    if (donation.amount > LARGE_AMOUNT_MINOR && publishedAt) {
      const minutesSincePublish = donation.createdAt.getTime() - publishedAt.getTime();
      if (minutesSincePublish >= 0 && minutesSincePublish <= FIRST_HOUR_MS) {
        signals.push({
          rule: 'new-campaign-large-first-donation',
          severity: 'HIGH',
          details: {
            amountMinor: donation.amount.toString(),
            currency: donation.currency,
            minutesSincePublish: Math.round(minutesSincePublish / 60000),
            campaignTitle: donation.campaign?.title ?? null,
          },
        });
      }
    }

    const created: { id: string; rule: string; severity: FraudSeverity }[] = [];
    for (const signal of signals) {
      // One row per (donation, rule): safe across BullMQ retries.
      const existing = await this.prisma.fraudSignal.findFirst({
        where: { donationId, rule: signal.rule },
        select: { id: true },
      });
      if (existing) continue;

      const row = await this.prisma.fraudSignal.create({
        data: {
          donationId,
          campaignId: donation.campaignId,
          userId: donation.donorUserId,
          rule: signal.rule,
          severity: signal.severity,
          details: signal.details as Prisma.InputJsonValue,
        },
        select: { id: true, rule: true, severity: true },
      });
      created.push(row);
    }

    return { donationId, triggered: signals.map((s) => s.rule), signals: created };
  }
}
