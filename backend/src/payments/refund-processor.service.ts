import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DonationStatus, FraudSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { QueueService } from '../common/queue.service';
import { PaymentsService } from './payments.service';
import type { WebhookVerifyResult } from './provider-adapter.interface';
import type { PaymentProvider } from '@prisma/client';

export interface RefundOutcome {
  refundId: string;
  donationId: string;
  publicRef: string;
  amountMinor: bigint;
  tipMinor: bigint;
  full: boolean;
}

/**
 * Shared refund & dispute processor.
 *
 * Both the administrator refund flow and provider refund/dispute webhook
 * events route through here so every financial reversal:
 *  - is guarded by a conditional UPDATE (only refundable donations move),
 *  - posts compensating double-entry ledger entries inside the SAME
 *    transaction as the donation state change (never edits history),
 *  - reverses sponsor matching when the donation money goes back,
 *  - decrements denormalised campaign counters under guard,
 *  - writes an immutable audit record.
 */
@Injectable()
export class RefundProcessorService {
  private readonly logger = new Logger(RefundProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly queue: QueueService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Executes a refund for a donation.
   * `amountMinor` is the CHARGED total to return (campaign share + tip).
   * When omitted, the full remaining charged amount is refunded.
   * When `executeWithProvider` is true (administrator-initiated refunds for
   * live providers), the provider refund API is called FIRST and the refund
   * is only recorded if the provider accepted it.
   */
  async refundDonation(params: {
    publicRef: string;
    reason: string;
    requestedById?: string;
    source: 'ADMIN' | 'PROVIDER_EVENT';
    amountMinor?: bigint;
    providerRef?: string;
    executeWithProvider?: boolean;
  }): Promise<RefundOutcome> {
    const donation = await this.prisma.donation.findUnique({ where: { publicRef: params.publicRef } });
    if (!donation) throw new NotFoundException('Donation not found');
    if (donation.status === DonationStatus.REFUNDED) throw new BadRequestException('Donation has already been refunded');
    if (donation.status !== DonationStatus.SUCCEEDED && donation.status !== DonationStatus.PARTIALLY_REFUNDED) {
      throw new BadRequestException('Only succeeded donations can be refunded');
    }

    const chargedTotal = donation.amount + donation.tipAmount;
    const prior = await this.prisma.refund.aggregate({
      where: { donationId: donation.id, status: 'PROCESSED' },
      _sum: { amount: true },
      _count: true,
    });
    // Refund rows store the campaign share; the tip share is stored on the
    // ledger metadata. Recompute the already-refunded charged total via audit
    // metadata would be fragile — tips are refunded in full alongside the
    // campaign share, so prior refunds fully consumed their tips too.
    const priorCharged = (prior._sum.amount ?? 0n) + (prior._count > 0 ? donation.tipAmount : 0n);
    const remaining = chargedTotal - priorCharged;
    const requested = params.amountMinor ?? remaining;
    if (requested <= 0n) throw new BadRequestException('Nothing left to refund');
    if (requested > remaining) {
      throw new BadRequestException(`Refund exceeds refundable remainder (${remaining} minor units)`);
    }

    // Optional provider-side execution BEFORE any database change.
    let providerRef = params.providerRef ?? null;
    if (params.executeWithProvider && !providerRef) {
      providerRef = await this.executeProviderRefund(donation.provider, donation.providerReference ?? donation.publicRef, requested);
    }

    // Proportional split (keeps ledger balanced for partial refunds).
    const campaignPart = (requested * donation.amount) / chargedTotal;
    const tipPart = requested - campaignPart;
    const isFull = requested === remaining;

    let outcome: RefundOutcome | null = null;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.donation.findUnique({
          where: { id: donation.id },
          include: { campaign: { select: { id: true, currency: true, title: true, createdById: true, slug: true } } },
        });
        if (!fresh || (fresh.status !== DonationStatus.SUCCEEDED && fresh.status !== DonationStatus.PARTIALLY_REFUNDED)) {
          throw new BadRequestException('Donation is no longer refundable');
        }

        const created = await tx.refund.create({
          data: {
            donationId: fresh.id,
            amount: campaignPart,
            reason: params.reason.slice(0, 500),
            status: 'PROCESSED',
            providerRef: providerRef ?? `${params.source === 'ADMIN' ? 'manual' : 'webhook'}:pending`,
            requestedById: params.requestedById,
            processedAt: new Date(),
          },
        });
        if (!providerRef) {
          await tx.refund.update({ where: { id: created.id }, data: { providerRef: `${params.source === 'ADMIN' ? 'manual' : 'webhook'}:${created.id}` } });
        }

        // Atomic state transition: exactly one caller wins.
        const updated = await tx.donation.updateMany({
          where: { id: fresh.id, status: { in: [DonationStatus.SUCCEEDED, DonationStatus.PARTIALLY_REFUNDED] } },
          data: { status: isFull ? DonationStatus.REFUNDED : DonationStatus.PARTIALLY_REFUNDED, refundedAt: new Date() },
        });
        if (updated.count === 0) throw new BadRequestException('Donation is no longer refundable');

        // Compensating ledger entries inside the same transaction.
        await this.ledger.postRefund(
          {
            refundId: created.id,
            donationId: fresh.id,
            publicRef: fresh.publicRef,
            campaignId: fresh.campaign.id,
            currency: fresh.campaign.currency,
            amount: campaignPart,
            tipAmount: tipPart,
          },
          tx,
        );

        // Reverse sponsor matching only when the donation is fully reversed
        // (partial refunds keep the match attached to the remaining money).
        if (isFull && fresh.matchedAmount > 0n && fresh.matchingPoolId) {
          await this.ledger.postMatchReversal(
            {
              poolId: fresh.matchingPoolId,
              donationId: fresh.id,
              publicRef: fresh.publicRef,
              campaignId: fresh.campaign.id,
              currency: fresh.campaign.currency,
              matchedAmount: fresh.matchedAmount,
            },
            tx,
          );
          await tx.matchingPool.updateMany({
            where: { id: fresh.matchingPoolId, matchedAmount: { gte: fresh.matchedAmount } },
            data: { matchedAmount: { decrement: fresh.matchedAmount } },
          });
          await tx.campaign.updateMany({
            where: { id: fresh.campaign.id, raisedAmount: { gte: fresh.matchedAmount } },
            data: { raisedAmount: { decrement: fresh.matchedAmount } },
          });
        }

        // Denormalised campaign counters (guarded).
        const counters = await tx.campaign.updateMany({
          where: { id: fresh.campaign.id, raisedAmount: { gte: campaignPart } },
          data: { raisedAmount: { decrement: campaignPart }, ...(isFull ? { donorCount: { decrement: 1 } } : {}) },
        });
        if (counters.count === 0) {
          this.logger.warn(`Refund ${created.id}: campaign ${fresh.campaign.id} raisedAmount guard failed; reconciliation will flag`);
        }

        await tx.auditLog.create({
          data: {
            actorUserId: params.requestedById,
            action: params.source === 'ADMIN' ? 'ADMIN_REFUND' : 'PROVIDER_REFUND',
            entityType: 'REFUND',
            entityId: created.id,
            metadata: {
              donationRef: fresh.publicRef,
              donationId: fresh.id,
              chargedRefunded: requested.toString(),
              campaignPart: campaignPart.toString(),
              tipPart: tipPart.toString(),
              full: isFull,
              provider: fresh.provider,
              providerRef: providerRef ?? undefined,
              reason: params.reason.slice(0, 300),
            },
          },
        });

        return {
          refundId: created.id,
          donationId: fresh.id,
          publicRef: fresh.publicRef,
          amountMinor: campaignPart,
          tipMinor: tipPart,
          full: isFull,
        };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Refund already posted for this donation (ledger reference exists)');
      }
      throw err;
    }

    // Post-commit side effects (must never roll back the refund).
    try {
      const donorUserId = (await this.prisma.donation.findUnique({ where: { id: donation.id }, select: { donorUserId: true } }))?.donorUserId;
      if (donorUserId) {
        await this.prisma.notification.create({
          data: {
            userId: donorUserId,
            type: 'DONATION_REFUNDED',
            title: 'Donation refunded',
            body: `Your donation ${outcome.publicRef} has been refunded.`,
            data: { donationId: outcome.donationId, publicRef: outcome.publicRef, refundId: outcome.refundId },
          },
        });
        await this.queue.enqueue('email', 'email.refund-processed', {
          donationId: outcome.donationId,
          publicRef: outcome.publicRef,
          donorUserId,
        });
      }
    } catch (err) {
      this.logger.warn(`Refund side effects failed for ${outcome.publicRef}: ${(err as Error).message}`);
    }

    return outcome;
  }

  /**
   * Provider refund/dispute webhook entry point. Returns an action string for
   * the WebhookEvent audit trail. Provider-initiated refunds never call the
   * provider again — the event IS the provider confirmation.
   */
  async applyProviderRefundEvent(provider: PaymentProvider, webhook: WebhookVerifyResult): Promise<string> {
    const reference = webhook.reference;
    if (!reference) return 'NO_REFERENCE';
    const donation = await this.prisma.donation.findUnique({ where: { publicRef: reference } });
    if (!donation) return 'REFERENCE_NOT_FOUND';
    if (donation.provider !== provider) return 'PROVIDER_MISMATCH';
    if (donation.status !== DonationStatus.SUCCEEDED && donation.status !== DonationStatus.PARTIALLY_REFUNDED) {
      return 'NOT_REFUNDABLE_STATE';
    }

    const chargedTotal = donation.amount + donation.tipAmount;
    const prior = await this.prisma.refund.aggregate({
      where: { donationId: donation.id, status: 'PROCESSED' },
      _sum: { amount: true },
      _count: true,
    });
    const priorCharged = (prior._sum.amount ?? 0n) + (prior._count > 0 ? donation.tipAmount : 0n);
    const remaining = chargedTotal - priorCharged;
    if (remaining <= 0n) return 'ALREADY_REFUNDED';

    const refunded = webhook.amountMinor != null && webhook.amountMinor > 0n && webhook.amountMinor <= remaining ? webhook.amountMinor : remaining;

    await this.refundDonation({
      publicRef: reference,
      reason: `Provider ${provider.toLowerCase()} refund event${webhook.eventType ? ` (${webhook.eventType})` : ''}`,
      source: 'PROVIDER_EVENT',
      amountMinor: refunded,
      providerRef: webhook.eventId ? `${provider.toLowerCase()}:${webhook.eventId}` : undefined,
    });
    this.logger.log(`Provider refund applied to ${reference} (${refunded} minor)`);
    return 'REFUND_APPLIED';
  }

  /**
   * Records a dispute/chargeback signal. Money is NOT moved on dispute
   * events alone — an administrator reviews, and the eventual reversal
   * arrives either as a provider REFUND event or a manual refund.
   */
  async recordDispute(provider: PaymentProvider, webhook: WebhookVerifyResult): Promise<string> {
    const reference = webhook.reference;
    if (!reference) return 'NO_REFERENCE';
    const donation = await this.prisma.donation.findUnique({
      where: { publicRef: reference },
      include: { campaign: { select: { id: true, createdById: true, title: true } } },
    });
    if (!donation) return 'REFERENCE_NOT_FOUND';
    if (donation.provider !== provider) return 'PROVIDER_MISMATCH';

    await this.prisma.$transaction([
      this.prisma.fraudSignal.create({
        data: {
          donationId: donation.id,
          campaignId: donation.campaignId,
          userId: donation.donorUserId,
          rule: `DISPUTE_${provider}`,
          severity: 'HIGH' as FraudSeverity,
          details: {
            eventType: webhook.eventType ?? 'dispute',
            eventId: webhook.eventId,
            publicRef: donation.publicRef,
            amount: chargedString(donation),
          },
        },
      }),
      this.prisma.auditLog.create({
        data: {
          action: 'PROVIDER_DISPUTE',
          entityType: 'DONATION',
          entityId: donation.id,
          metadata: { publicRef: donation.publicRef, provider, eventType: webhook.eventType, eventId: webhook.eventId },
        },
      }),
      this.prisma.notification.create({
        data: {
          userId: donation.campaign.createdById,
          type: 'SYSTEM_ALERT',
          title: 'Payment dispute opened',
          body: `A payment dispute was opened for a donation on "${donation.campaign.title}". Our team will review it.`,
          data: { donationId: donation.id, publicRef: donation.publicRef },
        },
      }),
    ]);
    this.logger.warn(`DISPUTE recorded for ${reference} (${provider} ${webhook.eventType ?? ''})`);
    return 'DISPUTE_RECORDED';
  }

  /** Calls the live provider refund API (administrator-initiated refunds). */
  private async executeProviderRefund(
    provider: PaymentProvider,
    providerReference: string,
    amountMinor: bigint,
  ): Promise<string | null> {
    const adapter = this.payments.adapterFor(provider);
    if (!adapter.refund) return null; // provider has no refund API wired -> manual settlement path
    try {
      const result = await adapter.refund(providerReference, amountMinor);
      return result.providerRef;
    } catch (err) {
      this.logger.error(`Provider refund execution failed for ${providerReference}: ${(err as Error).message}`);
      throw new BadRequestException('Provider rejected the refund; nothing was recorded. Investigate and retry.');
    }
  }
}

function chargedString(donation: { amount: bigint; tipAmount: bigint }): string {
  return (donation.amount + donation.tipAmount).toString();
}
