import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hmacHex, safeEqualHex, sha256Hex } from '../../common/utils/crypto.util';
import type {
  InitializeInput,
  InitializeResult,
  PaymentProviderAdapter,
  TransferVerifyResult,
  VerifyResult,
  WebhookVerifyResult,
} from '../provider-adapter.interface';

const BASE = 'https://api.paystack.co';

@Injectable()
export class PaystackService implements PaymentProviderAdapter {
  readonly name = 'PAYSTACK';

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return Boolean(this.config.get('payments.paystack.secretKey'));
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.config.get<string>('payments.paystack.secretKey')}`,
      'Content-Type': 'application/json',
    };
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const res = await fetch(`${BASE}/transaction/initialize`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        email: input.donorEmail,
        amount: Number(input.totalMinor),
        currency: input.currency,
        reference: input.publicRef,
        callback_url: input.callbackUrl,
        metadata: { donationId: input.donationId, campaignTitle: input.campaignTitle, ...(input.metadata ?? {}) },
      }),
    });
    const body = (await res.json()) as { status: boolean; message?: string; data?: { authorization_url: string; reference: string } };
    if (!res.ok || !body.status || !body.data) {
      throw new Error(`Paystack init failed: ${body.message ?? res.status}`);
    }
    return { redirectUrl: body.data.authorization_url, providerReference: body.data.reference };
  }

  /**
   * Authoritative transaction verification against the Paystack API.
   * Returns the provider-reported amount/currency and the saved-card
   * authorization token so callers can prove amount + currency equality
   * against the donation record before moving money.
   */
  async verify(reference: string): Promise<VerifyResult> {
    const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: this.headers(),
    });
    const body = (await res.json()) as {
      status: boolean;
      data?: {
        status: string;
        reference: string;
        amount?: number;
        currency?: string;
        fees?: number;
        fee_charged?: number;
        authorization?: { authorization_token?: string };
      };
    };
    if (!res.ok || !body.status || !body.data) return { status: 'failed', providerReference: reference };
    const fee = body.data.fees ?? body.data.fee_charged;
    return {
      status: body.data.status === 'success' ? 'succeeded' : body.data.status === 'abandoned' ? 'pending' : 'failed',
      providerReference: body.data.reference,
      providerFeeMinor: fee != null ? BigInt(fee) : undefined,
      amountMinor: body.data.amount != null ? BigInt(body.data.amount) : undefined,
      currency: body.data.currency,
      chargeAuthorization: body.data.authorization?.authorization_token || undefined,
    };
  }

  /** Executes a refund via the Paystack API. Amount in minor units; omit for full refund. */
  async refund(providerReference: string, amountMinor?: bigint): Promise<{ providerRef: string }> {
    const res = await fetch(`${BASE}/refund`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        transaction: providerReference,
        ...(amountMinor != null ? { amount: Number(amountMinor) } : {}),
      }),
    });
    const body = (await res.json()) as { status?: boolean; message?: string; data?: { reference?: string; id?: number } };
    if (!res.ok || !body.status) throw new Error(`Paystack refund failed: ${body.message ?? res.status}`);
    return { providerRef: body.data?.reference ?? String(body.data?.id ?? 'paystack') };
  }

  /**
   * v1.0.4 §5.1 — authoritative TRANSFER verification (read-only GET).
   * Accepts a transfer code (TRF_...) or numeric transfer id. Amount is
   * returned in minor units (Paystack reports minor units) so PayoutService
   * can prove amount equality before any settlement transition.
   */
  async verifyTransfer(referenceOrId: string): Promise<TransferVerifyResult> {
    const res = await fetch(`${BASE}/transfer/${encodeURIComponent(referenceOrId)}`, {
      headers: this.headers(),
    });
    const body = (await res.json()) as {
      status?: boolean;
      message?: string;
      data?: {
        transfer_code?: string;
        reference?: string;
        id?: number;
        status?: string;
        amount?: number;
        currency?: string;
        recipient?: { recipient_code?: string; details?: Record<string, unknown> };
      };
    };
    // A 404 or !status means the provider knows nothing about this reference:
    // report exists=false (unknown — never a failure).
    if (!res.ok || !body.status || !body.data) {
      return { exists: false, providerStatus: null, providerReference: referenceOrId };
    }
    const d = body.data;
    return {
      exists: true,
      providerStatus: d.status ?? null,
      providerReference: d.reference ?? d.transfer_code ?? String(d.id ?? referenceOrId),
      amountMinor: d.amount != null ? BigInt(d.amount) : undefined,
      currency: d.currency,
      destinationRef: d.recipient?.recipient_code,
    };
  }

  /** Paystack signs webhooks with HMAC SHA512 of the raw body using the secret key. */
  async verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): Promise<WebhookVerifyResult> {
    const signature = Array.isArray(headers['x-paystack-signature']) ? headers['x-paystack-signature'][0] : headers['x-paystack-signature'];
    if (!signature) return { valid: false };
    const secret = this.config.get<string>('payments.paystack.secretKey') ?? '';
    if (!secret) return { valid: false };
    const expected = hmacHex('sha512', secret, rawBody);
    if (!safeEqualHex(expected, signature)) return { valid: false };

    try {
      const payload = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as {
        event?: string;
        data?: { reference?: string; amount?: number; currency?: string };
      };
      return {
        valid: true,
        // Paystack omits an event id; the SHA-256 of the exact signed body
        // deterministically identifies a replayed delivery (same body => same id),
        // giving webhook-level dedupe without provider support.
        eventId: sha256Hex(rawBody),
        eventType: payload.event,
        reference: payload.data?.reference,
        amountMinor: payload.data?.amount != null ? BigInt(payload.data.amount) : undefined,
        currency: payload.data?.currency,
      };
    } catch {
      return { valid: false };
    }
  }
}
