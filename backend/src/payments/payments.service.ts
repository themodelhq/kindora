import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider } from '@prisma/client';
import { PaystackService } from './providers/paystack.service';
import { FlutterwaveService } from './providers/flutterwave.service';
import { StripeService } from './providers/stripe.service';
import { PaypalService } from './providers/paypal.service';
import { MockProviderService } from './providers/mock.service';
import type { PaymentProviderAdapter } from './provider-adapter.interface';

/**
 * Resolves the enabled payment provider adapters.
 *
 * PROVIDER_MODE=mock swaps every adapter for the deterministic mock adapter
 * (tests / offline development ONLY). The mock adapter is hard-gated:
 *  - in live mode `adapterFor` never returns it, so donations cannot select
 *    MOCK and mock webhooks cannot be verified;
 *  - production startup rejects PROVIDER_MODE=mock outright (configuration.ts),
 *    so mock-mode "successes" can never exist in a production deployment.
 * In live mode a provider is enabled only when its secret key is present.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly config: ConfigService,
    private readonly paystack: PaystackService,
    private readonly flutterwave: FlutterwaveService,
    private readonly stripe: StripeService,
    private readonly paypal: PaypalService,
    private readonly mock: MockProviderService,
  ) {}

  private adapters(): Record<string, PaymentProviderAdapter> {
    const map: Record<string, PaymentProviderAdapter> = {
      PAYSTACK: this.paystack,
      FLUTTERWAVE: this.flutterwave,
      STRIPE: this.stripe,
      PAYPAL: this.paypal,
    };
    if (this.isMockMode()) map.MOCK = this.mock;
    return map;
  }

  isMockMode(): boolean {
    return (this.config.get<string>('providerMode') ?? 'live') === 'mock';
  }

  adapterFor(provider: PaymentProvider): PaymentProviderAdapter {
    const adapter = this.adapters()[provider];
    if (!adapter) {
      if (provider === 'MOCK' || provider === 'MANUAL') {
        throw new ForbiddenException(`${provider} payments are not available`);
      }
      throw new BadRequestException(`Unknown provider: ${provider}`);
    }
    return adapter;
  }

  availableMethods(): { provider: string; enabled: boolean }[] {
    const providers: PaymentProvider[] = ['PAYSTACK', 'FLUTTERWAVE', 'STRIPE', 'PAYPAL'];
    const map = this.adapters();
    return providers.map((p) => ({
      provider: p,
      enabled: this.isMockMode() ? true : map[p]?.isEnabled() ?? false,
    }));
  }

  requireEnabledAdapter(provider: PaymentProvider): PaymentProviderAdapter {
    const adapter = this.adapterFor(provider);
    if (!adapter.isEnabled() && !this.isMockMode()) {
      throw new ServiceUnavailableException(`${provider} is not available right now`);
    }
    return adapter;
  }
}
