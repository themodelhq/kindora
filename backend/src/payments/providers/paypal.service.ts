import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { majorValue } from '../../common/utils/money';
import type {
  InitializeInput,
  InitializeResult,
  PaymentProviderAdapter,
  VerifyResult,
  WebhookVerifyResult,
} from '../provider-adapter.interface';

interface PaypalOrderBody {
  id?: string;
  status?: string;
  event_type?: string;
  resource_type?: string;
  resource?: {
    amount?: { value?: string; currency_code?: string };
    purchase_units?: {
      reference_id?: string;
      payments?: { captures?: { id?: string; status?: string; amount?: { value?: string; currency_code?: string } }[] };
    }[];
  };
  purchase_units?: {
    payments?: { captures?: { id?: string; status?: string; amount?: { value?: string; currency_code?: string } }[] };
    reference_id?: string;
    custom_id?: string;
  }[];
}

function parseJson(raw: Buffer | string): PaypalOrderBody | null {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as PaypalOrderBody;
  } catch {
    return null;
  }
}

@Injectable()
export class PaypalService implements PaymentProviderAdapter {
  readonly name = 'PAYPAL';
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private base(): string {
    return this.config.get('payments.paypal.env') === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  isEnabled(): boolean {
    return Boolean(this.config.get('payments.paypal.clientId'));
  }

  private async accessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30_000) return this.tokenCache.token;
    const id = this.config.get<string>('payments.paypal.clientId') ?? '';
    const secret = this.config.get<string>('payments.paypal.clientSecret') ?? '';
    const res = await fetch(`${this.base()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new Error('PayPal OAuth failed');
    this.tokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const token = await this.accessToken();
    const res = await fetch(`${this.base()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.publicRef,
            custom_id: input.donationId,
            amount: { currency_code: input.currency, value: majorValue(input.totalMinor, input.currency).toFixed(2) },
            description: `Donation: ${input.campaignTitle}`.slice(0, 127),
          },
        ],
        application_context: {
          brand_name: 'KINDORA',
          user_action: 'PAY_NOW',
          // PayPal returns the payer to the frontend; the backend verifies server-side.
          return_url: input.callbackUrl,
          cancel_url: input.callbackUrl,
        },
      }),
    });
    const body = (await res.json()) as { id: string; links?: { rel: string; href: string }[] };
    if (!res.ok || !body.id) throw new Error('PayPal order creation failed');
    const approve = body.links?.find((l) => l.rel === 'approve')?.href;
    return { redirectUrl: approve ?? '', providerReference: body.id };
  }

  /**
   * Authoritative verification against the PayPal API. Order status COMPLETED
   * alone is not enough: the capture (purchase_units[0].payments.captures[0])
   * must be COMPLETED — an approved-but-uncaptured order never moves money.
   * Capture amount/currency are returned for equality checks.
   */
  async verify(reference: string): Promise<VerifyResult> {
    const token = await this.accessToken();
    const res = await fetch(`${this.base()}/v2/checkout/orders/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as PaypalOrderBody;
    if (!res.ok || !body.id) return { status: 'failed', providerReference: reference };
    const capture = body.purchase_units?.[0]?.payments?.captures?.[0];
    const captureSucceeded = capture?.status === 'COMPLETED';
    let amountMinor: bigint | undefined;
    if (capture?.amount?.value != null && capture.amount.currency_code) {
      try {
        amountMinor = BigInt(Math.round(Number(capture.amount.value) * 100));
      } catch {
        amountMinor = undefined;
      }
    }
    return {
      status: captureSucceeded ? 'succeeded' : body.status === 'VOIDED' ? 'failed' : 'pending',
      providerReference: capture?.id ?? body.id,
      amountMinor,
      currency: capture?.amount?.currency_code,
    };
  }

  /** Executes a refund via the PayPal capture refund API. */
  async refund(providerReference: string, amountMinor?: bigint): Promise<{ providerRef: string }> {
    const token = await this.accessToken();
    // providerReference may be an order id; resolve the capture first.
    let captureId = providerReference;
    if (!providerReference.startsWith('CAP')) {
      const orderRes = await fetch(`${this.base()}/v2/checkout/orders/${encodeURIComponent(providerReference)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const order = (await orderRes.json()) as PaypalOrderBody;
      captureId = order.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? providerReference;
    }
    const res = await fetch(`${this.base()}/v2/payments/captures/${encodeURIComponent(captureId)}/refunds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(amountMinor != null ? { amount: { value: (Number(amountMinor) / 100).toFixed(2) } } : {}),
    });
    const body = (await res.json()) as { id?: string; message?: string };
    if (!res.ok || !body.id) throw new Error(`PayPal refund failed: ${body.message ?? res.status}`);
    return { providerRef: body.id };
  }

  /** PayPal webhook signature verification via the official verification API. */
  async verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): Promise<WebhookVerifyResult> {
    const webhookId = this.config.get<string>('payments.paypal.webhookId') ?? '';
    if (!webhookId) return { valid: false };
    const payload = parseJson(rawBody);
    if (!payload) return { valid: false };

    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      return { valid: false };
    }
    const transmissionId = headers['paypal-transmission-id'] as string | undefined;
    const transmissionTime = headers['paypal-transmission-time'] as string | undefined;
    const certUrl = headers['paypal-cert-url'] as string | undefined;
    const authAlgo = headers['paypal-auth-algo'] as string | undefined;
    const transmissionSig = headers['paypal-transmission-sig'] as string | undefined;
    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) return { valid: false };

    try {
      const res = await fetch(`${this.base()}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_algo: authAlgo,
          cert_url: certUrl,
          transmission_id: transmissionId,
          transmission_sig: transmissionSig,
          transmission_time: transmissionTime,
          webhook_id: webhookId,
          webhook_event: payload,
        }),
      });
      const body = (await res.json()) as { verification_status?: string; id?: string; event_type?: string };
      const capture = payload.resource;
      let amountMinor: bigint | undefined;
      if (capture?.amount?.value != null && capture.amount.currency_code) {
        try {
          amountMinor = BigInt(Math.round(Number(capture.amount.value) * 100));
        } catch {
          amountMinor = undefined;
        }
      }
      return {
        valid: body.verification_status === 'SUCCESS',
        eventId: payload.id ?? body.id,
        eventType: payload.event_type,
        reference: payload.resource_type === 'checkout-order'
          ? payload.resource?.purchase_units?.[0]?.reference_id
          : payload.resource?.purchase_units?.[0]?.reference_id,
        amountMinor,
        currency: capture?.amount?.currency_code,
      };
    } catch {
      return { valid: false };
    }
  }
}
