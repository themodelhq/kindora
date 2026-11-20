import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Donation, DonationStatus, PaymentProvider, Prisma } from '@prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';

export interface ApplyResult {
  donation: Donation | null;
  duplicate: boolean;
}

/**
 * Applies authoritative payment outcomes to donations.
 *
 * Every write path is guarded by a conditional UPDATE
 * (PENDING -> SUCCEEDED/FAILED) so a webhook, a status-verification poll and a
 * worker retry racing on the same donation can only ever apply the outcome
 * once. Money movement happens exclusively inside the same interactive
 * database transaction as the donation state change (never from client input).
 */
@Injectable()
export class DonationPaymentService {
  private readonly logger = new Logger(DonationPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly queue: QueueService,
  ) {}

  async applySuccess(params: {
    publicRef: string;
    provider: PaymentProvider;
    providerReference?: string;
    providerFeeMinor?: bigint;
    providerAuthRef?: string;
    raw?: Record<string, unknown>;
  }): Promise<ApplyResult> {
    // Provider equality is part of the identity of the donation: a verified
    // event from provider X can never complete a donation recorded against
    // provider Y (cross-provider confusion guard, defence in depth — the
    // webhook controller checks this before calling).
    const donation = await this.prisma.donation.findFirst({
      where: { publicRef: params.publicRef, provider: params.provider },
      include: { campaign: { select: { id: true, status: true, targetAmount: true } } },
    });
    if (!donation) {
      const anyProvider = await this.prisma.donation.findUnique({ where: { publicRef: params.publicRef } });
      if (!anyProvider) throw new NotFoundException(`Donation ${params.publicRef} not found`);
      this.logger.error(
        `applySuccess provider mismatch for ${params.publicRef}: donation provider ${anyProvider.provider}, caller ${params.provider}`,
      );
      return { donation: null, duplicate: true };
    }

    const totalCharged = donation.amount + donation.tipAmount;

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Atomic state transition: exactly one caller wins.
      const updated = await tx.donation.updateMany({
        where: { id: donation.id, status: DonationStatus.PENDING },
        data: {
          status: DonationStatus.SUCCEEDED,
          succeededAt: new Date(),
          providerReference: params.providerReference ?? donation.providerReference,
          totalCharged,
          chargeCurrency: donation.currency,
          ...(params.providerFeeMinor != null ? { providerFeeMinor: params.providerFeeMinor } : {}),
          ...(params.providerAuthRef ? { providerAuthRef: params.providerAuthRef } : {}),
          receiptNumber: `RCP-${donation.publicRef.split('-')[1] ?? donation.id.slice(0, 8).toUpperCase()}`,
        },
      });
      if (updated.count === 0) return { duplicate: true, matchedAmount: 0n };

      // 2. Ledger postings inside the same transaction as the state change.
      await this.ledger.postDonationSuccess(
        {
          donationId: donation.id,
          publicRef: donation.publicRef,
          campaignId: donation.campaignId,
          currency: donation.currency,
          amount: donation.amount,
          tipAmount: donation.tipAmount,
          totalCharged,
          providerName: params.provider,
        },
        tx,
      );
      // Provider processing fee (exactly-once via `fee:donation:<id>`).
      if (params.providerFeeMinor != null && params.providerFeeMinor > 0n) {
        await this.ledger.postProviderFee(
          {
            donationId: donation.id,
            publicRef: donation.publicRef,
            currency: donation.currency,
            feeMinor: params.providerFeeMinor,
          },
          tx,
        );
      }

      // 3. Matching pool application (bounded by remaining pool funds).
      const matched = await this.applyMatching(tx, donation);

      // 4. Denormalised campaign counters (same tx keeps them consistent).
      await tx.campaign.update({
        where: { id: donation.campaignId },
        data: {
          raisedAmount: { increment: donation.amount + matched },
          donorCount: { increment: 1 },
          ...(donation.amount + matched >= donation.campaign.targetAmount
            ? { status: 'COMPLETED', completedAt: new Date() }
            : {}),
        },
      });
      return { duplicate: false, matchedAmount: matched };
    });

    if (result.duplicate) return { donation: null, duplicate: true };

    // Post-commit side effects (failures here must not roll back money movement).
    await this.afterSuccess(donation, result.matchedAmount);
    const fresh = await this.prisma.donation.findUnique({ where: { id: donation.id } });
    return { donation: fresh, duplicate: false };
  }

  /** Applies matching funds from an active pool, capped by remaining commitment. */
  private async applyMatching(tx: Prisma.TransactionClient, donation: Donation & { campaign: { id: string; status: string; targetAmount: bigint } }): Promise<bigint> {
    const pool = await tx.matchingPool.findFirst({
      where: {
        campaignId: donation.campaignId,
        status: 'ACTIVE',
        ...(donation.matchingPoolId ? { id: donation.matchingPoolId } : {}),
        OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] }],
      },
    });
    if (!pool) return 0n;
    const remaining = pool.totalCommitted - pool.matchedAmount;
    if (remaining <= 0n) {
      await tx.matchingPool.update({ where: { id: pool.id }, data: { status: 'EXHAUSTED' } });
      return 0n;
    }
    const ratioShare = (donation.amount * BigInt(pool.matchRatio)) / 100n;
    let matched = ratioShare;
    if (pool.capPerDonation && matched > pool.capPerDonation) matched = pool.capPerDonation;
    if (matched > remaining) matched = remaining;
    if (matched <= 0n) return 0n;

    await tx.matchingPool.update({
      where: { id: pool.id },
      data: { matchedAmount: { increment: matched }, ...(pool.matchedAmount + matched >= pool.totalCommitted ? { status: 'EXHAUSTED' } : {}) },
    });
    await tx.donation.update({
      where: { id: donation.id },
      data: { matchedAmount: matched, matchingPoolId: pool.id },
    });
    await this.ledger.postMatch(
      {
        poolId: pool.id,
        donationId: donation.id,
        publicRef: donation.publicRef,
        campaignId: donation.campaignId,
        currency: donation.currency,
        matchedAmount: matched,
      },
      tx,
    );
    return matched;
  }

  private async afterSuccess(donation: Donation, matchedAmount: bigint): Promise<void> {
    try {
      const campaign = await this.prisma.campaign.findUnique({
        where: { id: donation.campaignId },
        select: { id: true, title: true, createdById: true, slug: true, currency: true, targetAmount: true },
      });
      if (!campaign) return;

      await this.prisma.notification.createMany({
        data: [
          {
            userId: campaign.createdById,
            type: 'DONATION_RECEIVED',
            title: 'New donation received',
            body: `Your campaign "${campaign.title}" just received a donation.`,
            data: { donationId: donation.id, publicRef: donation.publicRef },
          },
          ...(donation.donorUserId
            ? [
                {
                  userId: donation.donorUserId,
                  type: 'DONATION_RECEIPT',
                  title: 'Thank you for giving',
                  body: `Your donation to "${campaign.title}" was confirmed. Receipt ${donation.receiptNumber ?? ''}`.trim(),
                  data: { donationId: donation.id, publicRef: donation.publicRef },
                },
              ]
            : []),
        ],
      });

      if (donation.donorUserId) {
        await this.queue.enqueue('email', 'email.donation-receipt', {
          donationId: donation.id,
          donorUserId: donation.donorUserId,
        });
      }
      await this.queue.enqueue('email', 'email.donation-organizer', { donationId: donation.id });
      await this.queue.enqueue('analytics', 'analytics.record-donation', {
        campaignId: donation.campaignId,
        donationId: donation.id,
        amountMinor: donation.amount.toString(),
        matchedMinor: matchedAmount.toString(),
        currency: donation.currency,
      });
    } catch (err) {
      this.logger.error(`Post-success side effects failed for ${donation.publicRef}: ${(err as Error).message}`);
    }
  }

  async applyFailure(params: { publicRef: string; reason: string; provider?: PaymentProvider }): Promise<ApplyResult> {
    // When a provider is supplied, enforce provider equality (same discipline
    // as applySuccess): a failure event from the wrong provider must not be
    // able to kill a donation that another provider still may complete.
    const donation = await this.prisma.donation.findFirst({
      where: { publicRef: params.publicRef, ...(params.provider ? { provider: params.provider } : {}) },
    });
    if (!donation) throw new NotFoundException(`Donation ${params.publicRef} not found`);
    const updated = await this.prisma.donation.updateMany({
      where: { id: donation.id, status: DonationStatus.PENDING },
      data: { status: DonationStatus.FAILED, failureReason: params.reason.slice(0, 500) },
    });
    return { donation: updated.count ? donation : null, duplicate: updated.count === 0 };
  }
}
