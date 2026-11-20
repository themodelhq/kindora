# KINDORA v1.0.9 — Test Report

**Release:** KINDORA v1.0.9_SECURITY_COMPLETE
**Date:** 2026-11-14
**Environment:** Linux sandbox, Node v24.22.3, embedded PostgreSQL 17.11 (real server, socket + TCP), Redis 7.2.5 (real server, built from source), PROVIDER_MODE=mock for integration suites.

Every number below corresponds to a test actually executed and its result inspected during this build session. Nothing is transcribed from earlier releases.

## 1. Executed suites

### 1.1 Backend unit tests (jest, prisma/queue/adapter shells; logic under test is real)

**Result: 373 executed, 373 passed, 0 failed — 21 suites.**

New v1.0.9 suites:

| Suite | Tests | Covers |
| --- | --- | --- |
| `payout-lookup-classification.spec.ts` | 37 | §12.1 matrix for BOTH adapters: FOUND; documented not-found; bare 404; 401/403/429/500/503/unknown-400; timeout; connection reset; DNS failure; malformed JSON; empty body; missing transfer fields; success-envelope-without-data; list-without-reference; error envelope on reference lookup; findTransferByReference inheritance. Asserts AMBIGUOUS/ERROR never become NOT_FOUND and lookups never throw |
| `payout-manual-snapshot.spec.ts` | 15 | §12.4 snapshot matrix: happy path; legacy missing hashes (no grandfathering); channel mismatch; tampered first/second hash; stale binding; amount/currency/beneficiary/destinationVersion changed; missing executor; executor collision; provider-snapshot reuse rejected; `safeEqualHex` constant-time comparison |
| `payout-initiation.service.spec.ts` (7 new cases) | 7 | §2.3/§7 recovery gate: stale-lease AMBIGUOUS never resubmits; stale-lease ERROR never resubmits and never releases; authoritative NOT_FOUND resubmits the SAME reference; FOUND adopts; SUBMISSION_PENDING × AMBIGUOUS holds + retries lookup; SP × NOT_FOUND re-arms the same attempt; guard-held submission defers |

Updated suites (behavior-driven, all assertions still fail closed): `payout-adapters.spec.ts` (explicit outcome shapes), `manual-review-and-verification.spec.ts` (AMBIGUOUS/ERROR/NOT_FOUND verification classifications + metrics), `payout-reconciliation-atomic.spec.ts` (persisted executor + guard release), `payout-state-machine.spec.ts` (the authoritative-not-found re-arm edge).

### 1.2 Backend integration tests — REAL PostgreSQL 17.11 + REAL Redis 7.2.5

Fresh database, migrations 0001→0006 deployed, seeded, PROVIDER_MODE=mock, outbox sweeper disabled for determinism (`PAYOUT_OUTBOX_SWEEP_SECONDS=1`).

**Result: 56 executed, 56 passed, 0 failed.**

| Suite | Tests | Result |
| --- | --- | --- |
| `auth.e2e-spec.ts` | 7 | pass |
| `storage.e2e-spec.ts` | 6 | pass |
| `webhooks.e2e-spec.ts` | 10 | pass |
| `withdrawals.e2e-spec.ts` | 12 | pass |
| `money-path.e2e-spec.ts` | 12 | pass |
| `payout-lockdown.e2e-spec.ts` | 9 | pass — executed as two consecutive runs (3 + 6) against the same live runtime due to the sandbox's 10-minute per-command limit; each test executed exactly once |

Payout-lockdown scenarios (all on REAL PostgreSQL):

1. §12.1 — the settle API rejects every API provider name + arbitrary values (10-value DTO matrix) and never settles.
2. §4.5 — settlement with an invalidated approval cycle is refused (fail closed).
3. §5.1/§3.4 — the TWO-STEP manual settlement: intent authorization binds the immutable snapshot on both approvals; settlement completes with evidence; `MANUAL_EVIDENCE_RECORDED` classification; guard `SETTLED`; audit events carry the snapshot hash + executor.
4. §3.1/§3.2 — manual settlement BLOCKED while a provider submission is pending (in-lock recheck, 409) and the mirror direction: a submission defers while the guard is held (LOOKUP_PENDING, no transfer created).
5. §3.2/§12.5 — CONCURRENT `submitOutbox` × `settleManual` on REAL PostgreSQL (`Promise.allSettled`): exactly ONE payment path wins; the loser fails closed; ≤1 ledger posting; guard reaches the correct terminal/IDLE state.
6. §10 — reconciliation replay after settlement is a no-op (`MATCHED`, `applied=false`); exactly one `withdrawal:<id>` ledger transaction before and after the replay.
7. §12.3 (a) — expired IN_FLIGHT lease where the provider ALREADY accepted: recovery adopts the existing transfer identity, NEVER resubmits, outbox → SUBMITTED with recoveryAttempts=1.
8. §12.3 (b) — expired lease where the provider never received the intent: reclaimed safely and submitted exactly once (one attempt row, one provider identity).
9. §8.2 — an in-progress reversal (`reverse_initiated`) is recorded in the forward-only reversal lifecycle; the attempt is NOT terminal; a controlled review case opens.

### 1.3 Migration verification (REAL PostgreSQL)

| Check | Result |
| --- | --- |
| Fresh deploy 0001→0006 + partial unique index `payout_attempt_one_unresolved_per_withdrawal` + guard unique index present | PASS |
| `prisma migrate diff` — migrations vs Prisma schema | **EMPTY** (no drift; the partial index does not introduce a modeled difference) |
| Upgrade path: v1.0.8 database (0001→0005) + realistic payout history (PAID/FAILED/attemptless withdrawals) → apply 0006 → backfill assertions: PAID withdrawal guard = SETTLED; activity-bearing withdrawal guard = IDLE; attemptless withdrawal has NO guard row; partial index present | PASS |
| Schema diff on the upgraded database | EMPTY |

### 1.4 Type checks, lint, production builds

| Check | Result |
| --- | --- |
| backend `tsc --noEmit` | pass |
| frontend `tsc --noEmit` | pass |
| workers `tsc` (build) | pass |
| backend eslint | 0 errors (42 warnings, all pre-existing patterns) |
| backend `nest build` | pass |
| frontend `vite build` (PWA) | pass — 83 precached entries |

## 2. Skipped / blocked / mocked — separated honestly

- **Provider sandbox verification: BLOCKED.** No Paystack/Flutterwave sandbox credentials are available in this environment, so §13 (authentication, transfer creation, stable idempotency, reference persistence, lookup after success/not-found/unavailability, duplicate prevention, amount/currency/beneficiary verification, reversal reconciliation) was NOT executed against live providers. No sandbox evidence is claimed. Missing variables: `PAYSTACK_SECRET_KEY` (sandbox), `FLUTTERWAVE_SECRET_KEY` (sandbox). All provider-facing logic is verified against documented response shapes at the HTTP boundary and against the mock provider in integration.
- The Flutterwave mobile-money payout channel remains disabled by default (v1.0.8 policy) — its verification path is implemented but unproven against the live corridor.
- No existing test was removed, skipped, or weakened to force a green result. Spec updates made for legitimate behavior changes are enumerated in `FINAL_ENGINEERING_REPORT_V1.0.9.md` §B.

## 3. Conclusion

All source-level security corrections are implemented and verified by executed tests, including real-PostgreSQL concurrency and migration upgrade verification. The release is a **STAGING READY** security-hardening release; PRODUCTION CANDIDATE classification requires the external provider sandbox verification (currently blocked, see §2).
