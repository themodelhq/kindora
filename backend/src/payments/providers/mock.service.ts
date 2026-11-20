import { Injectable } from '@nestjs/common';
import type {
  InitializeInput,
  InitializeResult,
  PaymentProviderAdapter,
  TransferVerifyResult,
  VerifyResult,
  WebhookVerifyResult,
} from '../provider-adapter.interface';

/**
 * Deterministic in-process provider used for automated tests (PROVIDER_MODE=mock)
 * and offline development. Hard-gated: PaymentsService never resolves this
 * adapter outside mock mode, and production startup rejects mock mode, so
 * mock "payments" can never reach production money paths.
 */
@Injectable()
export class MockProviderService implements PaymentProviderAdapter {
  readonly name = 'MOCK';

  isEnabled(): boolean {
    return true;
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const providerReference = `mock_${input.publicRef}`;
    const redirectUrl = `${input.callbackUrl}${input.callbackUrl.includes('?') ? '&' : '?'}mock=1&reference=${input.publicRef}`;
    return { redirectUrl, providerReference };
  }

  async verify(reference: string): Promise<VerifyResult> {
    // amountMinor/currency intentionally omitted: the mock cannot know the
    // expected amount. The payment layer treats a live-provider success
    // without an amount as unverifiable; mock mode is exempt (tests only).
    return { status: 'succeeded', providerReference: reference, providerFeeMinor: 0n };
  }

  async verifyWebhook(rawBody: Buffer | string): Promise<WebhookVerifyResult> {
    try {
      const payload = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as {
        reference?: string;
        event?: string;
        status?: string;
      };
      return {
        valid: true,
        eventId: `mock-${payload.reference ?? 'unknown'}-${payload.event ?? 'charge.success'}`,
        eventType: payload.event ?? 'charge.success',
        reference: payload.reference,
        dataStatus: payload.status ?? 'successful',
      };
    } catch {
      return { valid: false };
    }
  }

  async refund(providerReference: string): Promise<{ providerRef: string }> {
    return { providerRef: `mock_reversal_${providerReference}` };
  }

  /**
   * v1.0.4 §5.1 — deterministic transfer verification for automated tests.
   * The reference encodes the outcome so tests can drive every branch:
   *   ..._OK / _SUCCESS  -> success   ..._FAIL(x) -> authoritative failure
   *   ..._PEND           -> pending   ..._REV     -> reversed
   *   anything else      -> unknown (exists=false)
   * Mock mode is forbidden in production (startup validation), so this can
   * never influence real money.
   */
  async verifyTransfer(referenceOrId: string): Promise<TransferVerifyResult> {
    const ref = referenceOrId.toUpperCase();
    const amountMatch = /AMT(\d+)/.exec(ref);
    if (ref.includes('_OK') || ref.includes('_SUCCESS')) {
      return {
        exists: true,
        providerStatus: 'success',
        providerReference: referenceOrId,
        amountMinor: amountMatch ? BigInt(amountMatch[1]) : undefined,
        currency: 'NGN',
        destinationRef: 'MOCK:0000000000',
      };
    }
    const failMatch = /_FAIL\(([^)]+)\)/.exec(ref);
    if (failMatch) {
      return {
        exists: true,
        providerStatus: 'failed',
        providerReference: referenceOrId,
        currency: 'NGN',
      };
    }
    if (ref.includes('_PEND')) {
      return { exists: true, providerStatus: 'pending', providerReference: referenceOrId, currency: 'NGN' };
    }
    if (ref.includes('_REV')) {
      return { exists: true, providerStatus: 'reversed', providerReference: referenceOrId, currency: 'NGN' };
    }
    return { exists: false, providerStatus: null, providerReference: referenceOrId };
  }
}
