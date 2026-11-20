# KINDORA Payout Architecture — v1.0.9

This document describes the payout (money-leaving) architecture as of v1.0.9 and the exact points where duplicate payouts are structurally prevented. Donations (money entering) are a separate concern and unchanged.

## 1. Components

```
Admin API ─► PayoutService (canonical state machine owner)
              ├─ PayoutInitiationService   intent (attempt+outbox) + submission pipeline + settlement guard
              ├─ PayoutProviderRegistry    PAYSTACK / FLUTTERWAVE active; STRIPE/PAYPAL explicit rejectors; MOCK test-only
              ├─ provider adapters         PaystackPayoutAdapter / FlutterwavePayoutAdapter / MockPayoutAdapter
              ├─ PayoutVerificationService fail-closed authoritative verification (explicit lookup outcomes)
              ├─ PayoutReconciliationService ONE atomic transaction per outcome, mandatory approval-cycle gate
              ├─ PayoutApprovalCycleService four-person separation + snapshot hashes (provider + manual)
              ├─ PayoutEvidenceService     manual evidence validation (StoredFile registry)
              └─ PayoutSecurityMetricsService duplicate-prevention counters (§7)
PayoutOutboxSweeper          in-process crash-recovery floor (30s default)
kindora-worker               BullMQ consumer → internal ingest endpoints (worker-token protected)
PostgreSQL                   durable state + THE coordination guard + partial UNIQUE barrier
```

## 2. State machines

Withdrawal graph and attempt graph are unchanged in shape from v1.0.8 (see `payout-state-machine.ts`), with ONE new attempt edge:

- `SUBMISSION_PENDING → INITIATED` — the **authoritative-not-found re-arm**. Reachable ONLY through the recovery gate after the provider authoritatively confirmed the submission reference does not exist. A lease expiry or an AMBIGUOUS/ERROR lookup can NEVER take this edge.

## 3. The four-valued lookup outcome (v1.0.9 §2)

Every provider lookup (`getTransfer`, `findTransferByReference`) returns an explicit `PayoutLookupResult` and NEVER throws:

| Outcome | Meaning | Pipeline effect |
| --- | --- | --- |
| `FOUND` | Authoritative matching transfer | Reconcile / adopt the existing provider identity |
| `NOT_FOUND` | Provider authoritatively confirmed non-existence (strict documented shape only) | Resubmission permitted after all other safety conditions revalidate |
| `AMBIGUOUS` | Existence not established (429, 5xx, timeout, reset, malformed, empty, missing fields, undecidable 404) | Reservation preserved; NO resubmission; controlled lookup retry; escalate after the uncertainty window |
| `ERROR` | Operational failure requiring intervention (401/403, unknown errors) | Same as AMBIGUOUS plus operator attention |

Strict not-found predicates (default-deny — any deviation from the documented shape classifies AMBIGUOUS):

- **Paystack** `GET /transfer/:ref` — NOT_FOUND only when HTTP 404 AND body is exactly the documented error envelope `{status: false, message: "Transfer not found"}` with no `data`.
- **Flutterwave** reference lookup `GET /v3/transfers?reference=` — NOT_FOUND only when HTTP 200, `status: "success"`, and a well-formed list (array or `{content:[]}`) is EMPTY. The id-based `GET /v3/transfers/:id` has NO documented not-found body, so even a 404 there is AMBIGUOUS.

## 4. The settlement guard (v1.0.9 §3.2)

`PayoutSettlementGuard` — one row per withdrawal (`withdrawalId` UNIQUE), modes:

- `IDLE` — no settlement path active.
- `PROVIDER_SUBMISSION_ACTIVE` — a submission is authorized/in flight; carries `claimedBy` + `claimedUntil` (lease = `PAYOUT_OUTBOX_LEASE_MINUTES`).
- `MANUAL_SETTLEMENT_ACTIVE` — exists ONLY inside the settlement transaction (commit → `SETTLED`, rollback → previous state).
- `SETTLED` — terminal. No future claim of any kind can succeed.

Claims are atomic conditional upserts executed INSIDE the transaction that already holds the withdrawal row lock:

- Submission claim succeeds on `IDLE` or an EXPIRED `PROVIDER_SUBMISSION_ACTIVE` lease (reclaim — only ever reached through the lookup-first recovery gate).
- Manual claim succeeds on `IDLE` or an EXPIRED provider lease (after the in-lock unresolved-attempt recheck already passed).
- Everything else fails closed with zero rows updated.

The external provider request happens OUTSIDE any transaction (§3.3): claim → commit → HTTP call → persist the response in a new transaction → release/transition the lease only after a safe outcome is recorded. A crash after the provider accepted the transfer leaves the guard claimed until lease expiry; recovery then reconciles before resubmitting.

## 5. In-lock recheck (v1.0.9 §3.1)

`settleManual` performs ALL of these INSIDE the transaction, after `SELECT ... FOR UPDATE` on the withdrawal:

1. withdrawal status is payable (`APPROVED | PROCESSING | REQUIRES_RECONCILIATION`);
2. no unresolved PROVIDER attempt exists (manual-channel intents exempt — they are what settlement completes);
3. no `PENDING | IN_FLIGHT` outbox event exists for the withdrawal;
4. the guard claim succeeds;
5. the approval cycle is valid WITH the required immutable manual snapshot;
6. the authorized manual intent attempt exists and its persisted executor does not collide with requester/approvers;
7. evidence re-validated; approved amount/currency asserted;
8. conditional `PAID` transition (zero rows ⇒ abort);
9. attempt → SUCCESSFUL; reconciliation row `MANUAL_EVIDENCE_RECORDED`; guard → `SETTLED`; exactly-once ledger posting; immutable audit event.

## 6. Manual approval snapshots (v1.0.9 §5)

The manual snapshot is a canonical, order-fixed SHA-256 over sixteen binding fields: withdrawalId, requesterId, amountMinor (integer string), currency, destinationRef (beneficiary identity binding), destinationVersion, settlementChannel, `MANUAL_SETTLEMENT` designation, approvalCycleId, approvalCycle, firstApproverId, secondApproverId, firstApprovalId, secondApprovalId, firstApprovedAt, secondApprovedAt. It is bound onto BOTH approval rows by `authorizeManualIntent` and recomputed+compared (constant-time `safeEqualHex`) by `settleManual`. The provider-path snapshot (bound at initiation, provider+beneficiary keyed) can never satisfy the manual check — and vice versa.

## 7. Duplicate-prevention layers (defense in depth)

1. Application: cycle validation + unresolved checks + guard claims (all in-lock).
2. Database: partial UNIQUE index — one UNRESOLVED attempt per withdrawal (`0006`).
3. Database: UNIQUE `idempotencyKey` (`payout:<wd>:<attemptNo>`) — stable across retries.
4. Database: UNIQUE `providerTransferRef` and `requestFingerprint` on attempts.
5. Ledger: UNIQUE reference `withdrawal:<id>` (+ `withdrawal-reversal:<id>`).
6. State machine: forward-only transitions, zero-row conditional updates abort.

## 8. Provider routing (v1.0.9 §8, re-audited)

- `PayoutProviderRegistry.IMPLEMENTED = [PAYSTACK, FLUTTERWAVE]`; `PAYOUT_SUPPORTED_PROVIDERS` further restricts the active set and is validated against genuinely implemented providers.
- STRIPE / PAYPAL are registered explicit rejectors — a payout naming them fails with an honest error and can never be routed through another provider. Stripe DONATIONS (checkout, verification, refunds) are untouched.
- MOCK is only available when `PROVIDER_MODE=mock` and is double-forbidden in production.

## 9. Verification fail-closed rules (v1.0.9 §9, preserved + hardened)

Before a provider payout can settle, reconciliation requires: exact integer amount, exact currency, provider-specific beneficiary identity (Paystack recipient_code; Flutterwave normalized bank or mobile-money fingerprint — never interchangeable, selected by payout method), reference belonging, no duplicate reference, and the approval-cycle gate with the persisted executor. Any missing/inconsistent field fails closed (`PROVIDER_DATA_INCOMPLETE`, mismatches, `DUPLICATE_REFERENCE`, `REFERENCE_MISMATCH`) → MANUAL_REVIEW, never settlement, never reservation release.

## 10. Ledger exactly-once (v1.0.9 §10, preserved)

Settlement posts through `LedgerService.postWithdrawal` whose `withdrawal:<id>` reference is UNIQUE — any double-posting race is a P2002 → 409. Reversals post `withdrawal-reversal:<id>` separately and idempotently. Manual and provider settlements cannot both post: the guard + status transitions make the second attempt impossible before the ledger is reached.
