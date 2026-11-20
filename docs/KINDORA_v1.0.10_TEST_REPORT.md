# KINDORA v1.0.10 — Test Report

Executed: 2026-11-15, on the v1.0.10 source tree (`kindora-v110/kindora`),
runtime: REAL PostgreSQL 17 (embedded-postgres 17.4.0 binaries) + REAL Redis
7.2.5, `PROVIDER_MODE=mock`, `jest --runInBand`. Every figure below is from an
actual execution in this session — nothing is copied from previous release
reports.

## A. Executed results

| Suite | Tests | Result |
| --- | --- | --- |
| Backend unit tests (`jest`, 22 suites) | **438** | 438 passed, 0 failed |
| Backend integration — auth.e2e | 16 | 16 passed |
| Backend integration — storage.e2e | 3 | 3 passed |
| Backend integration — withdrawals.e2e | 12 | 12 passed |
| Backend integration — webhooks.e2e | 4 | 4 passed |
| Backend integration — money-path.e2e | 12 | 12 passed |
| Backend integration — payout-lockdown.e2e | 16 | 16 passed |
| **Backend integration total (real PG + Redis)** | **63** | 63 passed, 0 failed |
| Frontend regression tests (vitest, 5 files) | **53** | 53 passed |
| TypeScript compilation — backend (`tsc --noEmit`) | — | pass |
| TypeScript compilation — frontend (`tsc --noEmit`) | — | pass |
| ESLint — backend (`src/` + `test/`) | — | 0 errors, 41 warnings (pre-existing, no unused-var or style regressions introduced) |
| Production build — backend (`nest build`) | — | pass |
| Production build — frontend (`tsc && vite build`) | — | pass |
| Prisma migration validation — fresh `migrate deploy` (0001–0006) | — | pass, 0006 partial UNIQUE indexes verified |
| Prisma schema drift (`migrate diff` schema ↔ migrations) | — | NO difference detected |
| Paystack sandbox suite | — | **BLOCKED** — no sandbox credentials in the environment (`PAYSTACK_SECRET_KEY` not set) |
| Flutterwave sandbox suite | — | **BLOCKED** — no sandbox credentials in the environment (`FLUTTERWAVE_SECRET_KEY` not set) |

Passed / Failed / Blocked / Skipped / Not executed:
**Passed = 438 + 63 + 53 = 554 tests + 9 infrastructure checks; Failed = 0;
Blocked = 2 (provider sandboxes); Skipped = 0; Not executed = 0** (every test in
the repository was executed; nothing was disabled or removed).

## B. Unit test coverage of the v1.0.10 fixes

| Fix | Suite | Cases |
| --- | --- | --- |
| FLW pagination validation (§3) | `payout-adapters-v110.spec.ts`, `payout-lookup-classification.spec.ts` | 16 pagination cases (empty+total=1, flat total, consistent zero-total, plain array, contradictory pages, missing/malformed meta, missing/null content, unexpected shapes, truncated page) + verdict unit matrix |
| Exact reference identity (§4) | `payout-adapters-v110.spec.ts` | Paystack 13 cases + Flutterwave 14 cases (exact match, mismatch, missing/null/empty reference, id-only records, case-difference, list/detail disagreement, duplicate references, contradiction NOT_FOUND-behind-match, HTTP/transport matrix) |
| Outcome contract (§8) | `payout-adapters-v110.spec.ts`, `payout-lookup-classification.spec.ts` | four-valued helpers + full HTTP/transport classification (preserved from v1.0.9, extended) |
| Locked executor identity (§5) | `payout-reconciliation-atomic.spec.ts` | missing locked executor, first-approver collision, requester/first/second collisions, valid fourth person (audit records the locked identity), pre-transaction divergence abort |
| Mock provider determinism (§6.2) | exercised by integration | hold/barrier/release, duplicate-reference rejection, reference-scoped holds, request counters |

## C. Integration evidence — payout concurrency (REAL PostgreSQL)

`payout-lockdown.e2e-spec.ts` — 16 tests, all passed:

| Test | What it proves |
| --- | --- |
| §12.1 DTO allowlist | every API/legacy provider name rejected at the DTO layer |
| §4.5 invalid cycle | invalidated approval cycle refuses settlement (no grandfathering) |
| §5.1/§3.4 two-step protocol | intent authorization binds the immutable snapshot; MANUAL_EVIDENCE_RECORDED; guard SETTLED |
| §3.1/§3.2 in-lock recheck | manual settlement blocked during pending/in-flight submissions; submission deferred while the guard is claimed |
| v1.0.10 §6.3 (A) | manual intent vs provider initiation race — exactly ONE winner, zero ledger entries |
| v1.0.10 §6.4 (B) | provider request held in flight → manual settlement 409 → release → reconcile → ONE settlement |
| v1.0.10 §6.5 (C) | authorized manual intent wins first → provider initiation blocked → ONE settlement |
| v1.0.10 §6.6 (D) | provider accepted + worker crashed → recovery adopts the ORIGINAL transfer (initiationCount=1) → ONE settlement |
| v1.0.10 §6.7 (E) | 7 ambiguous/error lookup classes → reservation preserved, manual blocked, no resubmission → recovery → ONE settlement |
| v1.0.10 §6.8 (F) | lease expiry while in flight → recovery reconciles, second submission impossible → ONE settlement |
| v1.0.10 §6.9 (G) | duplicate workers → one claim, one provider request, replay posts ONE ledger entry |
| §10 reconciliation replay | replay = MATCHED/applied=false, ONE ledger entry |
| v1.0.10 §5.6 locked executor | missing executor blocked; colliding executor blocked; authorized fourth person settles — audit records the LOCKED identity |
| §12.3 ×2 lease recovery | expired-lease reclaim consults the provider BEFORE resubmission (no duplicate transfer; no-duplicate submission for never-received intents) |
| §8.2 reversal in progress | reversal lifecycle recorded, never terminal |

Explicit confirmation (§19.E): **two valid competing settlement paths were
tested** — scenario A races the ACTUAL manual intent authorization workflow
(two-step protocol, fresh MFA) against the ACTUAL provider initiation workflow
(durable intent + outbox) on real PostgreSQL; scenarios B/C additionally prove
each path winning first, deterministically.

## D. Mocked vs real-provider boundary

All provider interactions in the automated suites use the in-process mock
adapter (production-forbidden) or fetch-boundary HTTP mocks with REALISTIC
provider fixtures. **No test result in this report comes from, or was validated
against, the real Paystack/Flutterwave APIs.** The provider sandbox suites are
BLOCKED (missing credentials) — the release classification is therefore STAGING
READY, not PRODUCTION CANDIDATE.

## E. Corrected test expectations (transparency)

1. `payout-lookup-classification.spec.ts`: the v1.0.9 expectation "empty
   paginated list without metadata → NOT_FOUND" encoded the defect v1.0.10
   closes; it now asserts AMBIGUOUS (with the consistent-zero-total case
   explicitly NOT_FOUND). No assertion was weakened — the corrected contract is
   strictly more conservative.
2. `frontend/tests/unit/withdrawal-form.test.ts`: four stale pre-allowlist
   fixtures (v1.0.4-era) expected `PAYSTACK_TRANSFER`/`MANUAL_BANK` to be valid
   manual-settlement inputs — names the backend has rejected since v1.0.8. The
   fixtures were updated to the allowlist contract and an explicit regression
   case (API/legacy names rejected at the form layer) was added. The production
   validator was already correct and is unchanged.
3. `payout-reconciliation-atomic.spec.ts`: the test shell's locked-row fixture
   was extended to mirror the v1.0.10 `SELECT ... FOR UPDATE` column list
   (withdrawalId, initiatedById, provider, idempotencyKey) — required by the
   corrected reconciliation, not a behavioral change.
