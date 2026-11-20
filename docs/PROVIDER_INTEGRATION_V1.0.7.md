# KINDORA Provider Integration (Payouts) — v1.0.7

**Release:** KINDORA v1.0.7_SECURITY_COMPLETE
**Scope:** the payout (transfer) adapters in `backend/src/payouts/adapters/` and their
provider contracts. Donation checkout adapters (`backend/src/payments/`) are unchanged.

Sandbox honesty statement: the adapter behavior described here is implemented and covered by
unit tests that mock the provider HTTP layer (`payout-adapters.spec.ts`, 16 tests). **No
Paystack or Flutterwave sandbox execution was performed** — the release sandbox has no
provider credentials, so every sandbox-bound claim below is marked NOT RUN. No transfer IDs,
references or sandbox responses are quoted anywhere in this document because none were
observed.

Related: [PAYOUT_ARCHITECTURE_V1.0.7.md](PAYOUT_ARCHITECTURE_V1.0.7.md) |
[MANUAL_REVIEW_PROCEDURES_V1.0.7.md](MANUAL_REVIEW_PROCEDURES_V1.0.7.md)

---

## 1. Adapter contract

Every payout adapter implements `PayoutProviderAdapter` (`payout-provider.adapter.ts`):

| Method | Semantics |
| --- | --- |
| `supportsPayouts()` | `false` for explicit rejectors (Stripe, PayPal). |
| `validatePayoutConfig()` | Fail-closed config check (secret key present). Never logs secret values. |
| `resolveBeneficiary(input)` | Resolve or create the provider recipient identity BEFORE any intent exists. |
| `initiateTransfer(input)` | The only money-moving call. See the error contract below. |
| `getTransfer(refOrId)` | Read-only GET; never moves money. |
| `findTransferByReference(reference)` | Ambiguity resolution: look up a possibly-lost submission. Returns null when nothing is found — never a guess. |

Typed error contract (the pipeline depends on exactly these semantics):

| Error | Meaning | Pipeline effect |
| --- | --- | --- |
| `PayoutTransportError` | AMBIGUOUS outcome after the request was sent: timeout, network failure, HTTP 5xx, unparseable body, duplicate-reference answer. | Attempt -> `SUBMISSION_PENDING`; provider lookup instead of resubmission. |
| `PayoutProviderRejectedError` | DEFINITE 4xx rejection with a parsed provider error; no transfer was created. | Attempt -> `FAILED`, withdrawal -> `FAILED`. |
| `PayoutProviderUnsupportedError` | The provider has no payout implementation (Stripe v1.0.7, PayPal). | Fail closed with the honest reason; never routed to another provider. |

Shared infrastructure: `providerFetch()` wraps `fetch` with a 15-second default timeout
(`AbortController`), parses the body best-effort (malformed bodies surface as ambiguous) and
maps transport exceptions to `PayoutTransportError` with the phase
(`INITIATION` / `VERIFICATION` / `BENEFICIARY`). Secrets and full beneficiary PII are never
logged by adapters.

The provider submission reference is derived 1:1 from the internal idempotency key by
`providerSubmissionReference()`: `payout:<withdrawalId>:<n>` becomes
`kdo-payout-<withdrawalId>-<n>` (lowercase, `[a-z0-9-_]` only — meets Paystack's >=16-char
requirement and Flutterwave's <=100-char limit).

## 2. Registry and provider gating

`payout-provider.registry.ts`:

- `PayoutProviderRegistry.IMPLEMENTED = ['PAYSTACK', 'FLUTTERWAVE']` — the only providers
  with genuine API-verified payout support in v1.0.7.
- `PAYOUT_SUPPORTED_PROVIDERS` (default `PAYSTACK,FLUTTERWAVE`) restricts the active set;
  production startup validation refuses to boot when it names unimplemented providers or
  lacks the matching secret keys (`PAYSTACK_SECRET_KEY` / `FLUTTERWAVE_SECRET_KEY`).
- Legacy name aliases: `PAYSTACK_TRANSFER -> PAYSTACK`, `FLUTTERWAVE_TRANSFER ->
  FLUTTERWAVE` (v1.0.4 attempt names resolve to the canonical adapters).
- `MOCK` is resolvable only when `PROVIDER_MODE=mock` (local dev/tests; forbidden in
  production by startup validation).
- Stripe and PayPal are registered as explicit REJECTORS: `registry.require('STRIPE'|'PAYPAL')`
  throws `PayoutProviderUnsupportedError` with the disable reason instead of silently
  routing through another provider's verifier.

## 3. Paystack payout adapter

Base URL: `https://api.paystack.co`. Auth: `Authorization: Bearer PAYSTACK_SECRET_KEY`.
Amounts: **subunits** (kobo for NGN, pesewas for GHS) — integer minor units end to end.

### 3.1 Endpoints used

| Operation | Call | Purpose |
| --- | --- | --- |
| Beneficiary resolution | `POST /transferrecipient` | Create/resolve the recipient. Paystack returns the existing record for a duplicate account, making this idempotent per (type, account, bank). The returned `recipient_code` becomes the beneficiary `externalRef`. |
| Transfer initiation | `POST /transfer` | Submit the transfer from the platform balance. |
| Verification | `GET /transfer/:id_or_code` | Read-only transfer lookup; also accepts the reference. |
| Ambiguity lookup | `GET /transfer/:reference` | Same endpoint resolves references — used by `findTransferByReference`. |

### 3.2 Exact request fields the adapter sends

`POST /transferrecipient`:

| Field | Value | Adapter source |
| --- | --- | --- |
| `type` | `nuban` (NGN bank), `basa` (ZAR bank), `ghipss` (GHS bank), `mobile_money` (GHS/KES/UGX/TZS/XOF/RWF) | `recipientTypeFor(method, currency)`; unsupported combinations throw `PayoutProviderUnsupportedError` — never silently converted |
| `name` | destination `accountName` | withdrawal destination JSON |
| `account_number` / `bank_code` / `currency` | destination fields, currency uppercased | bank destinations (omitted for mobile money) |
| `mobile_number` / `currency` | destination `mobileNumber`, currency | mobile money destinations |

`POST /transfer`:

| Field | Value |
| --- | --- |
| `source` | `balance` (always) |
| `amount` | integer minor units (`Number(amountMinor)`), never floating point |
| `recipient` | validated beneficiary `externalRef` (the `recipient_code`) |
| `reference` | `kdo-...` submission reference (>=16 chars, sanitized) |
| `reason` | narration, sliced to 100 chars |
| `currency` | approved currency, uppercased |

### 3.3 Response fields consumed

| Response field | Use |
| --- | --- |
| `data.recipient_code` | beneficiary identity (`externalRef`) at resolution; beneficiary evidence at verification |
| `data.id` | persisted as `providerTransferId` (stringified) |
| `data.transfer_code` | fallback transfer ref / evidence |
| `data.reference` | provider transfer ref (must belong to the attempt at reconciliation) |
| `data.status` | classification input |
| `data.amount`, `data.currency` | already subunits; compared exactly against the approved values |
| `data.reason` (failed status) | `failureReason` evidence |
| `message` | provider error text (rejection evidence; secrets never included) |

A response carrying NO provider identity at all (no reference, no code, no id) is treated as
ambiguous (`PayoutTransportError`) — it can never be tied to a transfer later, so it is never
assumed failed.

### 3.4 Status semantics and classification

| Classification | Paystack raw statuses (lowercased) |
| --- | --- |
| SUCCESSFUL | `success`, `successful` |
| PENDING | `pending`, `otp`, `processing`, `queued` |
| FAILED | `failed`, `incorrect_pin`, `cancelled`, `banned` |
| REVERSED | `reversed`, `reverse` |
| UNKNOWN | anything else — never mapped to FAILED |

Status `otp` at initiation means Paystack requires OTP finalization: the provider accepted
the request but money has not been sent — mapped to `PENDING`, not settlement.

### 3.5 Error mapping

| Condition | Thrown |
| --- | --- |
| HTTP 5xx on any endpoint | `PayoutTransportError` |
| Timeout / network failure | `PayoutTransportError` |
| `!ok` / `status:false` without a body message | `PayoutProviderRejectedError` (definite, no recipient/transfer created) |
| Transfer rejected with message matching `already exists` / `duplicate` | `PayoutTransportError` — the transfer may already exist; resolved via lookup, never retried |
| Verification 404 / unknown reference | `exists:false` (never a failure by itself) |

## 4. Flutterwave payout adapter

Base URL: `https://api.flutterwave.com/v3`. Auth: `Authorization: Bearer
FLUTTERWAVE_SECRET_KEY`. Amounts: **major units on the wire** — converted exactly from
approved minor units with the currency decimal count (`flwMajorToMinor` for the reverse
direction). Flutterwave takes beneficiary fields INLINE (no stored recipient record), so the
beneficiary identity is the normalized `bank:account:name` fingerprint.

### 4.1 Endpoints used

| Operation | Call | Purpose |
| --- | --- | --- |
| Beneficiary validation | `POST /v3/accounts/resolve` | Resolve the authoritative `account_name` BEFORE any transfer exists. A destination the provider cannot positively resolve is NEVER transferred to. |
| Transfer initiation | `POST /v3/transfers` | Submit the transfer with inline beneficiary fields. |
| Verification | `GET /v3/transfers/:id` | Read-only transfer lookup. |
| Ambiguity lookup | `GET /v3/transfers?reference=<ref>` | Find a transfer created by a lost submission; the adapter picks the exact reference match, then re-reads it by id. |

### 4.2 Exact request fields the adapter sends

`POST /v3/accounts/resolve`: `{ account_number, account_bank }`.

`POST /v3/transfers`:

| Field | Value |
| --- | --- |
| `amount` | MAJOR units (`Number(amountMinor) / 10^decimals`) |
| `currency` | approved currency, uppercased |
| `reference` | `kdo-...` submission reference |
| `narration` | narration, sliced to 80 chars |
| `account_bank`, `account_number`, `beneficiary_name` | normalized beneficiary identity (bank transfers); missing fields throw `PayoutProviderRejectedError` before the call |
| `mobile_number`, `beneficiary_name` | mobile money destinations (GHS/KES/UGX/TZS/XOF/RWF/ZMW set); bank fields omitted |

### 4.3 Response fields consumed

| Response field | Use |
| --- | --- |
| `data.id` | `providerTransferId` (stringified); verification lookup key |
| `data.reference` | provider transfer ref |
| `data.status` | classification input (`NEW` on acceptance) |
| `data.amount`, `data.currency` | major units; converted to minor exactly before comparison |
| `data.bank_code`, `data.account_number`, `data.beneficiary_name`, `data.bank_name` | normalized beneficiary fingerprint + masked evidence |
| `data.narration` (failed/error status) | `failureReason` evidence |
| `message` | provider error text |

### 4.4 Status semantics and classification

| Classification | Flutterwave raw statuses (lowercased) |
| --- | --- |
| SUCCESSFUL | `successful`, `success` |
| PENDING | `pending`, `queued`, `new`, `processing`, `in_progress` |
| FAILED | `failed`, `error`, `cancelled` |
| REVERSED | `reversed`, `reverse_initiated`, `reversing` |
| UNKNOWN | anything else — never mapped to FAILED |

### 4.5 Beneficiary identity (no recipient codes)

- Bank: identity = `{provider, kind:'bank', bankCode, accountNumber (whitespace-stripped),
  accountName (provider-resolved), currency}`; `externalRef` =
  `flw-bank:<sha256(identity)>`.
- Mobile money: identity = `{provider, kind:'mobile_money', mobileLast4, accountName,
  currency}`; `externalRef` = `flw-mm:<sha256(identity)>`.
- At verification the same fingerprint is recomputed from the transfer's OWN beneficiary
  fields and compared against the approved `externalRef`.

### 4.6 Error mapping

Identical contract to Paystack: 5xx/timeout/unparseable/duplicate-reference =>
`PayoutTransportError`; definite non-success (`status !== 'success'`) with a parsed message
=> `PayoutProviderRejectedError`; unresolvable destination =>
`PayoutProviderRejectedError('UNRESOLVED_DESTINATION')` — no transfer is ever created for a
destination the provider cannot resolve.

## 5. Webhook transfer events (triggers only)

| Provider | Classified `PAYOUT_TRANSFER` | Behavior |
| --- | --- | --- |
| Paystack | `transfer.success`, `transfer.failed`, `transfer.reversed` | Signature-verified; event recorded; verification triggered against `GET /transfer/:id`. Payload never settles. |
| Flutterwave | `transfer.completed`, `transfer.failed`, `transfer.reversed` | Note: `transfer.completed` also fires for failed transfers — the API re-fetch provides the authoritative status. Payload never settles. |
| Stripe / PayPal | none (empty allowlists) | Payouts disabled / not implemented — no transfer events accepted. |

## 6. Stripe payouts unavailable (explicit rejector)

**Stripe payouts are disabled in v1.0.7.** `StripePayoutAdapter.supportsPayouts()` returns
`false` and every payout request naming STRIPE fails with `PayoutProviderUnsupportedError`
carrying the disable reason. There is no routing through Paystack or Flutterwave.

What remains fully supported: **Stripe donations** (donor checkout through
`backend/src/payments/providers/stripe.service.ts`) are unchanged in v1.0.7. Only the
money-leaving path (organizer payouts) is affected.

What a genuine Stripe payout implementation would require (not present in this release; no
code path pretends otherwise):

1. A Stripe Connect account model (destination charges or separate charges and transfers) —
   KINDORA has no connected-account registry, so there is no legitimate transfer destination.
2. Recipient identity management equivalent to `PayoutBeneficiary` (connected account IDs
   validated via the Connect API), bound to `destinationVersion`.
3. Transfer creation with idempotency keys (`Stripe-Agent`/`Idempotency-Key` headers) plus a
   `findTransferByReference` equivalent (listing transfers by metadata) for ambiguity
   resolution.
4. Read-only verification through `GET /v1/transfers/:id` + balance transactions, mapped to
   the SUCCESSFUL/FAILED/PENDING/UNKNOWN/REVERSED classification sets with UNKNOWN never
   equal to FAILED.
5. Availability handling (Stripe balance availability windows) and currency/cross-border
   payout rules.
6. Webhook event handling (`transfer.paid`, `transfer.failed`, `payout.*`) as verification
   triggers only.

Until those exist, Stripe payouts fail closed and honestly. PayPal payouts are likewise not
implemented (explicit rejector; no transfer events accepted).

## 7. Mock adapter

`MockPayoutAdapter` is registered only when `PROVIDER_MODE=mock` (local development and
tests). It simulates the adapter contract (beneficiary resolution, deterministic acceptance,
read-back verification) so the whole pipeline is exercisable offline; production startup
validation forbids mock mode. It is never a production payout path.

## 8. Verification status (honest)

| Area | Status |
| --- | --- |
| Adapter contract, registry gating, error mapping, field-level request/response handling | Implemented; covered by `payout-adapters.spec.ts` (16 tests, mocked HTTP) and initiation/reconciliation suites. |
| Paystack sandbox execution (recipient creation, transfer, verification) | **NOT RUN / BLOCKED** — no `PAYSTACK_SECRET_KEY` in the sandbox. |
| Flutterwave sandbox execution (account resolve, transfer, verification, reference lookup) | **NOT RUN / BLOCKED** — no `FLUTTERWAVE_SECRET_KEY` in the sandbox. |
| Live provider behavior (rate limits, corridors, OTP flows, reversal timelines) | **NOT EVALUATED** — requires sandbox/live credentials. |
