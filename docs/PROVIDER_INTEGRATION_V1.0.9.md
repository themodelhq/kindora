# KINDORA Provider Integration — v1.0.9 (payouts)

Companion to `PAYOUT_ARCHITECTURE_V1.0.9.md`. This document covers the PAYOUT (transfer) integration per provider — donation integrations are documented separately and unchanged.

## 1. Payout provider status matrix

| Provider | Payouts | Initiation | Idempotency | Lookup outcomes | Success reconciliation | Failure reconciliation | Reversal | Sandbox verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PAYSTACK | ACTIVE | `POST /transfer` (subunit raw-token amounts) | stable `reference` (>=16 chars [a-z0-9-_]) | strict: `404 + {status:false,message:"Transfer not found"}` only | amount/currency/recipient_code verified | authoritative terminal statuses only | `reversed` terminal; no documented in-progress stages (unknown → fail closed) | **BLOCKED — no credentials** |
| FLUTTERWAVE | ACTIVE (bank) / DISABLED (mobile money by default) | `POST /v3/transfers` (major-unit exact decimal tokens, inline beneficiary) | stable `reference` (<=100 chars) | strict: successful reference-filtered query with a well-formed EMPTY list only | amount/currency/normalized bank-or-MM fingerprint verified (method-specific, never interchangeable) | `failed`/`error` authoritative | `reversed` terminal; `reverse_initiated`/`reversing` = REVERSAL_IN_PROGRESS (forward-only lifecycle) | **BLOCKED — no credentials** |
| STRIPE | DISABLED (explicit rejector) | — | — | — | — | — | — | n/a — donations unaffected |
| PAYPAL | DISABLED (explicit rejector) | — | — | — | — | — | — | n/a — donations unaffected |
| MOCK | test-only (`PROVIDER_MODE=mock`) | in-memory | stable reference | deterministic (test hooks can force AMBIGUOUS/ERROR) | explicit SUCCESSFUL evidence through reconciliation | explicit | test fixture | n/a |

A provider is NEVER "supported" merely because it appears in a TypeScript enum or config value: `PayoutProviderRegistry.IMPLEMENTED` is the authoritative list, `PAYOUT_SUPPORTED_PROVIDERS` can only narrow it, and configuration validation rejects values naming non-implemented providers.

## 2. Paystack specifics (v1.0.9 lookup semantics)

- Verify: `GET /transfer/:id_or_code` (references resolve like ids/codes).
- FOUND requires: HTTP 200 + `{status:true}` + `data` with a usable identity (`reference`/`transfer_code`/`id`) AND a `status` field. Missing fields ⇒ AMBIGUOUS.
- NOT_FOUND requires: HTTP 404 AND `{status:false, message:"Transfer not found"}` AND no `data`. Any other 404 body, or any 401/403/429/5xx/timeout/reset/malformed/empty response ⇒ AMBIGUOUS or ERROR — never "does not exist".
- Subunit amounts are read from the RAW response text as exact integers; fractional subunits refuse interpretation (settlement fails closed).

## 3. Flutterwave specifics (v1.0.9 lookup semantics)

- Verify by id: `GET /v3/transfers/:id` — no documented not-found body ⇒ even a 404 is AMBIGUOUS.
- Reference lookup: `GET /v3/transfers?reference=` — NOT_FOUND only when HTTP 200, `status:"success"`, and a well-formed list (array or `{content:[]}`) is EMPTY. An error envelope, a missing list, a list without the requested reference, or any transport failure ⇒ AMBIGUOUS/ERROR.
- Amounts are MAJOR units converted EXACTLY from the raw decimal token (BigInt arithmetic, no float at any magnitude).
- Mobile money: the verification path is implemented (network code + mobile number tuple recomputed from the TRANSFER's own fields), but the channel stays DISABLED by default (`PAYOUT_FLW_MOBILE_MONEY_ENABLED=false`) until the sandbox suite passes for that corridor.

## 4. Sandbox verification status (honest)

**BLOCKED — no credentials in the build environment.** The following §13 checklist has NOT been executed against live providers; no sandbox evidence is claimed:

1. provider authentication — NOT EXECUTED
2. transfer creation — NOT EXECUTED
3. stable idempotency (same reference twice) — NOT EXECUTED
4. provider reference persistence — N/A locally (DB-level verified)
5. lookup after successful transfer — NOT EXECUTED (documented-shape mocks only)
6. lookup after unsuccessful transfer — NOT EXECUTED
7. lookup during provider unavailability — NOT EXECUTED
8. duplicate submission prevention — verified at HTTP-boundary + DB levels; live — NOT EXECUTED
9. amount and currency verification — verified against documented shapes; live — NOT EXECUTED
10. beneficiary verification — same
11. reversal/failure reconciliation — same

Missing environment variables: `PAYSTACK_SECRET_KEY` (sandbox), `FLUTTERWAVE_SECRET_KEY` (sandbox). Until these verifications pass, the release classification is STAGING READY and the strict default-deny posture (any undocumented response = AMBIGUOUS) keeps the fail-safe direction: an unproven lookup can only DELAY a payout, never duplicate it.

## 5. Error classes surfaced to operators

| Class | Source | Operator meaning |
| --- | --- | --- |
| `PayoutTransportError` (INITIATION) | timeout/5xx/unparseable after send | transfer MAY exist → SUBMISSION_PENDING; recovery reconciles; never blind-retry |
| `PayoutProviderRejectedError` (INITIATION) | definite 4xx with parsed error, no transfer created | attempt FAILED authoritatively; authorized retry path available |
| `PayoutProviderUnsupportedError` | Stripe/PayPal payouts, disabled MM corridor | honest, actionable disable reason |
| Lookup `AMBIGUOUS` | unsuccessful lookup | existence NOT established — reservation intact, no resubmission |
| Lookup `ERROR` | 401/403/unknown | operational intervention needed (credentials/config) |
