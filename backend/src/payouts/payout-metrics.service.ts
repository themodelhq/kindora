import { Injectable, Logger } from '@nestjs/common';

/**
 * KINDORA v1.0.9 §7 — payout security observability.
 *
 * Process-local counters for the duplicate-payout prevention controls. The
 * counters are incremented at the exact control points and surfaced through
 * the internal worker ingest endpoint (GET /internal/payouts/security-metrics)
 * plus a rolling log summary — enough for alerting and incident forensics
 * without exposing ANY secret, key, token, account number or provider
 * payload. Audit events (AuditLog) remain the durable per-event record.
 */
@Injectable()
export class PayoutSecurityMetricsService {
  private readonly logger = new Logger(PayoutSecurityMetricsService.name);
  private readonly counters: Record<string, number> = {
    ambiguousLookupOutcomes: 0,
    errorLookupOutcomes: 0,
    authoritativeNotFoundLookups: 0,
    foundLookupsAdopted: 0,
    expiredLeaseReclaims: 0,
    lookupRetriesScheduled: 0,
    blockedManualSettlements: 0,
    blockedSubmissionsByGuard: 0,
    duplicateSubmissionPreventions: 0,
    submissionAmbiguities: 0,
    unresolvedProviderReferences: 0,
  };

  inc(counter: keyof typeof this.counters | string, by = 1): void {
    this.counters[counter] = (this.counters[counter] ?? 0) + by;
  }

  snapshot(): Record<string, number> {
    return { ...this.counters };
  }

  /** Rolling log summary — no secrets, no identifiers, counts only. */
  logSummary(context: string): void {
    this.logger.log(`payout-security metrics [${context}]: ${JSON.stringify(this.snapshot())}`);
  }
}
