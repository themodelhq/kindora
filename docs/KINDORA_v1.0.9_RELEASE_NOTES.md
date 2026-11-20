# KINDORA v1.0.9 Release Notes — Duplicate Payout Prevention & Final Authorization Lockdown

**Release:** KINDORA v1.0.9_SECURITY_COMPLETE
**Baseline:** v1.0.8_SECURITY_COMPLETE
**Classification:** STAGING READY (external provider sandbox verification blocked — no credentials)

## What changed (operator summary)

v1.0.9 closes the remaining payout-security gaps found in the v1.0.8 review. Money can now leave KINDORA through exactly one path at a time, and only when the system can prove what happened at the provider.

### 1. Provider lookups can no longer lie (P0)

Provider verification/ambiguity lookups now return an EXPLICIT outcome — `FOUND`, `NOT_FOUND`, `AMBIGUOUS`, `ERROR`. Only a documented, authoritative provider response proves non-existence:

- Paystack: HTTP 404 with the exact documented error envelope `{status:false, message:"Transfer not found"}`.
- Flutterwave: a successful reference-filtered list query that returns a well-formed EMPTY list.

HTTP 401/403 classify ERROR (requires intervention); 429/5xx/timeout/connection-reset/malformed-JSON/empty-body/missing-fields classify AMBIGUOUS. An unsuccessful lookup NEVER releases the reservation and NEVER triggers another transfer.

### 2. Manual settlement and provider submission are mutually exclusive (P0)

A durable per-withdrawal coordination guard (`PayoutSettlementGuard`, PostgreSQL — never Redis) arbitrates the two competing settlement paths:

- Provider submission claims `PROVIDER_SUBMISSION_ACTIVE` (with a lease) inside the transaction that already holds the withdrawal row lock.
- Manual settlement claims `MANUAL_SETTLEMENT_ACTIVE` inside its own transaction — after re-checking unresolved attempts, pending outbox events and active leases UNDER THE LOCK (the v1.0.8 pre-transaction check was time-of-check/time-of-use vulnerable and is gone).
- A successful settlement marks the guard `SETTLED` (terminal): no worker can submit afterwards, and a provider-settled withdrawal can never be manually settled.

### 3. Four-person separation now uses the PERSISTED executor (P1)

Submission and final reconciliation validate the approval cycle with the attempt's PERSISTED `initiatedById` (`requireExecutor: true`). A missing or colliding executor invalidates the cycle — the payout cannot be submitted, and a provider success cannot be settled.

### 4. Manual settlements REQUIRE an immutable approval snapshot (P1)

Manual settlement is now a two-step protocol:

1. **Authorize the manual payout intent** — `POST /api/v1/withdrawals/:id/execute` with an allowlisted channel (`MANUAL_BANK_TRANSFER`, `CASH`, `APPROVED_OFFLINE_CHANNEL`). This binds a canonical SHA-256 snapshot (withdrawal, requester, amount, currency, beneficiary destination binding, destination version, channel, MANUAL_SETTLEMENT designation, approval cycle, both approvers, both approval ids and timestamps) onto BOTH approval records, and registers the manual attempt. Fresh `PAYOUT_EXECUTION` MFA.
2. **Settle** — `POST /api/v1/withdrawals/:id/settle` with registered evidence. The settlement recomputes the expected snapshot from the locked rows and compares it constant-time against both stored hashes. Any drift (amount, currency, destination, version, channel, approvers, cycle) blocks the settlement.

Legacy withdrawals without a bound snapshot are NEVER grandfathered — they require the intent-authorization step (or a fresh approval cycle). A provider-bound snapshot can never satisfy the manual check.

### 5. Database-level duplicate-attempt barrier (P1)

Migration `0006_payout_dup_prevention_lockdown` adds a partial UNIQUE index: at most ONE unresolved payout attempt per withdrawal, enforced by PostgreSQL regardless of application logic. Resolved attempts are excluded, so authorized retries keep working.

### 6. Recovery reconciles before it ever resubmits (P1)

Expired-lease recovery resolves the deterministic submission reference against the provider FIRST: found ⇒ adopt the existing transfer; authoritative not-found ⇒ resubmit the SAME attempt with the SAME stable idempotency key/reference; ambiguous/error ⇒ keep the reservation, schedule a controlled lookup retry. The last lookup outcome is persisted on the attempt and outbox rows for forensics.

### 7. Observability (P1)

`GET /internal/payouts/security-metrics` (worker-token protected) exposes counters: ambiguous/error lookup outcomes, authoritative not-founds, expired-lease reclaims, lookup retries, blocked manual settlements, submissions deferred by the guard, duplicate-submission preventions. The outbox sweeper logs rolling summaries. No secrets, no identifiers, no provider payloads.

### 8. Provider routing (P1, re-audited)

Stripe/PayPal payouts remain explicit rejectors — they can never be routed through Paystack or Flutterwave. Stripe donations are unaffected. `PAYOUT_SUPPORTED_PROVIDERS` remains validated against genuinely implemented providers.

## New environment variables

None. v1.0.8's `PAYOUT_OUTBOX_LEASE_MINUTES` (default 10) and `PAYOUT_FLW_MOBILE_MONEY_ENABLED` (default false) are unchanged.

## Deployment

1. Apply migration `0006` (`prisma migrate deploy`) — additive and safe while v1.0.8 serves traffic (new table + columns + indexes; a backfill inserts one IDLE guard row per withdrawal with payout history; PAID withdrawals get SETTLED).
2. Deploy backend, workers, frontend in any order.
3. No configuration changes are required; production fails closed on missing payout configuration as before.

## Operational behavior changes

- Manual settlement is TWO API calls now (execute-then-settle). Runbooks updated: `MANUAL_SETTLEMENT_PROCEDURES_V1.0.9.md`.
- An ambiguous provider response keeps the withdrawal in `REQUIRES_RECONCILIATION`/`SUBMISSION_PENDING` with the reservation intact until the outcome is authoritatively resolved — runbook: `INCIDENT_RUNBOOK_AMBIGUOUS_PAYOUT.md`.

## Verification status (summary)

- 373 unit tests, 56 integration tests on REAL PostgreSQL 17.11 + REAL Redis 7.2.5 (migrations 0001→0006 fresh + upgrade path with backfill assertions, empty schema diff) — all executed and passed in this build session.
- Provider sandbox verification: **BLOCKED** (no credentials) — the release is therefore STAGING READY, not PRODUCTION CANDIDATE. See `FINAL_ENGINEERING_REPORT_V1.0.9.md` §C/§F.
