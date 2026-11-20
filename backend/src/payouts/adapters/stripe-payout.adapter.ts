import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayoutProviderUnsupportedError, type PayoutBeneficiaryInput, type PayoutLookupResult, type PayoutProviderAdapter, type PayoutTransferInitiationInput, type PayoutTransferInitiationResult, type ResolvedBeneficiary } from '../payout-provider.adapter';

/**
 * STRIPE payout adapter — payouts are DISABLED (v1.0.7 §6, reaffirmed v1.0.9 §8).
 *
 * Stripe DONATIONS remain fully supported (checkout + verification + refunds
 * via the donation adapter). Stripe PAYOUTS (Connect transfers) were never
 * implemented; v1.0.6 mapped payout verification for Stripe onto the Paystack
 * verifier, which is unacceptable. This adapter is in the registry ONLY to
 * reject payout attempts explicitly, with an honest, actionable message —
 * no Stripe payout request is ever routed through Paystack or Flutterwave.
 *
 * A genuine Stripe payout implementation (its own initiation, verification,
 * beneficiary validation, status normalization, idempotency, reconciliation
 * and sandbox tests) is required before Stripe can re-enter the active
 * payout registry. See docs/PAYOUT_ARCHITECTURE_V1.0.9.md §Stripe.
 */
@Injectable()
export class StripePayoutAdapter implements PayoutProviderAdapter {
  readonly name = 'STRIPE';
  static readonly DISABLED_REASON =
    'Stripe payouts are disabled: Stripe Connect transfers are not implemented. Stripe donations remain supported. Payouts are available via Paystack, Flutterwave or manual settlement.';

  constructor(private readonly config: ConfigService) {}

  supportsPayouts(): boolean {
    return false;
  }

  validatePayoutConfig(): { ok: boolean; reason?: string } {
    return { ok: false, reason: StripePayoutAdapter.DISABLED_REASON };
  }

  private reject(): never {
    throw new PayoutProviderUnsupportedError(this.name, StripePayoutAdapter.DISABLED_REASON);
  }

  async resolveBeneficiary(_input: PayoutBeneficiaryInput): Promise<ResolvedBeneficiary> {
    this.reject();
  }

  async initiateTransfer(_input: PayoutTransferInitiationInput): Promise<PayoutTransferInitiationResult> {
    this.reject();
  }

  async getTransfer(_refOrId: string): Promise<PayoutLookupResult> {
    this.reject();
  }

  async findTransferByReference(_reference: string): Promise<PayoutLookupResult> {
    this.reject();
  }
}

/** PayPal payouts are likewise not implemented — donations only. */
@Injectable()
export class PaypalPayoutAdapter implements PayoutProviderAdapter {
  readonly name = 'PAYPAL';
  static readonly DISABLED_REASON =
    'PayPal payouts are not implemented in KINDORA. PayPal donations remain supported. Payouts are available via Paystack, Flutterwave or manual settlement.';

  constructor(private readonly config: ConfigService) {}

  supportsPayouts(): boolean {
    return false;
  }

  validatePayoutConfig(): { ok: boolean; reason?: string } {
    return { ok: false, reason: PaypalPayoutAdapter.DISABLED_REASON };
  }

  private reject(): never {
    throw new PayoutProviderUnsupportedError(this.name, PaypalPayoutAdapter.DISABLED_REASON);
  }

  async resolveBeneficiary(_input: PayoutBeneficiaryInput): Promise<ResolvedBeneficiary> {
    this.reject();
  }

  async initiateTransfer(_input: PayoutTransferInitiationInput): Promise<PayoutTransferInitiationResult> {
    this.reject();
  }

  async getTransfer(_refOrId: string): Promise<PayoutLookupResult> {
    this.reject();
  }

  async findTransferByReference(_reference: string): Promise<PayoutLookupResult> {
    this.reject();
  }
}
