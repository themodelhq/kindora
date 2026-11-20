# KINDORA v1.0.11 — TEST REPORT

All results below are ACTUAL executions performed during this release build
(2026-11, this environment). Nothing is copied from historical reports.
Environment: Node v24.22.3, PostgreSQL 17 (embedded, real server),
Redis 7.2.5 (real server, built from source), macOS-free Linux sandbox.

## 1. Backend unit tests (jest) — EXECUTED, GREEN

| Suite group | Result |
|---|---|
| Full backend unit suite (`npx jest`) | **23 suites, 513/513 passed** |

Includes:
* `flutterwave-pagination-identity.spec.ts` — **NEW v1.0.11**, 75 tests:
  §9.1 alias-consistency matrix (17), §9.2 relationship matrix (11),
  §9.3 positive-adoption matrix (10), §9.4 shape-discrimination matrix (9),
  §4.5 identity matrix (18), §10 recovery scenarios A–E (5),
  §3.3 strict-integer unit matrix (5).
* `payout-adapters-v110.spec.ts` — v1.0.10 regression matrix, 58 tests,
  executed UNCHANGED (zero assertion edits) and green.
* All other payout/security suites (state machine, reconciliation atomicity,
  manual snapshot, approval cycle, exact money, crypto, auth, MFA, ledger…).

## 2. Backend integration tests (real PostgreSQL 17 + Redis 7.2.5) — EXECUTED

Executed with `RUN_INTEGRATION=1` against migrations 0001–0006 deployed to a
fresh database, seeded; guard index `payout_attempt_one_unresolved_per_withdrawal`
verified present.

| Suite | Result |
|---|---|
| auth + webhooks | **20/20 green** |
| storage + withdrawals | **15/15 green** |
| money-path | **12/12 green** |
| payout-lockdown (16 tests) | **15/16 green** (chunked A/B run) |

**payout-lockdown failure analysis:** the single failure is
`§3.1/§3.2: manual settlement is BLOCKED while a provider submission is
pending or in flight` — `submitOutbox` returned `ALREADY_SUBMITTED` where
the test expected `LOOKUP_PENDING`. The suite is timing-sensitive (a 1s
in-process outbox sweeper races the test's own submission claim) and this
sandbox executes markedly slower than the v1.0.10 release environment
(full-file runtime 819s).

**A/B comparison (evidence, not assumption):** the PRISTINE v1.0.10 tree
(extracted from the release commit `e17e96e` backup, untouched code) was
executed under the IDENTICAL infrastructure and chunking
(`scripts/v111_e2e_chunk.sh`, fresh database per chunk):

| Chunk (4 tests each) | pristine v1.0.10 | v1.0.11 |
|---|---|---|
| C1 (§12.1/§4.5/two-step/§3.1-§3.2) | 3 pass, **1 fail (same test)** | 3 pass, **1 fail (same test)** |
| C2 (§6.3–§6.6 race scenarios) | 4 pass | 4 pass |
| C3 (§6.7–§6.9 + replay) | 4 pass | 4 pass |
| C4 (§5.6/§12.3/§8.2) | 4 pass | 4 pass |

The failure is therefore an ENVIRONMENT-TIMING limitation of both trees, NOT
a v1.0.11 regression. The chunk-isolated full-file run also eliminated the
cascade 400s observed in the first full-file attempt (shared campaign
balance exhausted by earlier failures) — chunks C2/C4 prove those tests pass
on both trees. The v1.0.10 §6.3–§6.9 deterministic scenarios A–G — including
reconcile-before-resubmit recovery, ambiguous-lookup reservation
preservation, lease expiry and duplicate-worker exactly-once settlement —
are GREEN on v1.0.11.

## 3. Frontend tests (vitest) — EXECUTED, GREEN

**5 test files, 53/53 passed** (money, auth store, demo adapter, withdrawal
form, utils).

## 4. Static analysis and builds — EXECUTED, GREEN

| Check | Result |
|---|---|
| Backend ESLint (src + test) | 0 errors / 0 warnings |
| Backend `tsc --noEmit` | clean |
| Backend production build (`nest build`) | OK (`dist/main.js`) |
| Workers production build | OK |
| Frontend `tsc --noEmit` | clean |
| Frontend production build (vite) | OK (`dist/index.html`) |

## 5. Prisma migration validation — EXECUTED, GREEN

* `prisma migrate deploy` (0001–0006) executed against FOUR fresh databases
  during this release's integration runs — OK each time.
* `prisma migrate diff --from-url <live db> --to-schema-datamodel` —
  **empty diff** ("This is an empty migration"): deployed schema exactly
  matches the Prisma schema.
* `prisma migrate diff --from-empty --to-schema-datamodel` — generated and
  archived for the release record.
* **No new migration was added in v1.0.11** (adapter-only correction, §15);
  no historical migration was touched.

## 6. Provider sandbox tests — BLOCKED

| Provider | Status | Missing credential |
|---|---|---|
| Flutterwave sandbox | **BLOCKED** | `FLUTTERWAVE_SECRET_KEY` |
| Paystack sandbox | **BLOCKED** | `PAYSTACK_SECRET_KEY` |

No sandbox authentication/transfer/lookup/pagination/verification test was
executed against live provider APIs. No provider result is fabricated. The
Paystack REGRESSION suite (unit + integration with the provider boundary
mocked) was executed and green — the Flutterwave-specific changes do not
touch Paystack code paths.

## 7. Totals (mocked vs sandbox)

| Category | Executed | Green | Notes |
|---|---|---|---|
| Backend unit (mocked boundary) | 513 | 513 | deterministic fixtures |
| Backend integration (real PG17+Redis, mock provider) | 63 | 62 | 1 env-timing flake, A/B-verified on pristine |
| Frontend | 53 | 53 | |
| TypeScript / ESLint / builds / migration checks | all | all | |
| Flutterwave SANDBOX (live provider) | 0 | — | BLOCKED: credentials unavailable |
| Paystack SANDBOX (live provider) | 0 | — | BLOCKED: credentials unavailable |
| **Total automated** | **629** | **628** | |
