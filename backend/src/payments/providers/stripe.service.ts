import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type {
  InitializeInput,
  InitializeResult,
  PaymentProviderAdapter,
  VerifyResult,
  WebhookVerifyResult,
} from '../provider-adapter.interface';

@Injectable()
export class StripeService implements PaymentProviderAdapter {
  readonly name = 'STRIPE';
  private client: Stripe | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Stripe | null {
    const key = this.config.get<string>('payments.stripe.secretKey');
    if (!key) return null;
    if (!this.client) this.client = new Stripe(key);
    return this.client;
  }

  isEnabled(): boolean {
    return Boolean(this.config.get('payments.stripe.secretKey'));
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const client = this.getClient();
    if (!client) throw new Error('Stripe is not configured');
    const session = await client.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: Number(input.totalMinor),
            product_data: { name: `Donation: ${input.campaignTitle}`.slice(0, 100) },
          },
        },
      ],
      success_url: input.callbackUrl,
      cancel_url: input.callbackUrl,
      client_reference_id: input.publicRef,
      metadata: { donationId: input.donationId, publicRef: input.publicRef },
    });
    return { redirectUrl: session.url!, providerReference: session.id };
  }

  /**
   * Authoritative verification against the Stripe API. `payment_status` is the
   * source of truth; `amount_total`/`currency` are returned for equality
   * checks against the donation record before money is moved.
   */
  async verify(reference: string): Promise<VerifyResult> {
    const client = this.getClient();
    if (!client) return { status: 'failed', providerReference: reference };
    const session = await client.checkout.sessions.retrieve(reference);
    return {
      status:
        session.payment_status === 'paid'
          ? 'succeeded'
          : session.status === 'expired'
            ? 'failed'
            : 'pending',
      providerReference: session.id,
      amountMinor: session.amount_total != null ? BigInt(session.amount_total) : undefined,
      currency: session.currency?.toUpperCase(),
    };
  }

  /** Executes a refund via the Stripe API (via the session's payment intent). */
  async refund(providerReference: string, amountMinor?: bigint): Promise<{ providerRef: string }> {
    const client = this.getClient();
    if (!client) throw new Error('Stripe is not configured');
    const session = await client.checkout.sessions.retrieve(providerReference);
    if (!session.payment_intent) throw new Error('Stripe session has no payment intent to refund');
    const refund = await client.refunds.create({
      payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id,
      ...(amountMinor != null ? { amount: Number(amountMinor) } : {}),
    });
    return { providerRef: refund.id };
  }

  /**
   * Verifies the Stripe-Signature header against the raw body using the
   * webhook signing secret. Uses the official stripe SDK signature check.
   */
  async verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): Promise<WebhookVerifyResult> {
    const signature = (Array.isArray(headers['stripe-signature']) ? headers['stripe-signature'][0] : headers['stripe-signature']) ?? '';
    const secret = this.config.get<string>('payments.stripe.webhookSecret') ?? '';
    const client = this.getClient();
    if (!signature || !secret || !client) return { valid: false };
    try {
      const event = client.webhooks.constructEvent(rawBody, signature, secret);
      const obj = event.data.object as unknown as Record<string, unknown>;
      const reference =
        (obj.client_reference_id as string | undefined) ??
        ((obj.metadata as Record<string, string> | undefined)?.publicRef ?? undefined);
      const amount = obj.amount_total as number | undefined;
      const currency = obj.currency as string | undefined;
      return {
        valid: true,
        eventId: event.id,
        eventType: event.type,
        reference,
        amountMinor: amount != null ? BigInt(amount) : undefined,
        currency: currency?.toUpperCase(),
      };
    } catch {
      return { valid: false };
    }
  }
}
