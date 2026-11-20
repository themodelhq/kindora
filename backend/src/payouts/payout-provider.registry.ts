import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PayoutProviderUnsupportedError,
  type PayoutProviderAdapter,
} from './payout-provider.adapter';
import { FlutterwavePayoutAdapter } from './adapters/flutterwave-payout.adapter';
import { MockPayoutAdapter } from './adapters/mock-payout.adapter';
import { PaystackPayoutAdapter } from './adapters/paystack-payout.adapter';
import { PaypalPayoutAdapter, StripePayoutAdapter } from './adapters/stripe-payout.adapter';

/**
 * Payout provider registry (v1.0.7 §3.2/§6).
 *
 * The ACTIVE API-verified payout providers are PAYSTACK and FLUTTERWAVE.
 * STRIPE and PAYPAL are registered as explicit REJECTORS so that a payout
 * request naming them fails with a precise, honest error instead of being
 * routed through another provider's verifier (the v1.0.6 defect).
 *
 * The environment variable PAYOUT_SUPPORTED_PROVIDERS (default
 * "PAYSTACK,FLUTTERWAVE") further restricts the active set; production
 * configuration validation rejects values naming providers that are not
 * genuinely implemented.
 */
@Injectable()
export class PayoutProviderRegistry {
  private readonly adapters = new Map<string, PayoutProviderAdapter>();

  constructor(
    private readonly config: ConfigService,
    paystack: PaystackPayoutAdapter,
    flutterwave: FlutterwavePayoutAdapter,
    private readonly mock: MockPayoutAdapter,
    stripe: StripePayoutAdapter,
    paypal: PaypalPayoutAdapter,
  ) {
    for (const a of [paystack, flutterwave, mock, stripe, paypal]) this.adapters.set(a.name, a);
  }

  /** Providers that genuinely support API-verified payouts in this release. */
  static readonly IMPLEMENTED = ['PAYSTACK', 'FLUTTERWAVE'] as const;

  private configuredSupported(): string[] {
    const raw = this.config.get<string>('payouts.supportedProviders') ?? 'PAYSTACK,FLUTTERWAVE';
    return raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  /** Providers selectable by administrators right now (config-restricted). */
  activeProviders(): string[] {
    const supported = this.configuredSupported().filter((p) => PayoutProviderRegistry.IMPLEMENTED.includes(p as (typeof PayoutProviderRegistry.IMPLEMENTED)[number]));
    if (this.config.get('providerMode') === 'mock') return ['MOCK'];
    return supported;
  }

  /** Legacy v1.0.4 attempt names map to the canonical provider adapters. */
  private static alias(name: string): string {
    switch (name) {
      case 'PAYSTACK_TRANSFER':
        return 'PAYSTACK';
      case 'FLUTTERWAVE_TRANSFER':
        return 'FLUTTERWAVE';
      default:
        return name;
    }
  }

  get(provider: string): PayoutProviderAdapter | null {
    const canonical = PayoutProviderRegistry.alias(provider.toUpperCase());
    const a = this.adapters.get(canonical);
    if (!a) return null;
    if (provider.toUpperCase() === 'MOCK') return this.config.get('providerMode') === 'mock' ? a : null;
    return a;
  }

  /** Fail-closed accessor for the payout pipeline. */
  require(provider: string): PayoutProviderAdapter {
    const name = PayoutProviderRegistry.alias(provider.toUpperCase());
    const adapter = this.get(name);
    if (!adapter) {
      if (['STRIPE', 'PAYPAL'].includes(name)) {
        throw new PayoutProviderUnsupportedError(name, name === 'STRIPE' ? StripePayoutAdapter.DISABLED_REASON : PaypalPayoutAdapter.DISABLED_REASON);
      }
      throw new BadRequestException(`Unknown payout provider: ${provider}`);
    }
    if (!adapter.supportsPayouts()) {
      throw new PayoutProviderUnsupportedError(name, StripePayoutAdapter.DISABLED_REASON);
    }
    if (name !== 'MOCK') {
      const active = this.activeProviders();
      if (!active.includes(name)) {
        throw new BadRequestException(`Payout provider "${name}" is not enabled for this deployment (active: ${active.join(', ')})`);
      }
    }
    const cfg = adapter.validatePayoutConfig();
    if (!cfg.ok) throw new BadRequestException(`Payout provider "${name}" is misconfigured: ${cfg.reason}`);
    return adapter;
  }
}
