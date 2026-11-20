# KINDORA v1.0.8 — Test Report

**Release:** KINDORA v1.0.8_SECURITY_COMPLETE
**Baseline:** KINDORA v1.0.7_SECURITY_COMPLETE
**Verification date:** 2026-11-14
**Honesty rule honored:** every number below reflects a test that was actually executed in this build; nothing was inflated, and everything not run is explicitly marked BLOCKED.

---

## 1. Environments actually used

| Component | Version | Notes |
| --- | --- | --- |
| PostgreSQL | 17.11 (real server, socket + TCP) | fresh DB per suite run; migrations 0001→0005 deployed via `prisma migrate deploy` |
| Redis | 7.2.5 (built from source) | real queue + MFA replay-lock + challenge storage |
| Node | v24.22.2, Prisma 6.19.3, NestJS 11 | `PROVIDER_MODE=mock` for all integration runs |

## 2. Unit tests (jest, isolated service level) — 315/315 PASSED

19 suites, 315 tests, 0 failed, 0 skipped. Includes the new v1.0.8 suites:

- **manual-settlement-channels.spec.ts (11 tests)** — the §12.1 allowlist matrix: every allowlisted channel accepted (incl. case/whitespace variants); `PAYSTACK`, `PAYSTACK_TRANSFER`, `FLUTTERWAVE`, `FLUTTERWAVE_TRANSFER`, `STRIPE`, `PAYPAL` rejected with explicit API-provider errors; legacy `MANUAL_BANK`, aliases (`PAYSTACK-TRANSFER`, `PS_TRANSFER`, `FLW`, ...), arbitrary strings, missing and malformed values rejected; no regex-recognition (`CASHIER`, `BANKER`, `CASH_TRANSFERS` rejected).
- **exact-money.spec.ts (14 tests)** — §12.5 precision: `100 → "1.00"`, `105 → "1.05"`, zero-decimal XOF, values beyond 2^53 exact, over-precision rejected (fail closed), raw JSON token extraction, exact decimal equality, Number-round-trip rejection, raw-token JSON serialization (no float corruption).
- **payout-approval-cycle.service.spec.ts (22 tests)** — §12.2: the full §4.3 matrix — missing first/second approval, stale cycle, invalidated approval, approver collisions, requester/executor separation (all three executor combinations), changed amount/currency/destination version, unbound destination version, snapshot-hash mismatch/differ/required-but-absent, beneficiary identity mismatch + invalidated beneficiary, invalid status, withdrawal-not-found — every invalid combination returns a structured INVALID result with the exact reason, and the valid four-person cycle passes (including snapshot-hash recomputation).

Existing suites (state machine, reconciliation-atomic, initiation, adapters, ledger, auth, MFA, donations, webhooks) all pass with the v1.0.8 behavior — updated where the release legitimately changed behavior (legacy channel name, BullMQ-safe jobIds, constructor injection); no test was weakened to pass.

## 3. Integration tests (REAL PostgreSQL 17 + REAL Redis 7.2.5) — 53/53 PASSED

6 e2e suites executed on a FRESH database (migrations 0001→0005, seeded), single process, `PROVIDER_MODE=mock`:

| Suite | Tests | Focus |
| --- | --- | --- |
| auth.e2e-spec.ts | pass | JWT + refresh rotation, MFA enrollment (unchanged) |
| webhooks.e2e-spec.ts | pass | payment webhook signatures + idempotency (unchanged) |
| storage.e2e-spec.ts | pass | file registry authorization (unchanged) |
| money-path.e2e-spec.ts | pass | donation → ledger → withdrawal → settle → balance arithmetic |
| withdrawals.e2e-spec.ts | 12 | separation of duties, MFA fail-closed step-up, evidence + fourth-executor enforcement, exactly-once settlement, concurrent overdraw |
| payout-lockdown.e2e-spec.ts (NEW, 6) | 6 | v1.0.8 §12.1/§12.3/§8.2 — see §4 |

**v1.0.8 payout-lockdown suite (all 6 pass on real PG+Redis):**

1. **§12.1 DTO allowlist end-to-end** — 10 bypass attempts (`PAYSTACK`, `PAYSTACK_TRANSFER`, `FLUTTERWAVE`, `FLUTTERWAVE_TRANSFER`, `STRIPE`, `PAYPAL`, `MOCK`, legacy `MANUAL_BANK`, `SOMETHING_ELSE`, lowercase alias) through the REAL HTTP API with fresh MFA: every attempt 400 with the allowlist message; withdrawal NOT settled.
2. **§4.5 invalidated cycle** — destination change invalidates approvals → settlement with an allowlisted channel refused (fail closed), withdrawal NOT settled.
3. **§3.4 distinct classification** — legitimate settlement records `MANUAL_EVIDENCE_RECORDED` (never MATCHED), `manualChannel = MANUAL_BANK_TRANSFER`, audit event `WITHDRAWAL_PAID_MANUAL_SETTLEMENT` with cycle id + executor identity.
4. **§12.3 stale lease, provider already accepted** — outbox IN_FLIGHT with expired lease + attempt rewound to INITIATED: recovery consults the provider by reference, adopts the EXISTING transfer (`ALREADY_SUBMITTED`), same provider reference, `recoveryAttempts = 1`, no duplicate transfer.
5. **§12.3 stale lease, provider never received** — recovery reclaims, provider lookup returns not-found, intent submitted exactly once (1 attempt row, 1 provider identity).
6. **§8.2 in-progress reversal** — `REVERSAL_IN_PROGRESS` / `reverse_initiated` through the real reconciliation service: `reversalState = INITIATED`, attempt NOT terminal, withdrawal untouched, `PROVIDER_REVERSAL` manual-review case opened.

**Migration verification (real PostgreSQL):**

- Fresh deploy 0001→0005: applied; `prisma migrate diff` (DB vs schema) — **empty**.
- Upgrade path: 0001→0004 deployed (v1.0.7 schema), then 0005 deployed on top: applied; schema-diff — **empty**. Existing data untouched (additive columns/enums only).

## 4. Provider sandbox tests — BLOCKED

No Paystack or Flutterwave sandbox credentials were available in this build. Per the release directive, NO sandbox transfer evidence is manufactured. Marked **BLOCKED**:

- Paystack real sandbox transfer initiation + verification.
- Flutterwave real sandbox transfer initiation + verification (bank and mobile-money corridors).

Consequences honored in the implementation: the Flutterwave mobile-money payout channel remains **DISABLED by default** (`PAYOUT_FLW_MOBILE_MONEY_ENABLED=false`) until its sandbox verification suite passes. All provider-facing logic is exercised through documented response structures with the HTTP boundary mocked at the unit level and the mock provider at the integration level.

## 5. Builds

- `backend` tsc + nest build: PASS
- `frontend` tsc + vite build (PWA precache, 83 entries): PASS
- `workers` tsc build: PASS

## 6. Defects found and fixed during verification

1. BullMQ rejects custom jobIds containing `:` — v1.0.7's `verify:<id>` / `outbox:<id>` jobIds were silently dropped (verification dispatch degraded to the sweeper). Fixed (`verify-<id>`, `outbox-<id>`).
2. The e2e suite's seeded-admin MFA could not enroll on persistent databases (secret unretrievable by design) — suite now resets credentials for its accounts at setup (test infrastructure only).

## 7. Summary

| Category | Executed | Passed | Failed | Blocked |
| --- | --- | --- | --- | --- |
| Unit | 315 | 315 | 0 | 0 |
| Integration (real PG + Redis) | 53 | 53 | 0 | 0 |
| Migration verification (real PG) | 2 paths | 2 | 0 | 0 |
| Provider sandbox | 0 | — | — | BLOCKED |
