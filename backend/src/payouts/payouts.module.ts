import { Module } from '@nestjs/common';
import { ImpactLedgerModule } from '../ledger/impact-ledger.module';
import { FlutterwaveService } from '../payments/providers/flutterwave.service';
import { MockProviderService } from '../payments/providers/mock.service';
import { PaystackService } from '../payments/providers/paystack.service';
import { FlutterwavePayoutAdapter } from './adapters/flutterwave-payout.adapter';
import { MockPayoutAdapter } from './adapters/mock-payout.adapter';
import { PaystackPayoutAdapter } from './adapters/paystack-payout.adapter';
import { PaypalPayoutAdapter, StripePayoutAdapter } from './adapters/stripe-payout.adapter';
import { ManualReviewService } from './manual-review.service';
import { PayoutApprovalCycleService } from './payout-approval-cycle.service';
import { PayoutBeneficiaryService } from './payout-beneficiary.service';
import { PayoutEvidenceService } from './payout-evidence.service';
import { PayoutInitiationService } from './payout-initiation.service';
import { PayoutProviderRegistry } from './payout-provider.registry';
import { PayoutReconciliationService } from './payout-reconciliation.service';
import { PayoutSecurityMetricsService } from './payout-metrics.service';
import { PayoutVerificationService } from './payout-verification.service';
import { PayoutOutboxSweeper } from './payout-outbox.sweeper';
import { PayoutService } from './payout.service';

/**
 * Canonical payout module (v1.0.4, v1.0.7 execution-integrity extension).
 * Owns the ONLY withdrawal state machine plus the payout execution pipeline:
 *
 *   initiation (durable intent + outbox) -> provider adapters (real Paystack /
 *   Flutterwave transfers; Stripe/PayPal explicit rejectors) -> fail-closed
 *   verification -> atomic reconciliation -> controlled manual review.
 */
@Module({
  imports: [ImpactLedgerModule],
  providers: [
    PayoutService,
    PayoutInitiationService,
    PayoutVerificationService,
    PayoutReconciliationService,
    PayoutBeneficiaryService,
    ManualReviewService,
    // v1.0.8 — centralized approval-cycle validator + evidence validator.
    PayoutApprovalCycleService,
    PayoutEvidenceService,
    // v1.0.9 §7 — payout security observability counters.
    PayoutSecurityMetricsService,
    PayoutProviderRegistry,
    PayoutOutboxSweeper,
    // Payout (transfer) adapters — distinct from the donation adapters.
    PaystackPayoutAdapter,
    FlutterwavePayoutAdapter,
    MockPayoutAdapter,
    StripePayoutAdapter,
    PaypalPayoutAdapter,
    // Donation adapters kept for manual/mock verifier compatibility.
    PaystackService,
    FlutterwaveService,
    MockProviderService,
  ],
  exports: [
    PayoutService,
    PayoutInitiationService,
    PayoutVerificationService,
    PayoutReconciliationService,
    PayoutBeneficiaryService,
    ManualReviewService,
    PayoutProviderRegistry,
    PayoutApprovalCycleService,
    PayoutEvidenceService,
    PayoutSecurityMetricsService,
  ],
})
export class PayoutsModule {}
