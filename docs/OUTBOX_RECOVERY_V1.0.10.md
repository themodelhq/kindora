# KINDORA Outbox Recovery — v1.0.10

Worker recovery guide for the payout submission pipeline. Extends
`OUTBOX_RECOVERY_V1.0.9.md` with the v1.0.10 exact-reference and pagination
guarantees and the corrected concurrency proof. All recovery paths are
unit + integration-proven on REAL PostgreSQL 17 + Redis 7.2.5.

## 1. Recovery principle

A stale lease, a crashed worker, a timeout or an ambiguous provider response is
NEVER treated as evidence that a transfer did not happen. Before any resubmission
the pipeline resolves the truth from the provider with the deterministic
submission reference (`providerSubmissionReference(idempotencyKey)` — stable
across restarts and retries):

| Lookup outcome | Pipeline action |
| --- | --- |
| `FOUND` (exact requested reference — v1.0.10 identity gate) | Adopt the existing transfer (`applyAcceptance`); dispatch verification; never submit again. |
| `NOT_FOUND` (authoritative only — strict provider predicates) | Re-arm the SAME durable attempt (same idempotency key, same reference) and submit — after the in-lock state revalidation. |
| `AMBIGUOUS` | Preserve the reservation and the attempt; schedule a controlled LOOKUP retry with backoff; never submit; escalate only after the configured uncertainty window (`payouts.unknownEscalationMinutes`). |
| `ERROR` | Same as AMBIGUOUS (operational failure requires intervention; never silently converted). |

## 2. How to recover after a provider accepts a transfer but the worker crashes

1. The outbox row is `IN_FLIGHT` with an expired lease; the attempt is still
   `INITIATED` with no `providerTransferRef` — nothing was persisted.
2. The recovery sweep (or a restarted worker) atomically reclaims the expired
   outbox lease AND the coordination guard's expired submission lease.
3. The recovery gate consults the provider FIRST (`findTransferByReference`):
   - the transfer exists → adopted with the EXACT original reference
     (integration scenario D proves `initiationCount === 1`);
   - the lookup is ambiguous → `LOOKUP_BLOCKED` — the intent returns to
     `PENDING` with backoff, no resubmission (scenario E);
   - authoritative not-found → the original submission is re-armed and proceeds.
4. Manual settlement remains blocked the whole time (the attempt is unresolved).
5. Verification/reconciliation settles the withdrawal exactly once (one ledger
   posting; the guard becomes `SETTLED`).

## 3. How to investigate unresolved payouts

- `PayoutAttempt.lastLookupOutcome` / `lastLookupAt` and
  `PayoutOutbox.lastLookupOutcome` record the last provider lookup class
  (`FOUND / NOT_FOUND / AMBIGUOUS / ERROR`) — the durable observability trail of
  every recovery decision.
- `PayoutOutbox.lastError` carries the bounded reason (e.g. `recovery lookup
  AMBIGUOUS: …`, `settlement guard held by a competing settlement path`).
- `PayoutSettlementGuard` exposes `mode`, `claimedBy`, `claimedUntil`,
  `manualBlocks`, `submissionBlocks`, `expiredReclaims` — who holds the
  arbitration row and why a path was blocked.
- `PayoutVerificationEvidence` rows (immutable, hash-bound) capture every
  reconciliation input; `ManualReviewCase` rows capture escalations.
- Audit events: `PAYOUT_SUBMISSION_REARMED_AUTHORITATIVE_NOT_FOUND`,
  `PAYOUT_SUBMISSION_AMBIGUOUS`, `PAYOUT_SUBMISSION_ESCALATED`,
  `PAYOUT_TRANSFER_ACCEPTED`, `PAYOUT_SETTLED_PROVIDER_VERIFIED` (now including
  the LOCKED `executorId`), `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE`.

## 4. Duplicate workers and lease races

Only one worker can hold the authoritative submission claim for an outbox item:
the claim is an atomic conditional `UPDATE` (status + lease window), the
coordination guard is claimed in the same locked transaction, and the losing
worker defers (`LOOKUP_PENDING`). Integration scenario G proves: one provider
request, one durable reference, repeated reconciliation posts ONE ledger entry.
Because the winner of a lease race may be the 1s sweeper or an in-test/in-process
caller, every recovery assertion in the suite is made against the DURABLE
database outcome (bounded condition waits) — the financial guarantee does not
depend on which worker won.

## 5. The v1.0.10 changes at a glance

1. Adoption of a discovered transfer requires the EXACT requested reference
   (Paystack: the record's own `reference` field; Flutterwave: list match
   verified through the detailed record). Identity uncertainty is AMBIGUOUS and
   never triggers a second submission.
2. Flutterwave authoritative absence requires validated, internally consistent
   pagination metadata (the contradictory `{content:[], meta:{total:1}}` class is
   AMBIGUOUS).
3. Final reconciliation validates the LOCKED executor identity
   (`locked.initiatedById`) inside the transaction; stale or missing executors
   block settlement.
4. The concurrency suite (scenarios A–G) deterministically proves the
   manual-settlement / provider-submission mutual exclusion with the real
   coordination code on real PostgreSQL.
