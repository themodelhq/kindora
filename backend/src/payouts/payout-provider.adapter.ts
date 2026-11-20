import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { sha256Hex } from '../common/utils/crypto.util';

/**
 * KINDORA v1.0.9 — payout provider adapter contract.
 *
 * The donation adapters (provider-adapter.interface.ts) stay untouched: donor
 * checkout is a separate concern. This contract governs PROVIDER PAYOUT
 * (transfer) execution — the money-leaving path — and is the ONLY interface
 * the initiation/verification/reconciliation pipeline talks to.
 *
 * Core rules (v1.0.7 §3, hardened by v1.0.9 §2):
 *  - Each provider implements its OWN API semantics. Verification logic is
 *    never shared across providers.
 *  - A successful HTTP response from initiation only proves the provider
 *    ACCEPTED or REGISTERED the request. It is never final settlement.
 *  - Ambiguous transport outcomes MUST be reported as PayoutTransportError so
 *    the pipeline can enter SUBMISSION_PENDING instead of blind-retrying.
 *  - Definite validation rejections (HTTP 4xx with a parsed provider error,
 *    no transfer created) are reported as PayoutProviderRejectedError.
 *  - v1.0.9 §2.1: provider LOOKUP outcomes are EXPLICIT and four-valued —
 *    FOUND | NOT_FOUND | AMBIGUOUS | ERROR. An unsuccessful lookup NEVER
 *    produces NOT_FOUND: "the provider could not answer" is never equated
 *    with "the transfer does not exist". Only a documented, authoritative
 *    provider response that explicitly means the requested reference does
 *    not exist may produce NOT_FOUND (strict per-provider predicates).
 *  - Secrets and full beneficiary PII must never be logged by adapters.
 */

export type PayoutMethod = 'BANK' | 'MOBILE_MONEY';

// ---- v1.0.9 §2.1 — explicit provider lookup outcomes -------------------------

/**
 * The four explicit lookup outcomes. An unsuccessful lookup does NOT prove
 * that a transfer does not exist; only NOT_FOUND does — and only when the
 * provider's documented not-found response shape was matched exactly.
 */
export type PayoutLookupOutcome = 'FOUND' | 'NOT_FOUND' | 'AMBIGUOUS' | 'ERROR';

/**
 * Structured provider lookup result (v1.0.9 §2). Lookup methods NEVER throw
 * and NEVER collapse a failed lookup into "not found": every outcome that is
 * not FOUND keeps the withdrawal reservation intact and forbids resubmission.
 */
export interface PayoutLookupResult {
  outcome: PayoutLookupOutcome;
  /** Present ONLY when outcome === 'FOUND'. */
  transfer?: PayoutTransferDetails;
  /** Stable machine-readable classification code for audit/metrics. */
  reason?: string;
  /** HTTP status when the failure came from an HTTP response. */
  httpStatus?: number | null;
  /** Sanitized provider evidence (no secrets, no full PII). */
  evidence?: Record<string, unknown>;
}

export interface PayoutBeneficiaryInput {
  /** Exact withdrawal destination snapshot (already validated by the DTO). */
  destination: Record<string, string>;
  currency: string;
  method: PayoutMethod;
}

export interface ResolvedBeneficiary {
  /** Provider-native recipient identifier (Paystack recipient_code, FLW echo). */
  externalRef: string;
  /**
   * Stable SHA-256 over the provider-visible identity. For Paystack this is
   * the recipient_code itself; for Flutterwave it is the normalized
   * bank:account:name triple — NEVER the local destination JSON hash.
   */
  fingerprint: string;
  /** Masked details safe for persistence/audit (no full account numbers). */
  maskedDetails: Record<string, string | null>;
  /** Raw provider-visible identity fields used for the fingerprint. */
  identity: Record<string, string | null>;
}

export interface PayoutTransferInitiationInput {
  /** Durable internal idempotency key (`payout:<withdrawalId>:<attemptNo>`). */
  idempotencyKey: string;
  /**
   * Provider submission reference — deterministic, sanitized to the provider's
   * rules. Distinct from idempotencyKey by definition and by construction.
   * STABLE ACROSS RETRIES (v1.0.9 §2.4): the same logical payout retains the
   * same provider reference on every safe retry — a new key is never minted
   * per worker execution.
   */
  providerReference: string;
  /** Approved amount in INTEGER minor units (never floating point). */
  amountMinor: bigint;
  currency: string;
  /** Beneficiary identity that was validated and approved for this payout. */
  beneficiaryExternalRef: string;
  /** Beneficiary identity fields required by providers that do not store recipients (e.g. Flutterwave). */
  beneficiaryIdentity: Record<string, string | null>;
  narration: string;
}

export interface PayoutTransferInitiationResult {
  /**
   * true = the provider ACCEPTED/REGISTERED the transfer (response semantics,
   * not settlement). false is impossible through this interface: providers
   * that definitely rejected throw PayoutProviderRejectedError; ambiguous
   * failures throw PayoutTransportError.
   */
  accepted: boolean;
  /** Provider transfer reference as returned by the provider (or as submitted when the provider echoes it). */
  providerTransferRef: string;
  /** Provider-native transfer ID when the response carries one (Paystack data.id, FLW data.id). */
  providerTransferId?: string;
  /** Raw provider status at initiation time (pending/queued/NEW/success/...). */
  providerStatus?: string;
  /** Sanitized response subset persisted as initiation evidence. */
  evidence: Record<string, unknown>;
}

export interface PayoutTransferDetails {
  /** Always true on a FOUND transfer — retained for historical row readers. */
  exists: boolean;
  providerStatus: string | null;
  providerTransferRef: string | null;
  providerTransferId?: string | null;
  /** Provider-reported amount in INTEGER minor units (undefined = not reported). */
  amountMinor?: bigint;
  /** Provider-reported currency (undefined = not reported). */
  currency?: string;
  /**
   * Provider beneficiary identity: Paystack = recipient_code from the transfer
   * object; Flutterwave = normalized bank:account fingerprint computed from
   * the transfer's beneficiary fields. Undefined = provider did not expose
   * beneficiary evidence (settlement must fail closed).
   */
  beneficiaryRef?: string;
  /**
   * v1.0.8 §6.2 — provider-derived beneficiary identity CANDIDATES by method
   * (e.g. `mobileMoney` for Flutterwave mobile-money corridors, where the
   * transfer object reports the network code + mobile number). The caller
   * selects the candidate matching the payout's method — a mobile-money
   * identifier is never treated as interchangeable with a bank identifier.
   */
  beneficiaryRefCandidates?: Record<string, string>;
  beneficiaryIdentity?: Record<string, string | null>;
  /** Authoritative terminal failure reason (classification === FAILED only). */
  failureReason?: string;
  /** Sanitized subset of the provider response (no secrets, no full PII). */
  evidence: Record<string, unknown>;
}

/**
 * AMBIGUOUS provider submission outcome. Thrown on timeout, network failure,
 * HTTP 5xx or an unparseable response AFTER the request was sent. The caller
 * must treat the transfer as possibly-created and enter SUBMISSION_PENDING.
 */
export class PayoutTransportError extends Error {
  constructor(message: string, readonly provider: string, readonly phase: 'INITIATION' | 'VERIFICATION' | 'BENEFICIARY') {
    super(`[${provider}] ${phase} transport failure: ${message}`);
    this.name = 'PayoutTransportError';
  }
}

/** DEFINITE provider rejection of the initiation request (no transfer created). */
export class PayoutProviderRejectedError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly providerErrorCode?: string,
  ) {
    super(`[${provider}] transfer rejected: ${message}`);
    this.name = 'PayoutProviderRejectedError';
  }
}

/** The provider does not support payouts (Stripe v1.0.7) — always fail closed. */
export class PayoutProviderUnsupportedError extends Error {
  constructor(readonly provider: string, reason: string) {
    super(`[${provider}] payouts are not supported: ${reason}`);
    this.name = 'PayoutProviderUnsupportedError';
  }
}

// ---- v1.0.9 §2.1/§2.2 — lookup classification helpers ------------------------

/** Build an AMBIGUOUS lookup result: the provider result cannot safely establish existence. */
export function lookupAmbiguous(reason: string, opts?: { httpStatus?: number | null; evidence?: Record<string, unknown> }): PayoutLookupResult {
  return { outcome: 'AMBIGUOUS', reason, httpStatus: opts?.httpStatus ?? null, evidence: opts?.evidence ?? {} };
}

/** Build an ERROR lookup result: operational failure requiring intervention. */
export function lookupError(reason: string, opts?: { httpStatus?: number | null; evidence?: Record<string, unknown> }): PayoutLookupResult {
  return { outcome: 'ERROR', reason, httpStatus: opts?.httpStatus ?? null, evidence: opts?.evidence ?? {} };
}

/** Wrap a FOUND transfer in the explicit result shape. */
export function lookupFound(transfer: PayoutTransferDetails): PayoutLookupResult {
  return { outcome: 'FOUND', transfer };
}

/**
 * v1.0.9 §2.2 — classify an HTTP failure of a provider LOOKUP. These statuses
 * must NEVER be interpreted as proof of non-existence:
 *   401/403          -> ERROR  (credentials/configuration: requires intervention)
 *   429              -> AMBIGUOUS (rate-limited; a later lookup may succeed)
 *   500-599          -> AMBIGUOUS (provider error; transfer state unknown)
 *   404              -> NOT_FOUND ONLY when the provider-specific strict
 *                       documented not-found predicate matched the response
 *                       body; otherwise AMBIGUOUS (a bare 404 is not proof)
 *   other 4xx        -> ERROR   (unknown provider error; never guessed)
 * Malformed/empty bodies on an ok status are AMBIGUOUS (handled by callers).
 */
export function classifyLookupHttpFailure(
  provider: string,
  status: number,
  bodyText: string,
  parsedBody: unknown,
  strictNotFound?: (parsed: unknown) => boolean,
): PayoutLookupResult {
  if (status === 401 || status === 403) {
    return lookupError(`lookup rejected with HTTP ${status} (authentication/authorization) — transfer existence NOT established`, {
      httpStatus: status,
      evidence: { provider, bodyPresent: Boolean(parsedBody) },
    });
  }
  if (status === 429) {
    return lookupAmbiguous(`lookup rate-limited (HTTP 429) — transfer existence NOT established`, { httpStatus: status, evidence: { provider } });
  }
  if (status >= 500) {
    return lookupAmbiguous(`provider error (HTTP ${status}) — transfer existence NOT established`, { httpStatus: status, evidence: { provider } });
  }
  if (status === 404) {
    if (strictNotFound && strictNotFound(parsedBody)) {
      return { outcome: 'NOT_FOUND', reason: 'LOOKUP_AUTHORITATIVE_NOT_FOUND', httpStatus: status, evidence: { provider } };
    }
    return lookupAmbiguous(`HTTP 404 without the documented authoritative not-found response shape — transfer existence NOT established`, {
      httpStatus: status,
      evidence: { provider },
    });
  }
  return lookupError(`unexpected lookup HTTP status ${status} — transfer existence NOT established`, {
    httpStatus: status,
    evidence: { provider },
  });
}

/**
 * Map a transport failure (timeout, connection reset, DNS failure) of a
 * lookup to its explicit outcome: ALWAYS AMBIGUOUS (v1.0.9 §2.2 — a lookup
 * that never received an answer cannot establish non-existence).
 */
export function classifyLookupTransportFailure(provider: string, err: unknown): PayoutLookupResult {
  const message = err instanceof Error ? err.message : String(err);
  return lookupAmbiguous(`lookup transport failure: ${message.slice(0, 200)} — transfer existence NOT established`, {
    evidence: { provider, transportError: true },
  });
}

/**
 * v1.0.9 §5.1 — constant-time comparison for security-sensitive hash
 * comparisons (approval snapshot hashes). Equal-length lowercase hex digests
 * compare in constant time; malformed inputs never match.
 */
export function safeEqualHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export interface PayoutProviderAdapter {
  readonly name: string;
  /** Payouts (transfers) are a distinct capability from donations. Stripe: false. */
  supportsPayouts(): boolean;
  /** Fail-closed configuration validation (§14). Never logs secret values. */
  validatePayoutConfig(): { ok: boolean; reason?: string };
  /** Resolve or create the provider recipient; persists the provider recipient id upstream. */
  resolveBeneficiary(input: PayoutBeneficiaryInput): Promise<ResolvedBeneficiary>;
  /** Initiate the actual transfer. See the error contract above. */
  initiateTransfer(input: PayoutTransferInitiationInput): Promise<PayoutTransferInitiationResult>;
  /**
   * v1.0.9 §2 — read-only GET against the provider's transfer API (never moves
   * money). Returns an EXPLICIT four-valued outcome; never throws for lookup
   * failures and never reports an unsuccessful lookup as NOT_FOUND.
   */
  getTransfer(refOrId: string): Promise<PayoutLookupResult>;
  /**
   * v1.0.9 §2 — post-submission ambiguity resolution: query the provider for
   * an existing transfer created by a previous (possibly lost) submission of
   * this exact reference. Returns an EXPLICIT outcome — NOT_FOUND only when
   * the provider authoritatively confirmed non-existence.
   */
  findTransferByReference(reference: string): Promise<PayoutLookupResult>;
}

/**
 * Deterministic, provider-safe submission reference derived from the internal
 * idempotency key. Distinct from the idempotency key (colon-separated) but
 * 1:1 with it, so ambiguity lookups can always reconstruct the reference.
 * STABLE across worker restarts and retries (pure function of the durable
 * idempotency key — v1.0.9 §2.4).
 * Paystack requires >=16 chars of [a-z0-9-_]; Flutterwave allows <=100 chars.
 */
export function providerSubmissionReference(idempotencyKey: string): string {
  const sanitized = idempotencyKey.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `kdo-${sanitized}`;
}

/** Canonical JSON hash helper for fingerprints (stable key ordering). */
export function canonicalHash(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const canonical = keys.map((k) => `${k}=${String(value[k] ?? '')}`).join('|');
  return sha256Hex(canonical);
}

export type PayoutAdapterDeps = { config: ConfigService };

/** Shared timeout-fetch with transport-error mapping (§12 bounded latency). */
export async function providerFetch(
  provider: string,
  phase: PayoutTransportError['phase'],
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; ok: boolean; body: unknown; bodyText: string }> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null; // Malformed body is surfaced by callers as ambiguous.
    }
    return { status: res.status, ok: res.ok, body, bodyText };
  } catch (err) {
    throw new PayoutTransportError((err as Error).message, provider, phase);
  } finally {
    clearTimeout(timer);
  }
}
