# KINDORA v1.0.8 — Outbox Recovery (Lease-Based)

Supplements PAYOUT_ARCHITECTURE_V1.0.7.md §4.4. The durable outbox intent model is unchanged; v1.0.8 adds explicit LEASES and a SAFE stale-recovery path.

---

## 1. Ownership and leases (v1.0.8 §5.2)

Every claimed outbox event carries:

| Column | Meaning |
| --- | --- |
| `status` | `PENDING` → `IN_FLIGHT` while claimed; `SUBMITTED` / `FAILED_PERMANENT` / `EXHAUSTED` terminal |
| `claimedBy` | worker identity (`HOSTNAME:pid`) |
| `claimedAt` | claim time |
| `leaseExpiresAt` | claim valid until this instant (`PAYOUT_OUTBOX_LEASE_MINUTES`, default 10) |
| `attempts` | total claims |
| `recoveryAttempts` / `lastRecoveryAt` | stale-lease recoveries (audit) |

The claim is an atomic conditional UPDATE:
- fresh claim: `PENDING AND due → IN_FLIGHT` (+ lease);
- stale reclaim: `IN_FLIGHT AND leaseExpiresAt <= now → re-claim` (+ recovery counter).

Exactly one worker can hold a valid lease; concurrent claim losers observe `count === 0` and do nothing.

## 2. Safe stale-lease recovery (v1.0.8 §5.3) — the rule that matters

**A stale lease is NOT proof that the provider did not execute the transfer.**

When a lease has expired, the reclaiming worker MUST establish the truth from the provider BEFORE any resubmission:

1. Reload the payout attempt.
2. If a provider transfer identity is already persisted (`providerTransferRef` / `providerTransferId`): NEVER resubmit — mark the outbox SUBMITTED and dispatch verification.
3. Otherwise resolve the deterministic submission reference (`kdo-payout-<withdrawalId>-<attemptNo>`) against the provider (`findTransferByReference`):
   - **found** → adopt the existing transfer (`LOOKUP_FOUND`), dispatch verification;
   - **authoritative not-found** → safe to submit (the transfer does not exist);
   - **lookup transport failure** → release the claim (backoff) and retry later — never guess.

Because the submission reference is deterministic per logical attempt, providers deduplicate it — a resubmission after an ambiguous outcome can never create a second transfer.

## 3. Recovery scenarios (all covered by tests)

| Scenario | Outcome |
| --- | --- |
| Crash before submission | Stale lease reclaimed; provider lookup returns not-found; intent submitted exactly once |
| Crash during provider request | `PayoutTransportError` had already moved the attempt to SUBMISSION_PENDING; recovery looks up instead of resubmitting |
| Provider accepted, response lost / DB update failed | The deterministic reference finds the existing transfer; adopted, verified — no duplicate |
| Crash after saving the provider reference | The attempt's persisted identity blocks resubmission outright |
| Duplicate queue message / two recovery workers | The atomic claim serializes them; the loser is a no-op |
| Expired lease | Reclaimed through the SAFE path above |

No scenario produces an uncontrolled duplicate transfer; the DB-level guards (`PayoutOutbox_attemptId_key`, unique `idempotencyKey`, unique `requestFingerprint`, unique provider reference) remain the final backstops.

## 4. Monitoring (v1.0.8 §14)

Actionable signals to alert on (all redacted — no secrets, no full account numbers):

- outbox rows `IN_FLIGHT` with `leaseExpiresAt < now()` (stuck owner);
- `recoveryAttempts` >= 3 on one intent (repeated crashes or lookup failures);
- attempts in `SUBMISSION_PENDING` beyond `PAYOUT_UNKNOWN_ESCALATION_MINUTES` (auto-escalated to manual review);
- audit actions `PAYOUT_SUBMISSION_AMBIGUOUS` / `PAYOUT_SUBMISSION_ESCALATED`.

Operational rule: NEVER manually reset an `IN_FLIGHT` outbox row to `PENDING`. Recovery belongs to the pipeline, which always consults the provider first.
