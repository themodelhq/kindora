import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { VerificationSource } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { PayoutProviderRegistry } from './payout-provider.registry';
import { PayoutProviderUnsupportedError, type PayoutProviderAdapter } from './payout-provider.adapter';
import { PayoutReconciliationService } from './payout-reconciliation.service';
import { PayoutSecurityMetricsService } from './payout-metrics.service';
import { classifyTransferStatus, UNRESOLVED_ATTEMPT_STATUSES, type TransferVerification } from './payout-state-machine';

export interface VerifyOptions {
  source?: VerificationSource;
  correlationId?: string;
  actorId?: string | null;
}

export interface VerifyAttemptResult {
  attemptId: string;
  verification: TransferVerification | null;
  outcome?: string;
  applied?: boolean;
  note?: string;
}

/**
 * KINDORA v1.0.7 §5.3, lookup hardened by v1.0.9 §2/§9 — fail-closed
 * authoritative verification.
 *
 * Verification ALWAYS talks to the provider's own transfer API (a webhook is
 * only ever a trigger, §13). Before a withdrawal can be marked PAID, this
 * service independently establishes:
 *   1. the provider transfer exists;
 *   2. the provider reference belongs to the expected attempt;
 *   3. an authoritative successful terminal state;
 *   4. the exact approved amount   (integer minor units);
 *   5. the exact approved currency (normalized, no silent conversion);
 *   6. the approved beneficiary identity (provider beneficiary evidence vs
 *      the validated PayoutBeneficiary externalRef);
 *   7. association with the correct KINDORA transaction;
 *   8. not already settled internally;
 *   9. attempt belongs to the withdrawal;
 *  10. the approval cycle remains valid (with the PERSISTED executor);
 *  11. executor/approver separation held at initiation (snapshot hash).
 *
 * v1.0.9 §2 — the provider lookup returns an EXPLICIT four-valued outcome.
 * FOUND builds the verification from the transfer evidence. NOT_FOUND on a
 * reference that was previously ACCEPTED is treated as UNKNOWN (providers may
 * be eventually consistent; resubmission decisions belong exclusively to the
 * outbox recovery path with its full revalidation). AMBIGUOUS and ERROR are
 * UNKNOWN with a precise providerStatus — the reservation stays intact, the
 * attempt is never marked FAILED on a lookup failure, and reconciliation
 * escalates. Any missing/invalid evidence FAILS CLOSED — no settlement, no
 * reservation release, no automatic retransfer; a manual review case is
 * opened instead.
 */
@Injectable()
export class PayoutVerificationService {
  private readonly logger = new Logger(PayoutVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PayoutProviderRegistry,
    private readonly reconciliation: PayoutReconciliationService,
    private readonly metrics: PayoutSecurityMetricsService,
  ) {}

  /** True when the attempt can still be transitioned by verification. */
  private isVerifiable(status: string): boolean {
    return UNRESOLVED_ATTEMPT_STATUSES.includes(status as never);
  }

  async verifyAttempt(attemptId: string, options: VerifyOptions = {}): Promise<VerifyAttemptResult> {
    const attempt = await this.prisma.payoutAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Payout attempt not found');

    if (attempt.status === 'SUCCESSFUL' || attempt.status === 'REVERSED' || attempt.status === 'FAILED') {
      return { attemptId, verification: null, note: `Attempt already resolved (${attempt.status})` };
    }
    if (!this.isVerifiable(attempt.status)) {
      return { attemptId, verification: null, note: `Attempt is ${attempt.status} — not verifiable` };
    }

    // §6: unsupported providers are rejected honestly, never routed elsewhere.
    let adapter: PayoutProviderAdapter;
    try {
      adapter = this.registry.require(attempt.provider);
    } catch (err) {
      if (err instanceof PayoutProviderUnsupportedError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // The provider identity persisted at acceptance is the ONLY lookup key:
    // reference (primary), provider transfer id (fallback).
    const lookupKey = attempt.providerTransferRef ?? attempt.providerTransferId ?? null;
    if (!lookupKey) {
      // Never verified without a provider identity — INITIATED attempts are
      // submitted first; a MANUAL_REVIEW attempt needs the manual workflow.
      if (attempt.status === 'INITIATED') {
        throw new BadRequestException('Attempt has no provider transfer identity yet — submission has not completed');
      }
      return { attemptId, verification: null, note: 'No provider transfer identity — resolve via manual review' };
    }

    // v1.0.9 §2 — EXPLICIT lookup outcome; the lookup NEVER throws and NEVER
    // collapses a failure into "not found".
    const lookup = await adapter.getTransfer(lookupKey);
    await this.prisma.payoutAttempt
      .update({ where: { id: attemptId }, data: { lastLookupOutcome: lookup.outcome, lastLookupAt: new Date() } })
      .catch(() => undefined);
    if (lookup.outcome === 'AMBIGUOUS') this.metrics.inc('ambiguousLookupOutcomes');
    if (lookup.outcome === 'ERROR') this.metrics.inc('errorLookupOutcomes');

    let verification: TransferVerification;
    if (lookup.outcome === 'FOUND' && lookup.transfer) {
      const details = lookup.transfer;
      // v1.0.8 §6.2 — beneficiary identity selection: for Flutterwave
      // mobile-money payouts the provider evidence arrives as a mobile-money
      // candidate (network code + mobile number), NOT as a bank identity. The
      // candidate matching the withdrawal's payout method is used; a mobile
      // identifier is never compared against a bank identifier.
      let beneficiaryRef = details.beneficiaryRef;
      if (details.beneficiaryRefCandidates) {
        const withdrawal = await this.prisma.withdrawal.findUnique({
          where: { id: attempt.withdrawalId },
          select: { method: true },
        });
        if (withdrawal?.method === 'MOBILE_MONEY' && details.beneficiaryRefCandidates.mobileMoney) {
          beneficiaryRef = details.beneficiaryRefCandidates.mobileMoney;
        }
      }
      verification = {
        classification: classifyTransferStatus(attempt.provider, details.providerStatus),
        providerStatus: details.providerStatus ?? 'UNKNOWN',
        providerReference: details.providerTransferRef ?? lookupKey,
        providerTransferId: details.providerTransferId ?? undefined,
        amountMinor: details.amountMinor,
        currency: details.currency,
        beneficiaryRef,
        failureReason: details.failureReason,
        evidence: details.evidence,
      };
    } else {
      // NOT_FOUND / AMBIGUOUS / ERROR — existence NOT proven. A previously
      // ACCEPTED reference reported as authoritatively missing is still
      // treated as UNKNOWN here (providers may be eventually consistent; the
      // decision to resubmit belongs ONLY to the outbox recovery path with
      // its full state/approval/lease revalidation). The reservation stays
      // intact; reconciliation escalates. NEVER FAILED on a lookup failure.
      const providerStatus =
        lookup.outcome === 'NOT_FOUND'
          ? 'LOOKUP_NOT_FOUND'
          : lookup.outcome === 'AMBIGUOUS'
            ? 'PROVIDER_UNAVAILABLE'
            : 'LOOKUP_ERROR';
      verification = {
        classification: 'UNKNOWN',
        providerStatus,
        providerReference: lookupKey,
        evidence: {
          lookupOutcome: lookup.outcome,
          lookupReason: lookup.reason ?? null,
          httpStatus: lookup.httpStatus ?? null,
        },
      };
    }

    const applied = await this.reconciliation.apply({
      attemptId,
      verification,
      source: options.source ?? 'API_VERIFY',
      correlationId: options.correlationId,
    });

    await this.prisma.payoutAttempt.update({ where: { id: attemptId }, data: { lastVerifiedAt: new Date() } }).catch(() => undefined);
    return { attemptId, verification, outcome: applied.outcome, applied: applied.applied };
  }

  /**
   * Webhook-triggered verification (§13): a signed transfer event only
   * TRIGGERS verification against the provider API. The webhook payload is
   * recorded as evidence and NEVER applied as settlement by itself.
   */
  async verifyFromWebhook(provider: string, providerRef: string, eventId: string | undefined, rawStatus: string | undefined): Promise<{ action: string; outcome?: string }> {
    const attempt = await this.prisma.payoutAttempt.findFirst({
      where: { provider: provider.toUpperCase(), OR: [{ providerTransferRef: providerRef }, { providerTransferId: providerRef }] },
    });
    if (!attempt) return { action: 'ATTEMPT_NOT_FOUND' };
    if (!this.isVerifiable(attempt.status)) return { action: 'ATTEMPT_ALREADY_RESOLVED' };
    // Out-of-order / late events: verification always re-fetches the CURRENT
    // authoritative status, so a stale event can only re-derive the same
    // state; the reconciliation service's conditional transitions prevent
    // any regression of a newer authoritative state.
    const result = await this.verifyAttempt(attempt.id, { source: 'WEBHOOK', correlationId: eventId });
    return { action: 'VERIFICATION_TRIGGERED', outcome: result.outcome };
  }
}
