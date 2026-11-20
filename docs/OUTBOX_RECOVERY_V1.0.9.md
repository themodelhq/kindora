# KINDORA Outbox Recovery — v1.0.9 (lease management, reconcile-before-resubmit)

This guide describes how the outbox pipeline recovers after worker crashes, expired leases and ambiguous provider outcomes in v1.0.9, and why recovery can never create a duplicate transfer.

## 1. Durable state

- `PayoutOutbox` — one row per logical attempt (UNIQUE per attempt): status (`PENDING | IN_FLIGHT | SUBMITTED | FAILED_PERMANENT | EXHAUSTED`), attempts counter, `claimedBy`, `claimedAt`, `leaseExpiresAt`, recovery counters, `nextRunAt`, request fingerprint, minimal payload with the STABLE provider reference, `lastLookupOutcome/At`.
- `PayoutAttempt` — the durable attempt: status, `idempotencyKey` (`payout:<wd>:<attemptNo>`, UNIQUE, stable), `providerTransferRef/Id` (persisted at acceptance, UNIQUE), `requestFingerprint`, `initiatedById` (the PERSISTED executor), `lastLookupOutcome/At`.
- `PayoutSettlementGuard` — the coordination lock (see PAYOUT_ARCHITECTURE_V1.0.9.md §4).

The idempotency key and the derived provider reference (`kdo-...`) are PURE FUNCTIONS of the attempt row — a new worker execution NEVER mints a new reference. The same logical payout keeps the same identity across every safe retry.

## 2. Claim semantics

1. Fresh claim: `PENDING` + `nextRunAt <= now` → `IN_FLIGHT` with a lease (atomic conditional update).
2. Stale reclaim: `IN_FLIGHT` + `leaseExpiresAt <= now` → re-claimed with `recoveryAttempts += 1`. **A stale lease is NOT proof that the provider did not execute the transfer** — reclaiming only reaches the submission path through the recovery gate below.

Only one worker can hold a valid lease (atomic conditional updates). Two workers processing the same event: the loser returns `LOOKUP_PENDING` without doing anything.

## 3. The recovery gate (before ANY submission when reclaimed or previously claimed)

The deterministic submission reference is resolved against the provider with an EXPLICIT outcome:

| Lookup outcome | Action |
| --- | --- |
| `FOUND` | ADOPT the existing transfer: persist the provider identity, mark outbox SUBMITTED, dispatch verification. No new transfer. |
| `NOT_FOUND` (authoritative only) | The original submission provably never landed → the SAME attempt may be submitted with the SAME reference, after the full in-lock state/approval/executor/guard revalidation. |
| `AMBIGUOUS` / `ERROR` | Claim released with backoff; outcome persisted on attempt+outbox; NO submission; a controlled LOOKUP retry is scheduled. Escalation to MANUAL_REVIEW only after `PAYOUT_UNKNOWN_ESCALATION_MINUTES` (default 120) of unresolved uncertainty. |

## 4. SUBMISSION_PENDING resolution (ambiguous submission outcome)

When a submission itself was ambiguous (timeout/5xx after send), the attempt is `SUBMISSION_PENDING` (unresolved — reservation intact, both settlement paths blocked). Its ONLY exits:

- lookup FOUND → adopt → verification;
- lookup authoritative NOT_FOUND → re-arm (`SUBMISSION_PENDING → INITIATED`, the v1.0.9 edge) → resubmit same reference;
- lookup AMBIGUOUS/ERROR → keep SUBMISSION_PENDING, backoff, retry the LOOKUP; escalate after the window.

## 5. Expired-lease crash recovery timeline (why duplicates are impossible)

```
T1 worker claims lease, guard = PROVIDER_SUBMISSION_ACTIVE  (committed)
T2 worker calls provider; provider ACCEPTS
T3 worker crashes before persisting the response
T4 lease expires; guard still PROVIDER_SUBMISSION_ACTIVE (expired)
T5 recovery worker reclaims (recoveryAttempts+1) and RESOLVES THE REFERENCE
    ├─ FOUND      → adopt T2's transfer (identity persisted) → verify
    ├─ NOT_FOUND  → T2 provably never landed → resubmit same reference
    └─ AMBIG/ERROR→ stay pending; retry lookup; reservation intact
```

Manual settlement at any point is blocked: while the attempt is unresolved (in-lock recheck) and while the guard lease is valid; after expiry the recheck still blocks until the attempt is authoritatively resolved.

## 6. Observability (v1.0.9 §7)

`GET /internal/payouts/security-metrics` (requires `x-worker-token`) returns counters:

- `ambiguousLookupOutcomes`, `errorLookupOutcomes`, `authoritativeNotFoundLookups`, `foundLookupsAdopted`
- `expiredLeaseReclaims`, `lookupRetriesScheduled`
- `blockedManualSettlements`, `blockedSubmissionsByGuard`
- `duplicateSubmissionPreventions`, `submissionAmbiguities`, `unresolvedProviderReferences`

Counters are process-local (per API/worker instance). AuditLog events (`PAYOUT_SUBMISSION_AMBIGUOUS`, `PAYOUT_SUBMISSION_REARMED_AUTHORITATIVE_NOT_FOUND`, `PAYOUT_SUBMISSION_ESCALATED`, `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE`, …) are the durable per-event record with full context (no secrets, no full PII). Metrics are never exposed without the worker token and never include provider secrets, keys, tokens or beneficiary account numbers.

## 7. Operational recovery after a worker crash — runbook

1. Do NOT restart into a "force resubmit" mode — the pipeline resolves itself.
2. Restart the worker/API. The sweeper (30s default) or BullMQ retries pick up due events.
3. Inspect unresolved work: attempts with `status IN (SUBMISSION_PENDING, UNKNOWN, MANUAL_REVIEW)` and their `lastLookupOutcome`.
4. If a withdrawal is stuck in REQUIRES_RECONCILIATION: run verification (`POST /withdrawals/attempts/:id/verify`) — the explicit outcome classification resolves it safely (FOUND → verify/settle or escalate; NOT_FOUND → recovery resubmission path; AMBIGUOUS/ERROR → keep waiting or escalate).
5. Never release the reservation or mark anything FAILED manually — an ambiguous outcome is NEVER a failure.

## 8. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAYOUT_OUTBOX_LEASE_MINUTES` | 10 | submission lease TTL (guard + outbox) |
| `PAYOUT_UNKNOWN_ESCALATION_MINUTES` | 120 | unresolved-ambiguity window before MANUAL_REVIEW |
| `PAYOUT_OUTBOX_SWEEP_SECONDS` | 30 | in-process sweeper interval (<5 disables — used in integration tests) |
| `WORKER_INGEST_TOKEN` | — | worker ingest auth; missing token = ingest endpoints return 503 (fail closed) |
