import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exactDecimalStringToMinor, extractJsonNumberToken, jsonStringifyWithRawNumber, MAX_TRANSMITTABLE_MINOR } from '../../common/utils/exact-money';
import {
  canonicalHash,
  classifyLookupHttpFailure,
  classifyLookupTransportFailure,
  lookupAmbiguous,
  lookupError,
  lookupFound,
  PayoutProviderRejectedError,
  PayoutTransportError,
  PayoutProviderUnsupportedError,
  providerFetch,
  type PayoutBeneficiaryInput,
  type PayoutLookupResult,
  type PayoutProviderAdapter,
  type PayoutTransferDetails,
  type PayoutTransferInitiationInput,
  type PayoutTransferInitiationResult,
  type ResolvedBeneficiary,
} from '../payout-provider.adapter';

/**
 * Paystack PAYOUT adapter (v1.0.7 §3.3, lookup hardened by v1.0.9 §2) —
 * official API semantics:
 *
 *  1. Recipient resolution: POST /transferrecipient
 *     {type: nuban|ghipss|mobile_money|basa, name, account_number, bank_code,
 *     currency}. Paystack returns the existing record for a duplicate account,
 *     making recipient creation idempotent per (type, account, bank).
 *     The provider recipient identifier (`recipient_code`) is persisted by the
 *     caller as the beneficiary externalRef.
 *  2. Transfer initiation: POST /transfer
 *     {source: "balance", amount (SUBUNIT — kobo for NGN, pesewas for GHS),
 *     recipient (recipient_code), reference (>=16 chars [a-z0-9-_]), reason,
 *     currency}. Response data carries {id, transfer_code, reference, status}.
 *     Status "otp" means Paystack requires OTP finalization — treated as
 *     PENDING (provider accepted the request; money not yet sent).
 *  3. Verification: GET /transfer/:id_or_code (read-only). The response's
 *     recipient object carries the recipient_code — THE beneficiary identity
 *     compared at settlement (never the local destination hash).
 *  4. Status semantics: success|pending|processing|queued|otp|failed|reversed|
 *     cancelled|banned|incorrect_pin. Anything unrecognized is UNKNOWN.
 *
 * v1.0.9 §2.2 — STRICT not-found rule. Only this documented, authoritative
 * response shape proves a transfer does not exist:
 *     HTTP 404  +  { status: false, message: "Transfer not found" }
 * Every other unsuccessful response (401, 403, 429, 5xx, malformed JSON,
 * empty body, missing fields, unknown error codes, transport failures)
 * produces AMBIGUOUS or ERROR — never NOT_FOUND, never a resubmission.
 *
 * Secrets are read from config only; error messages never include the
 * Authorization header or secret key values.
 */

const BASE = 'https://api.paystack.co';

interface PaystackEnvelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

interface PaystackRecipient {
  recipient_code?: string;
  type?: string;
  name?: string;
  details?: { account_number?: string; account_name?: string; bank_code?: string; bank_name?: string } | null;
}

interface PaystackTransfer {
  id?: number;
  transfer_code?: string;
  reference?: string;
  status?: string;
  amount?: number;
  currency?: string;
  reason?: string;
  recipient?: PaystackRecipient | number | null;
}

/**
 * v1.0.9 §2.2 — the ONLY authoritative Paystack not-found predicate.
 * The transfer endpoint answers a reference/id it does not know with the
 * documented error envelope `{ status: false, message: "Transfer not found" }`
 * and HTTP 404. A response that deviates from this shape in ANY way (different
 * status code, missing/extra fields, a different message, a non-object body)
 * is NOT accepted as proof of non-existence.
 */
function isAuthoritativePaystackNotFound(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const body = parsed as PaystackEnvelope<unknown>;
  if (body.status !== false) return false;
  if (typeof body.message !== 'string') return false;
  if (!/^transfer not found$/i.test(body.message.trim())) return false;
  if (body.data != null) return false;
  return true;
}

/** Provider-side recipient type mapping — fail closed on unsupported combos. */
function recipientTypeFor(method: string, currency: string): string {
  const cur = currency.toUpperCase();
  if (method === 'BANK') {
    if (cur === 'NGN') return 'nuban';
    if (cur === 'ZAR') return 'basa';
    if (cur === 'GHS') return 'ghipss';
    throw new PayoutProviderUnsupportedError('PAYSTACK', `bank payouts in ${cur} are not supported by this integration (supported: NGN, ZAR, GHS)`);
  }
  // Mobile money
  if (['GHS', 'KES', 'UGX', 'TZS', 'XOF', 'RWF'].includes(cur)) return 'mobile_money';
  throw new PayoutProviderUnsupportedError('PAYSTACK', `mobile money payouts in ${cur} are not supported by this integration`);
}

@Injectable()
export class PaystackPayoutAdapter implements PayoutProviderAdapter {
  readonly name = 'PAYSTACK';

  constructor(private readonly config: ConfigService) {}

  supportsPayouts(): boolean {
    return true;
  }

  validatePayoutConfig(): { ok: boolean; reason?: string } {
    const key = this.config.get<string>('payments.paystack.secretKey');
    if (!key) return { ok: false, reason: 'PAYSTACK_SECRET_KEY is not configured' };
    return { ok: true };
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.config.get<string>('payments.paystack.secretKey')}`,
      'Content-Type': 'application/json',
    };
  }

  async resolveBeneficiary(input: PayoutBeneficiaryInput): Promise<ResolvedBeneficiary> {
    const d = input.destination;
    const accountName = (d.accountName ?? d.account_name ?? '').trim();
    const bankCode = (d.bankCode ?? d.bank_code ?? '').trim();
    const accountNumber = (d.accountNumber ?? d.account_number ?? '').trim();
    const mobileNumber = (d.mobileNumber ?? d.mobile_number ?? '').trim();
    const type = recipientTypeFor(input.method, input.currency);

    if (!accountName) throw new PayoutProviderRejectedError('destination is missing the beneficiary account name', this.name, 'MISSING_NAME');
    if (type === 'mobile_money') {
      if (!mobileNumber) throw new PayoutProviderRejectedError('mobile money destination is missing mobileNumber', this.name, 'MISSING_MOBILE');
    } else if (!accountNumber || !bankCode) {
      throw new PayoutProviderRejectedError('bank destination is missing accountNumber or bankCode', this.name, 'MISSING_BANK_FIELDS');
    }

    const res = await providerFetch(this.name, 'BENEFICIARY', `${BASE}/transferrecipient`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        type,
        name: accountName,
        ...(type === 'mobile_money'
          ? { mobile_number: mobileNumber, currency: input.currency.toUpperCase() }
          : { account_number: accountNumber, bank_code: bankCode, currency: input.currency.toUpperCase() }),
      }),
    });

    if (res.status >= 500) throw new PayoutTransportError(`recipient create HTTP ${res.status}`, this.name, 'BENEFICIARY');
    const body = (res.body ?? {}) as PaystackEnvelope<PaystackRecipient>;
    if (!res.ok || !body.status || !body.data?.recipient_code) {
      // Definite 4xx rejection with a parsed error — no recipient was created.
      throw new PayoutProviderRejectedError(body.message ?? `recipient create HTTP ${res.status}`, this.name);
    }

    const details = body.data.details ?? {};
    const identity = {
      provider: this.name,
      recipientType: type,
      recipientCode: body.data.recipient_code,
      accountNumberLast4: (details.account_number ?? accountNumber ?? '').slice(-4),
      bankCode: details.bank_code ?? bankCode,
      accountName,
    };
    return {
      externalRef: body.data.recipient_code,
      fingerprint: canonicalHash(identity),
      maskedDetails: {
        type,
        accountNumberMasked: `****${(details.account_number ?? accountNumber ?? '').slice(-4)}`,
        bankCode: details.bank_code ?? bankCode,
        bankName: details.bank_name ?? null,
        accountName,
        currency: input.currency.toUpperCase(),
      },
      identity,
    };
  }

  async initiateTransfer(input: PayoutTransferInitiationInput): Promise<PayoutTransferInitiationResult> {
    // Paystack transfer amounts are in subunits (kobo/pesewas) — integer minor
    // units, never floating point. v1.0.8 §7.3 — the integer is emitted as a
    // RAW JSON numeric token (BigInt string), so the exact digits reach the
    // provider at ANY magnitude; a Number round-trip would silently corrupt
    // values above 2^53. A sanity ceiling guards against nonsense values.
    if (input.amountMinor < 0n) {
      throw new PayoutProviderRejectedError('negative payout amounts are invalid', this.name, 'NEGATIVE_AMOUNT');
    }
    if (input.amountMinor > MAX_TRANSMITTABLE_MINOR) {
      throw new PayoutProviderRejectedError('amount exceeds the maximum transmittable value', this.name, 'AMOUNT_OUT_OF_RANGE');
    }
    const res = await providerFetch(this.name, 'INITIATION', `${BASE}/transfer`, {
      method: 'POST',
      headers: this.headers(),
      body: jsonStringifyWithRawNumber(
        {
          source: 'balance',
          recipient: input.beneficiaryExternalRef,
          reference: input.providerReference,
          reason: input.narration.slice(0, 100),
          currency: input.currency.toUpperCase(),
        },
        'amount',
        input.amountMinor.toString(),
      ),
    });

    if (res.status >= 500) throw new PayoutTransportError(`transfer HTTP ${res.status}`, this.name, 'INITIATION');
    const body = (res.body ?? {}) as PaystackEnvelope<PaystackTransfer>;
    if (!res.ok || !body.status || !body.data) {
      // Definite rejection (no transfer created) — duplicate-reference errors
      // are NOT definite rejections: the transfer may already exist. The
      // caller resolves that ambiguity via findTransferByReference.
      const msg = body.message ?? `transfer HTTP ${res.status}`;
      if (/already exists|duplicate/i.test(msg)) {
        throw new PayoutTransportError(`duplicate reference: ${msg}`, this.name, 'INITIATION');
      }
      throw new PayoutProviderRejectedError(msg, this.name);
    }
    const d = body.data;
    if (!d.reference && !d.transfer_code && d.id == null) {
      // A response without ANY provider identity cannot be tied to a transfer
      // later — treated as ambiguous, escalated, never assumed failed.
      throw new PayoutTransportError('provider response missing transfer reference and id', this.name, 'INITIATION');
    }
    return {
      accepted: true,
      providerTransferRef: d.reference ?? d.transfer_code ?? `paystack-${d.id}`,
      providerTransferId: d.id != null ? String(d.id) : undefined,
      providerStatus: d.status ?? undefined,
      evidence: {
        transferCode: d.transfer_code ?? null,
        reference: d.reference ?? null,
        id: d.id != null ? String(d.id) : null,
        status: d.status ?? null,
        amount: d.amount != null ? String(d.amount) : null,
        currency: d.currency ?? null,
        message: body.message ?? null,
      },
    };
  }

  /**
   * v1.0.9 §2 — lookup with EXPLICIT four-valued outcomes. This method never
   * throws for lookup failures and never maps an unsuccessful response to
   * "exists: false". A FOUND transfer additionally requires the documented
   * envelope AND a usable transfer identity AND a status field — a success
   * envelope with missing transfer fields is AMBIGUOUS (§2.2 matrix).
   */
  async getTransfer(refOrId: string): Promise<PayoutLookupResult> {
    let res: Awaited<ReturnType<typeof providerFetch>>;
    try {
      res = await providerFetch(this.name, 'VERIFICATION', `${BASE}/transfer/${encodeURIComponent(refOrId)}`, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (err) {
      // Timeout / connection reset / DNS failure: existence NOT established.
      return classifyLookupTransportFailure(this.name, err);
    }

    if (!res.ok || res.body == null || typeof res.body !== 'object' || Array.isArray(res.body)) {
      // Malformed/empty body or non-ok status — classified by status rules.
      if (res.ok && res.body == null) {
        return lookupAmbiguous('lookup returned an unparseable or empty response body — transfer existence NOT established', {
          httpStatus: res.status,
          evidence: { provider: this.name },
        });
      }
      const parsed = res.body;
      return classifyLookupHttpFailure(this.name, res.status, res.bodyText, parsed, isAuthoritativePaystackNotFound);
    }

    const body = res.body as PaystackEnvelope<PaystackTransfer>;
    if (body.status !== true || !body.data) {
      // An ok status with a false/absent envelope is anomalous (not the
      // documented success shape and not the documented not-found shape).
      return lookupAmbiguous('lookup response is not the documented success envelope — transfer existence NOT established', {
        httpStatus: res.status,
        evidence: { provider: this.name, message: typeof body.message === 'string' ? body.message.slice(0, 120) : null },
      });
    }

    const d = body.data;
    // v1.0.9 §2.2 — missing expected transfer fields -> AMBIGUOUS.
    if (d.status == null || (d.reference == null && d.transfer_code == null && d.id == null)) {
      return lookupAmbiguous('lookup response is missing the expected transfer fields (status/identity) — transfer existence NOT established', {
        httpStatus: res.status,
        evidence: { provider: this.name },
      });
    }

    const recipient = d.recipient && typeof d.recipient === 'object' ? d.recipient : null;
    const recipientCode = recipient?.recipient_code ?? null;
    const details = recipient?.details ?? null;
    // v1.0.8 §7.3 — the provider-reported subunit amount is read from the RAW
    // response text as an exact integer. Paystack subunits are integers; a
    // fractional value would be anomalous and FAILS CLOSED (amountMinor
    // undefined -> a success settlement becomes PROVIDER_DATA_INCOMPLETE).
    let amountMinor: bigint | undefined;
    if (d.amount != null) {
      const token = extractJsonNumberToken(res.bodyText, 'amount');
      if (token && token.includes('.')) {
        amountMinor = undefined; // fractional subunits — refuse to interpret
      } else if (token) {
        try {
          amountMinor = BigInt(token);
        } catch {
          amountMinor = undefined;
        }
      }
    }
    const transfer: PayoutTransferDetails = {
      exists: true,
      providerStatus: d.status ?? null,
      providerTransferRef: d.reference ?? d.transfer_code ?? refOrId,
      providerTransferId: d.id != null ? String(d.id) : undefined,
      // Paystack amounts are already in subunits — integer minor units.
      amountMinor,
      currency: d.currency ?? undefined,
      beneficiaryRef: recipientCode ?? undefined,
      beneficiaryIdentity: recipientCode
        ? {
            recipientCode,
            accountNumberLast4: (details?.account_number ?? '').slice(-4),
            bankCode: details?.bank_code ?? null,
            accountName: details?.account_name ?? recipient?.name ?? null,
          }
        : undefined,
      failureReason: d.status === 'failed' ? (d.reason ?? 'provider reported failure') : undefined,
      evidence: {
        transferCode: d.transfer_code ?? null,
        reference: d.reference ?? null,
        id: d.id != null ? String(d.id) : null,
        status: d.status ?? null,
        amount: d.amount != null ? String(d.amount) : null,
        currency: d.currency ?? null,
        recipientCode: recipientCode,
        recipientAccountLast4: (details?.account_number ?? '').slice(-4),
        recipientBankName: details?.bank_name ?? null,
      },
    };
    return lookupFound(transfer);
  }

  /**
   * v1.0.9 §2 — ambiguity resolution by reference. HARDENED v1.0.10 §4.2:
   * exact requested-reference identity verification.
   *
   * The transfer endpoint resolves references as well as codes/ids, so a
   * single GET classifies the reference. The outcome is EXPLICIT:
   * NOT_FOUND only through the strict documented predicate; transport and
   * HTTP failures stay AMBIGUOUS/ERROR. A FOUND result is adopted ONLY when
   * the authoritative transfer record carries the EXACT requested merchant
   * reference:
   *   - a missing reference in the record is AMBIGUOUS — the transfer id or
   *     transfer_code is NEVER a substitute for the requested reference in
   *     reference-based recovery;
   *   - a DIFFERENT reference is AMBIGUOUS (identity mismatch);
   *   - the comparison is deterministic and case-sensitive (Paystack resolves
   *     merchant references verbatim; no normalization is applied — §4.3).
   * AMBIGUOUS lookups never trigger a new transfer submission: the caller
   * keeps the stable idempotency key and provider reference (§4.5).
   */
  async findTransferByReference(reference: string): Promise<PayoutLookupResult> {
    // §4.2 — the requested reference is preserved from the beginning of the
    // lookup operation and every stage retains it.
    const requestedReference = reference;
    const result = await this.getTransfer(requestedReference);
    if (result.outcome !== 'FOUND' || !result.transfer) {
      // NOT_FOUND / AMBIGUOUS / ERROR propagate unchanged.
      return result;
    }
    // The authoritative record's OWN reference field (evidence.reference is
    // the raw `data.reference` from the provider response — not the lookup
    // key, not the transfer_code, not the numeric id).
    const recordReference = result.transfer.evidence?.reference;
    if (typeof recordReference !== 'string' || recordReference.length === 0) {
      return lookupAmbiguous('provider transfer record does not carry the merchant reference — the requested reference identity cannot be proven (a transfer code or numeric id is never a substitute)', {
        httpStatus: result.httpStatus ?? null,
        evidence: {
          provider: this.name,
          recordHasTransferCode: result.transfer.evidence?.transferCode != null,
          recordHasTransferId: result.transfer.evidence?.id != null,
        },
      });
    }
    if (recordReference !== requestedReference) {
      return lookupAmbiguous('provider transfer record reference differs from the requested reference — identity mismatch', {
        httpStatus: result.httpStatus ?? null,
        evidence: { provider: this.name, recordHasTransferCode: result.transfer.evidence?.transferCode != null },
      });
    }
    return result;
  }
}
