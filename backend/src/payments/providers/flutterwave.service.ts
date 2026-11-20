import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { safeEqualHex } from '../../common/utils/crypto.util';
import { decimalsOf } from '../../common/utils/money';
import type {
  InitializeInput,
  InitializeResult,
  PaymentProviderAdapter,
  TransferVerifyResult,
  VerifyResult,
  WebhookVerifyResult,
} from '../provider-adapter.interface';

const BASE = 'https://api.flutterwave.com/v3';

/** Flutterwave reports amounts in MAJOR units; convert with the currency's decimals. */
function majorToMinor(amount: number, currency: string): bigint {
  const d = decimalsOf(currency);
  return BigInt(Math.round(amount * Math.pow(10, d)));
}

@Injectable()
export class FlutterwaveService implements PaymentProviderAdapter {
  readonly name = 'FLUTTERWAVE';

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return Boolean(this.config.get('payments.flutterwave.secretKey'));
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.config.get<string>('payments.flutterwave.secretKey')}`,
      'Content-Type': 'application/json',
    };
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const res = await fetch(`${BASE}/payments`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        tx_ref: input.publicRef,
        amount: Number(input.totalMinor) / 100, // Flutterwave expects major units
        currency: input.currency,
        redirect_url: input.callbackUrl,
        customer: { email: input.donorEmail, name: input.donorName },
        customizations: { title: input.campaignTitle, description: `Donation to ${input.campaignTitle}` },
        meta: input.metadata,
      }),
    });
    const body = (await res.json()) as { status: string; message?: string; data?: { link: string } };
    if (!res.ok || body.status !== 'success' || !body.data) {
      throw new Error(`Flutterwave init failed: ${body.message ?? res.status}`);
    }
    return { redirectUrl: body.data.link, providerReference: input.publicRef };
  }

  /**
   * Authoritative verification against the Flutterwave API. Flutterwave emits
   * `charge.completed` webhooks for BOTH successful and failed charges, so the
   * webhook path must never trust the event alone — the API's `data.status`
   * ('successful') is the source of truth. Amount/currency are returned for
   * equality checks against the donation record.
   */
  async verify(reference: string): Promise<VerifyResult> {
    const res = await fetch(`${BASE}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
      headers: this.headers(),
    });
    const body = (await res.json()) as {
      status: string;
      data?: { id: number; status: string; tx_ref: string; app_fee?: number; amount?: number; currency?: string };
    };
    if (!res.ok || body.status !== 'success' || !body.data) return { status: 'failed', providerReference: reference };
    const succeeded = body.data.status === 'successful';
    return {
      status: succeeded ? 'succeeded' : body.data.status === 'failed' ? 'failed' : 'pending',
      providerReference: String(body.data.id),
      providerFeeMinor: body.data.app_fee != null ? BigInt(Math.round(body.data.app_fee * 100)) : undefined,
      amountMinor: body.data.amount != null ? majorToMinor(body.data.amount, body.data.currency ?? 'NGN') : undefined,
      currency: body.data.currency,
    };
  }

  /** Executes a refund via the Flutterwave API. providerReference is the FLW transaction id. */
  async refund(providerReference: string, amountMinor?: bigint): Promise<{ providerRef: string }> {
    const res = await fetch(`${BASE}/transactions/${encodeURIComponent(providerReference)}/refund`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(
        amountMinor != null
          ? { amount: Number(amountMinor) / 100 }
          : {},
      ),
    });
    const body = (await res.json()) as { status?: string; message?: string; data?: { id?: number } };
    if (!res.ok || body.status !== 'success') throw new Error(`Flutterwave refund failed: ${body.message ?? res.status}`);
    return { providerRef: String(body.data?.id ?? 'flutterwave') };
  }

  /**
   * v1.0.4 §5.1 — authoritative TRANSFER verification (read-only GET).
   * Flutterwave reports amounts in MAJOR units; convert for equality checks.
   * Unknown id -> exists=false (never a failure).
   */
  async verifyTransfer(referenceOrId: string): Promise<TransferVerifyResult> {
    const res = await fetch(`${BASE}/transfers/${encodeURIComponent(referenceOrId)}`, {
      headers: this.headers(),
    });
    const body = (await res.json()) as {
      status?: string;
      message?: string;
      data?: {
        id?: number;
        status?: string;
        amount?: number;
        currency?: string;
        reference?: string;
        bank_code?: string;
        account_number?: string;
      };
    };
    if (!res.ok || body.status !== 'success' || !body.data) {
      return { exists: false, providerStatus: null, providerReference: referenceOrId };
    }
    const d = body.data;
    return {
      exists: true,
      providerStatus: d.status ?? null,
      providerReference: d.reference ?? (d.id != null ? String(d.id) : referenceOrId),
      amountMinor: d.amount != null && d.currency ? majorToMinor(d.amount, d.currency) : undefined,
      currency: d.currency,
      destinationRef: d.account_number ? `${d.bank_code ?? ''}:${d.account_number}` : undefined,
    };
  }

  /** Flutterwave compares the raw `verif-hash` header against the secret hash configured in the dashboard. */
  async verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): Promise<WebhookVerifyResult> {
    const hash = Array.isArray(headers['verif-hash']) ? headers['verif-hash'][0] : headers['verif-hash'];
    const expected = this.config.get<string>('payments.flutterwave.webhookHash') ?? '';
    if (!hash || !expected || !safeEqualHex(hash, expected)) return { valid: false };
    try {
      const payload = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as {
        event?: string;
        data?: { tx_ref?: string; reference?: string; id?: number; status?: string; amount?: number; currency?: string };
      };
      const cur = payload.data?.currency;
      return {
        valid: true,
        eventType: payload.event,
        // Donation events carry tx_ref; payout transfer events carry the
        // KINDORA submission `reference` (v1.0.7 §13). Both map to `reference`.
        reference: payload.data?.tx_ref ?? payload.data?.reference,
        eventId: payload.data?.id ? String(payload.data.id) : undefined,
        // Callers MUST check dataStatus: 'charge.completed' fires for failed charges too.
        dataStatus: payload.data?.status,
        amountMinor: payload.data?.amount != null && cur ? majorToMinor(payload.data.amount, cur) : undefined,
        currency: cur,
      };
    } catch {
      return { valid: false };
    }
  }
}
