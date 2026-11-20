import { BadRequestException, Controller, Logger, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../common/prisma.service';
import { PaymentsService } from './payments.service';
import { DonationPaymentService } from './donation-payment.service';
import { RefundProcessorService } from './refund-processor.service';
import { PayoutVerificationService } from '../payouts/payout-verification.service';
import { classifyProviderEvent } from './event-classification';
import { PaymentProvider } from '@prisma/client';
import { Prisma } from '@prisma/client';

/**
 * Provider webhook endpoints — the ONLY public money-mutation entry point.
 *
 * Hardening rules enforced here (see SECURITY_AUDIT.md §webhooks):
 *  1. Signature verification over the RAW body; invalid signatures get 401.
 *  2. Every delivery is recorded as a WebhookEvent row with DB-level
 *     (provider,eventId) uniqueness — duplicate/concurrent deliveries are
 *     safely absorbed (P2002 conflict => treated as duplicate).
 *  3. Event types are routed through an explicit per-provider allowlist
 *     (default-deny): unknown events are acknowledged (200) but NEVER change
 *     donation financial state.
 *  4. A webhook signature only TRIGGERS verification. Successful payment
 *     events are re-verified against the provider API (status, amount,
 *     currency) before anything is applied. The webhook payload amount is
 *     never trusted by itself.
 *  5. The provider receiving the webhook must match the provider recorded on
 *     the donation — cross-provider completion is rejected.
 *  6. Unknown references are acknowledged (200) with FAILED_REFERENCE status
 *     instead of erroring — prevents provider retry storms on junk refs.
 *  7. Refund/dispute events are routed to the refund processor which posts
 *     compensating ledger entries; they never count as donations.
 */
@Controller('payments')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly donationPayment: DonationPaymentService,
    private readonly refundProcessor: RefundProcessorService,
    private readonly payoutVerification: PayoutVerificationService,
    private readonly prisma: PrismaService,
  ) {}

  private parsePayload(rawBody: Buffer | string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private async markEvent(id: string, status: 'PROCESSED' | 'FAILED', action: string, error?: string) {
    await this.prisma.webhookEvent
      .update({
        where: { id },
        data: { status, processedAt: new Date(), handledAction: action, ...(error ? { error: error.slice(0, 500) } : {}) },
      })
      .catch(() => undefined);
  }

  private async handle(provider: PaymentProvider, req: Request) {
    const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? (req.body as Buffer);
    if (!rawBody) throw new BadRequestException('Missing body');
    const headers = req.headers;

    const result = await this.payments.adapterFor(provider).verifyWebhook(rawBody, headers);
    if (!result.valid) {
      await this.prisma.webhookEvent.create({
        data: { provider, signatureValid: false, status: 'FAILED', error: 'signature verification failed' },
      });
      throw new BadRequestException('Invalid signature');
    }

    // Record the delivery first (audit + dedupe). Unique (provider,eventId)
    // makes concurrent duplicate deliveries exactly-once; the loser of the
    // insert race is treated as a duplicate instead of erroring with a 500.
    let eventRowId: string;
    let duplicate = false;
    try {
      const created = await this.prisma.webhookEvent.create({
        data: {
          provider,
          eventId: result.eventId,
          eventType: result.eventType,
          reference: result.reference,
          signatureValid: true,
          status: 'RECEIVED',
          payload: (this.parsePayload(rawBody) as Prisma.InputJsonValue | undefined),
        },
      });
      eventRowId = created.id;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        duplicate = true;
        eventRowId = '';
        this.logger.log(`Duplicate webhook delivery absorbed (${provider} ${result.eventId ?? 'no-id'})`);
      } else {
        throw err;
      }
    }
    if (duplicate) return { received: true, duplicate: true };

    const eventClass = classifyProviderEvent(provider, result.eventType);
    let action = 'IGNORED_UNRECOGNIZED';

    try {
      switch (eventClass) {
        case 'SUCCESS':
          action = await this.applyVerifiedSuccess(provider, result);
          break;
        case 'TERMINAL_FAILURE':
          if (provider === 'FLUTTERWAVE' && result.dataStatus && result.dataStatus !== 'failed') {
            // 'charge.completed' with a non-failed, non-successful status => not terminal.
            action = 'IGNORED_INDETERMINATE';
            break;
          }
          action = await this.applyFailureSafely(provider, result);
          break;
        case 'REFUND':
          action = await this.refundProcessor.applyProviderRefundEvent(provider, result);
          break;
        case 'PAYOUT_TRANSFER':
          // v1.0.7 §13 — signed transfer events only TRIGGER verification
          // against the provider API. The webhook payload itself is never
          // trusted for settlement; a late or out-of-order event re-derives
          // the same authoritative state through the atomic reconciler.
          action = await this.applyPayoutTransferEvent(provider, result);
          break;
        case 'DISPUTE':
          action = await this.refundProcessor.recordDispute(provider, result);
          break;
        case 'UNKNOWN':
        default:
          // Default-deny: record and acknowledge; never touch money state.
          this.logger.warn(`Unrecognized ${provider} webhook event "${result.eventType ?? 'n/a'}" recorded, no financial action`);
          action = 'IGNORED_UNRECOGNIZED';
          break;
      }
      await this.markEvent(eventRowId, 'PROCESSED', action);
    } catch (err) {
      // Transient failure (DB, provider API): mark FAILED and rethrow so the
      // provider retries; permanent handling decisions above never throw.
      await this.markEvent(eventRowId, 'FAILED', 'ERROR', (err as Error).message);
      throw err;
    }
    return { received: true };
  }

  /** Authoritative success path: verify with the provider API before applying. */
  private async applyVerifiedSuccess(
    provider: PaymentProvider,
    webhook: { reference?: string; amountMinor?: bigint; currency?: string; dataStatus?: string },
  ): Promise<string> {
    const reference = webhook.reference;
    if (!reference) return 'NO_REFERENCE';
    const donation = await this.prisma.donation.findUnique({ where: { publicRef: reference } });
    if (!donation) {
      // Acknowledge junk references (200) — retrying would never succeed.
      this.logger.warn(`${provider} webhook for unknown reference ${reference} recorded`);
      return 'REFERENCE_NOT_FOUND';
    }
    if (donation.status !== 'PENDING') {
      // Already terminal (success/failure applied by another delivery).
      return 'ALREADY_RESOLVED';
    }
    if (donation.provider !== provider) {
      // Cross-provider confusion guard: a validly-signed Paystack event must
      // never complete a Flutterwave donation (and vice versa).
      this.logger.error(
        `PROVIDER MISMATCH: ${provider} webhook for donation ${reference} whose provider is ${donation.provider}. Rejected.`,
      );
      return 'PROVIDER_MISMATCH';
    }
    if (provider === 'FLUTTERWAVE' && webhook.dataStatus && webhook.dataStatus !== 'successful') {
      // Flutterwave emits charge.completed for failed charges as well.
      return 'FLW_STATUS_NOT_SUCCESSFUL';
    }

    // 1. Authoritative provider verification (the webhook is only a trigger).
    let verified;
    try {
      verified = await this.payments.adapterFor(provider).verify(donation.providerReference ?? reference);
    } catch (err) {
      this.logger.warn(`Verification unavailable for ${reference}; leaving PENDING: ${(err as Error).message}`);
      return 'VERIFICATION_UNAVAILABLE';
    }
    if (verified.status === 'failed') {
      await this.donationPayment.applyFailure({ publicRef: reference, reason: 'provider verification reported failure' });
      return 'FAILURE_APPLIED';
    }
    if (verified.status !== 'succeeded') {
      return 'VERIFICATION_PENDING';
    }

    // 2. Amount equality: the charged amount must match amount + tip exactly.
    const expected = donation.amount + donation.tipAmount;
    if (verified.amountMinor != null && verified.amountMinor !== expected) {
      this.logger.error(
        `AMOUNT MISMATCH for ${reference}: provider charged ${verified.amountMinor}, expected ${expected}. Rejected.`,
      );
      return 'AMOUNT_MISMATCH';
    }
    if (verified.amountMinor == null && provider !== 'MOCK') {
      // A live provider success without an amount is unverifiable — fail safe.
      this.logger.error(`UNVERIFIABLE SUCCESS for ${reference}: provider did not report an amount. Rejected.`);
      return 'AMOUNT_UNAVAILABLE';
    }

    // 3. Currency equality.
    if (verified.currency && verified.currency.toUpperCase() !== donation.currency.toUpperCase()) {
      this.logger.error(
        `CURRENCY MISMATCH for ${reference}: provider ${verified.currency}, donation ${donation.currency}. Rejected.`,
      );
      return 'CURRENCY_MISMATCH';
    }

    await this.donationPayment.applySuccess({
      publicRef: reference,
      provider,
      providerReference: verified.providerReference,
      providerFeeMinor: verified.providerFeeMinor,
      providerAuthRef: verified.chargeAuthorization,
    });
    return 'SUCCESS_APPLIED';
  }

  /** Failure path with the same provider-mismatch discipline. */
  private async applyFailureSafely(
    provider: PaymentProvider,
    webhook: { reference?: string; eventType?: string },
  ): Promise<string> {
    const reference = webhook.reference;
    if (!reference) return 'NO_REFERENCE';
    const donation = await this.prisma.donation.findUnique({ where: { publicRef: reference } });
    if (!donation) return 'REFERENCE_NOT_FOUND';
    if (donation.provider !== provider) return 'PROVIDER_MISMATCH';
    await this.donationPayment.applyFailure({
      publicRef: reference,
      reason: `provider event: ${webhook.eventType ?? 'terminal failure'}`,
      provider,
    });
    return 'FAILURE_APPLIED';
  }

  /**
   * v1.0.7 §13 — payout transfer webhook handling. Associates the event with
   * the payout attempt via the provider transfer reference/id, then verifies
   * against the provider API. Outcomes:
   *   ATTEMPT_NOT_FOUND       recorded, no state change (donation refs may collide)
   *   ATTEMPT_ALREADY_RESOLVED idempotent ack
   *   VERIFICATION_TRIGGERED  authoritative verification ran
   *   VERIFICATION_FAILED     provider API unavailable — event stays RECORDED;
   *                           the recovery sweep + escalation window cover it
   */
  private async applyPayoutTransferEvent(
    provider: PaymentProvider,
    webhook: { reference?: string; eventId?: string; dataStatus?: string },
  ): Promise<string> {
    const providerRef = webhook.reference;
    if (!providerRef) return 'PAYOUT_EVENT_NO_REFERENCE';
    try {
      const result = await this.payoutVerification.verifyFromWebhook(provider, providerRef, webhook.eventId, webhook.dataStatus);
      return result.action === 'VERIFICATION_TRIGGERED' ? `PAYOUT_${result.action}:${result.outcome ?? ''}` : `PAYOUT_${result.action}`;
    } catch (err) {
      this.logger.warn(`Payout transfer webhook verification failed (${provider} ${providerRef}): ${(err as Error).message}`);
      return 'PAYOUT_VERIFICATION_FAILED';
    }
  }

  @Public()
  @Post('paystack/webhook')
  paystack(@Req() req: Request) {
    return this.handle('PAYSTACK', req);
  }

  @Public()
  @Post('flutterwave/webhook')
  flutterwave(@Req() req: Request) {
    return this.handle('FLUTTERWAVE', req);
  }

  @Public()
  @Post('stripe/webhook')
  stripe(@Req() req: Request) {
    return this.handle('STRIPE', req);
  }

  @Public()
  @Post('paypal/webhook')
  paypal(@Req() req: Request) {
    return this.handle('PAYPAL', req);
  }
}
