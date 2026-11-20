import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  canonicalHash,
  lookupAmbiguous,
  lookupError,
  lookupFound,
  PayoutProviderRejectedError,
  PayoutTransportError,
  type PayoutBeneficiaryInput,
  type PayoutLookupResult,
  type PayoutProviderAdapter,
  type PayoutTransferInitiationInput,
  type PayoutTransferInitiationResult,
  type ResolvedBeneficiary,
} from '../payout-provider.adapter';

/**
 * MOCK payout adapter — ONLY for PROVIDER_MODE=mock (tests/offline demo).
 * Forbidden in production by configuration validation AND by the initiation
 * service (double-guarded). Deterministic state held in-memory: suitable for
 * integration tests, never for real funds.
 *
 * v1.0.9 §2 — lookup outcomes are EXPLICIT (FOUND | NOT_FOUND | AMBIGUOUS |
 * ERROR). Test hooks can force AMBIGUOUS/ERROR outcomes to exercise the
 * duplicate-payout prevention paths of the pipeline.
 *
 * v1.0.10 §6.2 — DETERMINISTIC concurrency control for the payout-lockdown
 * suite. The provider boundary can HOLD a transfer request in flight:
 *   - setInitiationHold() arms the hold; the NEXT initiateTransfer call
 *     registers the transfer (provider-side state, like a real provider that
 *     has received the request) and returns a DEFERRED promise — the response
 *     is never sent until releaseHeldInitiation() is called;
 *   - onInitiationHeld(cb) signals the EXACT moment the request reaches the
 *     provider boundary (a deferred-promise barrier — no arbitrary sleeps);
 *   - releaseHeldInitiation('accept' | 'reject' | 'timeout' |
 *     'connection-lost') deterministically completes the held request;
 *   - duplicate-reference submissions are REJECTED with a transport error
 *     (mirroring the real Paystack/Flutterwave duplicate-reference behaviour —
 *     a second submission with the same reference is ambiguous, never a
 *     second transfer);
 *   - initiationCount/lookupCount expose the provider request/reference
 *     counts the concurrency assertions require.
 */
@Injectable()
export class MockPayoutAdapter implements PayoutProviderAdapter {
  readonly name = 'MOCK';
  private readonly transfers = new Map<string, { status: string; amountMinor: bigint; currency: string; beneficiaryRef: string }>();
  /** Test hook: force the next lookup outcome for a reference. */
  private readonly forcedOutcomes = new Map<string, { outcome: 'AMBIGUOUS' | 'ERROR'; reason: string }>();

  // ---- v1.0.10 §6.2 — deterministic in-flight control ------------------------
  /** Provider request counters, per reference. */
  private readonly initiationCounts = new Map<string, number>();
  private readonly lookupCounts = new Map<string, number>();
  /** When armed, the next matching initiateTransfer is held at the provider boundary. */
  private holdArmed = false;
  /** Optional reference scope: only THIS logical payout request is held. */
  private holdReferenceFilter: string | null = null;
  /** Provider-side registration semantics while held: register on receipt (a real provider has already accepted the request) vs on response. */
  private registerOnReceipt = true;
  /** The single held request (deferred promise + its reference). */
  private held: {
    reference: string;
    input: PayoutTransferInitiationInput;
    resolve: (result: PayoutTransferInitiationResult) => void;
    reject: (err: Error) => void;
  } | null = null;
  /** Barrier signal: invoked the moment a request reaches the boundary. */
  private heldSignal: ((reference: string) => void) | null = null;

  constructor(private readonly config: ConfigService) {}

  supportsPayouts(): boolean {
    return true;
  }

  validatePayoutConfig(): { ok: boolean; reason?: string } {
    if (this.config.get('isProd')) return { ok: false, reason: 'MOCK payouts are forbidden in production' };
    return { ok: true };
  }

  /** Test hook: control the next verification outcome. */
  setOutcome(reference: string, status: string, amountMinor?: bigint, currency?: string, beneficiaryRef?: string): void {
    const existing = this.transfers.get(reference);
    this.transfers.set(reference, {
      status,
      amountMinor: amountMinor ?? existing?.amountMinor ?? 0n,
      currency: currency ?? existing?.currency ?? 'NGN',
      beneficiaryRef: beneficiaryRef ?? existing?.beneficiaryRef ?? '',
    });
  }

  /** Test hook: force AMBIGUOUS/ERROR lookup outcomes (provider outage simulation). */
  forceLookupOutcome(reference: string, outcome: 'AMBIGUOUS' | 'ERROR', reason: string): void {
    this.forcedOutcomes.set(reference, { outcome, reason });
  }

  clearLookupOverrides(): void {
    this.forcedOutcomes.clear();
  }

  // ---- v1.0.10 §6.2 — deterministic hold/barrier API -------------------------

  /**
   * Arm/disarm the provider-boundary hold. While armed, the next
   * initiateTransfer request whose reference matches `opts.reference` (when
   * given) is held in flight (deterministic barrier). Scoping the hold to a
   * reference keeps out-of-band submissions (e.g. the outbox sweeper
   * processing OTHER withdrawals) flowing while THIS scenario's request is
   * paused. registerOnReceipt=true (default) mirrors a real provider that has
   * already ACCEPTED and registered the transfer server-side while the
   * response is still in flight — exactly the crash/lease-expiry window the
   * recovery design must survive.
   */
  setInitiationHold(armed: boolean, opts?: { registerOnReceipt?: boolean; reference?: string }): void {
    this.holdArmed = armed;
    this.registerOnReceipt = opts?.registerOnReceipt ?? true;
    this.holdReferenceFilter = opts?.reference ?? null;
  }

  /** Register the barrier callback fired when a request reaches the boundary. */
  onInitiationHeld(cb: (reference: string) => void): void {
    this.heldSignal = cb;
  }

  /** Deterministically complete the held request (no arbitrary sleeps). */
  async releaseHeldInitiation(outcome: 'accept' | 'reject' | 'timeout' | 'connection-lost'): Promise<void> {
    const h = this.held;
    if (!h) throw new Error('releaseHeldInitiation: no transfer request is currently held at the provider boundary');
    this.held = null;
    if (outcome === 'accept') {
      h.resolve({
        accepted: true,
        providerTransferRef: h.reference,
        providerTransferId: `mock-${h.reference}`,
        providerStatus: 'pending',
        evidence: { reference: h.reference, status: 'pending' },
      });
      return;
    }
    if (outcome === 'reject') {
      h.reject(new PayoutProviderRejectedError('mock provider rejected the transfer (deterministic test outcome)', this.name));
      return;
    }
    // Ambiguous transport outcomes — the transfer MAY exist (§6.2 "simulate
    // timeout / connection loss after acceptance").
    h.reject(new PayoutTransportError(outcome === 'timeout' ? 'The operation was aborted due to timeout' : 'connection lost after the request was accepted', this.name, 'INITIATION'));
  }

  /** The reference currently held at the boundary (null when nothing held). */
  heldReference(): string | null {
    return this.held?.reference ?? null;
  }

  /** Provider request count for a reference (how many initiateTransfer calls reached the provider). */
  initiationCount(reference: string): number {
    return this.initiationCounts.get(reference) ?? 0;
  }

  /** Provider lookup count for a reference. */
  lookupCount(reference: string): number {
    return this.lookupCounts.get(reference) ?? 0;
  }

  /** Distinct references the provider has registered (transfer identity count). */
  registeredReferenceCount(): number {
    return this.transfers.size;
  }

  /** Whether the provider has a transfer registered under this exact reference. */
  hasTransfer(reference: string): boolean {
    return this.transfers.has(reference);
  }

  resetCounters(): void {
    this.initiationCounts.clear();
    this.lookupCounts.clear();
  }

  async resolveBeneficiary(input: PayoutBeneficiaryInput): Promise<ResolvedBeneficiary> {
    const accountNumber = (input.destination.accountNumber ?? '').trim();
    const accountName = (input.destination.accountName ?? '').trim();
    if (!accountNumber || !accountName) {
      throw new PayoutProviderRejectedError('mock destination requires accountNumber + accountName', this.name, 'INVALID');
    }
    const identity = { provider: this.name, accountLast4: accountNumber.slice(-4), accountName, currency: input.currency };
    return {
      externalRef: `mock-rcp:${canonicalHash(identity)}`,
      fingerprint: canonicalHash(identity),
      maskedDetails: { accountNumberMasked: `****${accountNumber.slice(-4)}`, accountName },
      identity,
    };
  }

  async initiateTransfer(input: PayoutTransferInitiationInput): Promise<PayoutTransferInitiationResult> {
    this.initiationCounts.set(input.providerReference, (this.initiationCounts.get(input.providerReference) ?? 0) + 1);
    // v1.0.10 §6.2 — duplicate-reference behaviour mirrors the REAL providers:
    // Paystack/Flutterwave reject a second transfer with the same merchant
    // reference ("Transfer with reference already exists" / duplicate) — an
    // AMBIGUOUS outcome, never a second independent transfer.
    if (this.transfers.has(input.providerReference)) {
      throw new PayoutTransportError(`duplicate reference: a transfer with reference ${input.providerReference} already exists`, this.name, 'INITIATION');
    }
    if (this.holdArmed && (this.holdReferenceFilter === null || this.holdReferenceFilter === input.providerReference)) {
      // Provider-side registration ON RECEIPT (default): the transfer exists
      // at the provider from the moment the request arrives, while the
      // response is held in flight.
      if (this.registerOnReceipt) {
        this.transfers.set(input.providerReference, {
          status: 'pending',
          amountMinor: input.amountMinor,
          currency: input.currency,
          beneficiaryRef: input.beneficiaryExternalRef,
        });
      }
      const deferred = new Promise<PayoutTransferInitiationResult>((resolve, reject) => {
        this.held = { reference: input.providerReference, input, resolve, reject };
      });
      this.heldSignal?.(input.providerReference);
      return deferred;
    }
    this.transfers.set(input.providerReference, {
      status: 'pending',
      amountMinor: input.amountMinor,
      currency: input.currency,
      beneficiaryRef: input.beneficiaryExternalRef,
    });
    return {
      accepted: true,
      providerTransferRef: input.providerReference,
      providerTransferId: `mock-${Date.now()}`,
      providerStatus: 'pending',
      evidence: { reference: input.providerReference, status: 'pending' },
    };
  }

  async getTransfer(refOrId: string): Promise<PayoutLookupResult> {
    this.lookupCounts.set(refOrId, (this.lookupCounts.get(refOrId) ?? 0) + 1);
    const forced = this.forcedOutcomes.get(refOrId);
    if (forced) {
      return forced.outcome === 'AMBIGUOUS'
        ? lookupAmbiguous(forced.reason, { evidence: { provider: this.name, forced: true } })
        : lookupError(forced.reason, { evidence: { provider: this.name, forced: true } });
    }
    const t = this.transfers.get(refOrId);
    if (!t) return { outcome: 'NOT_FOUND', reason: 'LOOKUP_AUTHORITATIVE_NOT_FOUND', evidence: { provider: this.name } };
    return lookupFound({
      exists: true,
      providerStatus: t.status,
      providerTransferRef: refOrId,
      amountMinor: t.amountMinor,
      currency: t.currency,
      beneficiaryRef: t.beneficiaryRef,
      evidence: { reference: refOrId, status: t.status },
    });
  }

  async findTransferByReference(reference: string): Promise<PayoutLookupResult> {
    return this.getTransfer(reference);
  }
}
