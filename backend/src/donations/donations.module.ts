import { Module } from '@nestjs/common';
import { DonationsService } from './donations.service';
import { DonationsController } from './donations.controller';
import { PaymentsService } from '../payments/payments.service';
import { DonationPaymentService } from '../payments/donation-payment.service';
import { WebhooksController } from '../payments/webhooks.controller';
import { PaystackService } from '../payments/providers/paystack.service';
import { FlutterwaveService } from '../payments/providers/flutterwave.service';
import { StripeService } from '../payments/providers/stripe.service';
import { PaypalService } from '../payments/providers/paypal.service';
import { MockProviderService } from '../payments/providers/mock.service';
import { RefundProcessorService } from '../payments/refund-processor.service';
import { ImpactLedgerModule } from '../ledger/impact-ledger.module';
import { PayoutsModule } from '../payouts/payouts.module';

@Module({
  // PayoutsModule exports PayoutVerificationService — transfer.* webhooks only TRIGGER
  // verification (v1.0.7 §13); no settlement logic lives in the webhook controller.
  imports: [ImpactLedgerModule, PayoutsModule],
  controllers: [DonationsController, WebhooksController],
  providers: [
    DonationsService,
    PaymentsService,
    DonationPaymentService,
    RefundProcessorService,
    PaystackService,
    FlutterwaveService,
    StripeService,
    PaypalService,
    MockProviderService,
  ],
  exports: [DonationsService, DonationPaymentService, PaymentsService, RefundProcessorService],
})
export class DonationsModule {}
