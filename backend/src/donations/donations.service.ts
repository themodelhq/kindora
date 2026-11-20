import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Donation, DonationStatus, PaymentProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';
import { IdempotencyService } from '../common/idempotency.service';
import { PaymentsService } from '../payments/payments.service';
import { DonationPaymentService } from '../payments/donation-payment.service';
import { publicRef } from '../common/utils/crypto.util';
import { CreateDonationDto } from './dto/create-donation.dto';

@Injectable()
export class DonationsService {
  private readonly logger = new Logger(DonationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly donationPayment: DonationPaymentService,
    private readonly queue: QueueService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    dto: CreateDonationDto,
    user: { id: string; email: string; firstName: string; lastName: string } | null,
    opts?: { ip?: string; idempotencyKey?: string },
  ) {
    await this.idempotency.acquire(opts?.idempotencyKey, 'donation:create', user?.id);

    const campaign = await this.prisma.campaign.findUnique({
      where: { slug: dto.campaignSlug },
      select: { id: true, title: true, status: true, currency: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status !== 'ACTIVE') throw new BadRequestException('Campaign is not accepting donations');

    const currency = campaign.currency;
    const amount = BigInt(dto.amountMinor);
    if (amount < 10000n) throw new BadRequestException('Donation is below the minimum amount');
    const tipAmount = dto.tipAmountMinor ? BigInt(dto.tipAmountMinor) : 0n;
    const total = amount + tipAmount;

    // Guest donations require a receipt email; account donations reuse profile email.
    const donorEmail = user?.email ?? dto.guestEmail;
    if (!donorEmail) throw new BadRequestException('A receipt email is required');

    const publicRef = this.generateRef('KDO');

    const donation = await this.prisma.donation.create({
      data: {
        publicRef,
        campaignId: campaign.id,
        donorUserId: user?.id,
        guestEmail: user ? null : dto.guestEmail,
        guestName: user ? null : dto.guestName,
        isAnonymous: dto.isAnonymous ?? false,
        amount,
        currency,
        tipAmount,
        status: DonationStatus.PENDING,
        provider: (dto.provider as PaymentProvider) ?? 'PAYSTACK',
        message: dto.message,
        circleId: dto.circleId,
        ...(dto.recurring && dto.recurringFrequency
          ? {
              metadata: {
                wantsRecurring: true,
                frequency: dto.recurringFrequency,
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    // Optional recurring schedule (Paystack-style authorisation tokens are
    // captured by the provider after the first successful charge).
    if (dto.recurring && user) {
      const nextChargeAt = this.nextChargeDate(dto.recurringFrequency ?? 'MONTHLY');
      await this.prisma.recurringDonation.create({
        data: {
          donorUserId: user.id,
          campaignId: campaign.id,
          amount,
          currency,
          frequency: dto.recurringFrequency ?? 'MONTHLY',
          provider: (dto.provider as PaymentProvider) ?? 'PAYSTACK',
          nextChargeAt,
          lastDonationId: donation.id,
        },
      });
    }

    // Initialise the payment at the provider (server-side only).
    const adapter = this.payments.requireEnabledAdapter((dto.provider as PaymentProvider) ?? 'PAYSTACK');
    const init = await adapter.initialize({
      donationId: donation.id,
      publicRef,
      amountMinor: amount,
      totalMinor: total,
      currency,
      campaignTitle: campaign.title,
      donorEmail,
      donorName: user ? `${user.firstName} ${user.lastName}` : dto.guestName,
      callbackUrl: `${this.frontendUrl()}/donate/status?ref=${publicRef}`,
    });

    await this.prisma.donation.update({
      where: { id: donation.id },
      data: {
        providerReference: init.providerReference,
        metadata: { ...(donation.metadata as object | undefined), redirectUrl: init.redirectUrl },
      },
    });

    await this.queue.enqueue('fraud', 'fraud.score-donation', { donationId: donation.id, ip: opts?.ip });

    return {
      donation: {
        publicRef: donation.publicRef,
        amount: donation.amount.toString(),
        currency: donation.currency,
        status: donation.status,
      },
      redirectUrl: init.redirectUrl,
    };
  }

  private frontendUrl(): string {
    return process.env.FRONTEND_URL ?? 'http://localhost:5173';
  }

  private generateRef(prefix: string): string {
    return publicRef(prefix);
  }

  private nextChargeDate(frequency: string): Date {
    const now = new Date();
    const months = frequency === 'YEARLY' ? 12 : frequency === 'QUARTERLY' ? 3 : 1;
    const d = new Date(now);
    d.setMonth(d.getMonth() + months);
    return d;
  }

  /**
   * Server-side verification used by the return page (never trust redirects).
   *
   * Security: the provider is resolved from the DONATION RECORD, never from
   * the URL. A caller who knows a publicRef cannot point the poll at another
   * provider to force a spurious failure (all live providers answer
   * "failed" for references they do not know, which previously could kill a
   * PENDING donation that another provider had actually charged).
   */
  async verifyStatus(provider: PaymentProvider, publicRef: string) {
    const donation = await this.prisma.donation.findUnique({ where: { publicRef } });
    if (!donation) throw new NotFoundException('Donation not found');

    if (donation.status === DonationStatus.PENDING) {
      // Defence in depth: ignore a provider label that contradicts the record.
      const authoritativeProvider = donation.provider;
      try {
        const adapter = this.payments.adapterFor(authoritativeProvider);
        const result = await adapter.verify(donation.providerReference ?? publicRef);
        if (result.status === 'succeeded') {
          await this.donationPayment.applySuccess({
            publicRef,
            provider: authoritativeProvider,
            providerReference: result.providerReference,
            providerFeeMinor: result.providerFeeMinor,
            providerAuthRef: result.chargeAuthorization,
          });
        } else if (result.status === 'failed') {
          await this.donationPayment.applyFailure({
            publicRef,
            reason: 'provider verification reported failure',
            provider: authoritativeProvider,
          });
        }
      } catch (err) {
        this.logger.warn(`verifyStatus failed for ${publicRef}: ${(err as Error).message}`);
      }
    }

    const fresh = await this.prisma.donation.findUnique({
      where: { publicRef },
      select: {
        publicRef: true,
        status: true,
        amount: true,
        tipAmount: true,
        currency: true,
        receiptNumber: true,
        createdAt: true,
        succeededAt: true,
        campaign: { select: { slug: true, title: true } },
        donor: { select: { firstName: true } },
        guestName: true,
        isAnonymous: true,
      },
    });
    return fresh;
  }

  async getDonation(publicRef: string) {
    const donation = await this.prisma.donation.findUnique({
      where: { publicRef },
      select: {
        publicRef: true,
        status: true,
        amount: true,
        tipAmount: true,
        matchedAmount: true,
        currency: true,
        message: true,
        isAnonymous: true,
        receiptNumber: true,
        createdAt: true,
        succeededAt: true,
        provider: true,
        campaign: { select: { slug: true, title: true, currency: true } },
        donor: { select: { firstName: true, lastName: true } },
        guestName: true,
      },
    });
    if (!donation) throw new NotFoundException('Donation not found');
    return donation;
  }

  async listMine(userId: string, skip: number, limit: number) {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.donation.count({ where: { donorUserId: userId } }),
      this.prisma.donation.findMany({
        where: { donorUserId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { campaign: { select: { slug: true, title: true, coverImageUrl: true } } },
      }),
    ]);
    return { total, items };
  }

  async listCampaignDonors(campaignId: string, skip: number, limit: number) {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.donation.count({ where: { campaignId, status: 'SUCCEEDED' } }),
      this.prisma.donation.findMany({
        where: { campaignId, status: 'SUCCEEDED' },
        orderBy: { succeededAt: 'desc' },
        skip,
        take: limit,
        select: {
          publicRef: true,
          amount: true,
          currency: true,
          message: true,
          isAnonymous: true,
          matchedAmount: true,
          createdAt: true,
          donor: { select: { firstName: true, lastName: true, avatarUrl: true } },
          guestName: true,
        },
      }),
    ]);
    // Mask anonymous donors.
    return {
      total,
      items: items.map((d) => ({
        ...d,
        donorName: d.isAnonymous
          ? 'Anonymous donor'
          : d.donor
            ? `${d.donor.firstName} ${d.donor.lastName.charAt(0)}.`
            : (d.guestName ?? 'Anonymous donor'),
        donor: undefined,
        guestName: undefined,
      })),
    };
  }

  assertCampaignOwnership(campaign: { createdById: string; organizationId: string | null }, user: { id: string; role: string }, orgMemberIds: string[]) {
    const isOwner = campaign.createdById === user.id || orgMemberIds.includes(user.id);
    if (!isOwner && user.role !== 'ADMIN') throw new ForbiddenException('You do not manage this campaign');
  }
}
