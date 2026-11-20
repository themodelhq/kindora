# PAYOUT RETRY AND RECONCILIATION — v1.0.4

**Scope:** ambiguous transfer handling, idempotent payout attempts, safe retry, structured reconciliation.
**Source of truth:** `backend/src/payouts/payout.service.ts`, `backend/src/payouts/payout-state-machine.ts`, `backend/src/payments/providers/*` (`verifyTransfer`).

---

## 1. Durable attempt registry

Every payout transfer is a `PayoutAttempt` row:

- `idempotencyKey` — `payout:<withdrawalId>:<attemptNo>`, **unique** at the
  database level. Retrying an HTTP request or a worker job resolves to the
  SAME attempt; no second provider transfer can be created for one logical
  attempt.
- `providerTransferRef` — unique when present. A provider reference already
  bound to another attempt is classified `DUPLICATE_REFERENCE` and never
  applied twice.
- Attempt records persist: withdrawal, attempt number, provider, requested
  amount/currency, hashed destination (`destinationRef` = SHA-256 of the
  destination snapshot — no raw account numbers), initiation timestamp,
  provider status, classification, failure reason (authoritative only),
  verification timestamps and initiator identity.

The database transaction that inserts the attempt is the ONLY place that moves
`APPROVED → PROCESSING`; a lost race produces 409, never a double attempt.

## 2. Provider response classification

`classifyTransferStatus(provider, rawStatus)` maps raw provider statuses to the
closed set `SUCCESSFUL | FAILED | PENDING | UNKNOWN | REVERSED`.

- Paystack: `success` → SUCCESSFUL; `failed/incorrect_pin/cancelled/banned` →
  FAILED; `otp/pending/processing/queued` → PENDING; `reversed` → REVERSED.
- Flutterwave: `successful` → SUCCESSFUL; `failed/error/cancelled` → FAILED;
  `pending/queued/new/processing` → PENDING; `reversed/reverse_initiated` →
  REVERSED.
- **Anything unrecognised is `UNKNOWN` — never `FAILED`.**
- A transport error (timeout, HTTP 5xx, connection reset) is ALSO `UNKNOWN`:
  the provider may still complete the transfer.

Verification (`verifyTransfer`) is a read-only GET against the provider
(`GET /transfer/:id_or_code` for Paystack, `GET /v3/transfers/:id` for
Flutterwave) and returns provider status, provider reference, amount (minor
units), currency and destination — so amount/currency/destination equality can
be proven before ANY settlement transition.

## 3. Ambiguous transfer handling (§5.3)

When an outcome is not authoritatively known:

1. The funds reservation STAYS (REQUIRES_RECONCILIATION is a reserving status).
2. The attempt keeps its recorded reference; a new transfer is impossible.
3. The withdrawal moves to `REQUIRES_RECONCILIATION` (audit `PAYOUT_STATE_*`).
4. Reconciliation queries the provider with the ORIGINAL reference and applies
   the outcome only after authoritative verification.
5. If the provider cannot establish the outcome, the state is retained and the
   case escalates (`REQUIRES_MANUAL_INVESTIGATION`). Funds are never released
   to make the withdrawal "complete".

Manual settlement is additionally refused while ANY non-manual attempt is
unresolved (`A provider transfer attempt is unresolved — run verification …`),
so the old mark-paid-on-top-of-pending race cannot happen.

## 4. Safe retry (§5.4)

`PayoutService.retry` requires ALL of:

- withdrawal status is `FAILED` (authoritative outcome recorded),
- no attempt is `INITIATED`/`PENDING`/`UNKNOWN`,
- the previous attempt has an authoritative failure reason,
- fresh MFA (`PAYOUT_RETRY`) + requester separation at the controller/service,
- a NEW attemptNo + idempotency key is minted.

Unit tests prove retry is refused for `PENDING`, `PROCESSING`,
`REQUIRES_RECONCILIATION`, `APPROVED` and for unresolved attempts; the
integration suite covers the HTTP path.

## 5. Reconciliation result model (§11)

Every verification run writes a `PayoutReconciliation` row with one of:

| Result | Meaning | Operator action |
|---|---|---|
| `MATCHED` | Provider and internal state agree | none |
| `PROVIDER_SUCCESS_INTERNAL_PENDING` | Provider settled, ledger catching up | auto-finalized by PayoutService (PAID + exactly-once ledger) |
| `PROVIDER_FAILED_INTERNAL_PROCESSING` | Authoritative failure recorded | withdrawal → FAILED; retry may be authorized |
| `PROVIDER_PENDING` | Transfer still in flight at provider | keep reservation; re-check later |
| `PROVIDER_UNKNOWN` | Provider answer not conclusive | keep reservation; escalate |
| `AMOUNT_MISMATCH` | Provider amount ≠ requested | manual investigation, never auto-settled |
| `CURRENCY_MISMATCH` | Currency mismatch | manual investigation |
| `DESTINATION_MISMATCH` | Transfer does not belong to this payout | manual investigation |
| `DUPLICATE_REFERENCE` | Reference bound to another attempt | manual investigation |
| `REQUIRES_MANUAL_INVESTIGATION` | Unresolvable automatically | finance team review |

Reconciliation is idempotent (re-running produces additional result rows, not
duplicate ledger entries), never initiates a payout, never silently releases
funds, preserves the raw provider status as evidence (`providerEvidence` JSON),
and every correction is an audited state transition.

## 6. Exactly-once settlement

Both settlement paths (provider-verified and manual) post through
`LedgerService.postWithdrawal` inside the same transaction as the state
change. The ledger transaction reference `withdrawal:<id>` is unique — any
double-settlement race becomes `P2002 → 409 Conflict
("This withdrawal has already been settled")`. Unit + integration tests
replay stale-state settlements and assert a single ledger posting.
