# TEST RESULTS — KINDORA v1.0.14 SECURITY COMPLETE (evidence correction, 2026-11-20)

All figures below are measured results from the 2026-11-20 executions captured
in `logs/` (source revision `755f0e9061954c69a5cc537259d14a77aa695faf`).
Nothing is copied from previous releases.

## Results by category (counts deliberately NOT summed into one total — §12)

| Category | Result | Passed | Failed | Skipped† | Evidence |
|---|---|---:|---:|---:|---|
| Backend unit tests | PASSED | 595 | 0 | 0 | `logs/backend-tests.log` |
| Frontend tests (vitest) | PASSED | 53 | 0 | 0 | `logs/frontend-tests.log` |
| Flutterwave regression | PASSED | 157 | 0 | 0 | `logs/flutterwave-regression.log` |
| Paystack regression | PASSED | 111 | 0 | 0 | `logs/paystack-regression.log` |
| Payout+ledger regression | PASSED | 184 | 0 | 0 | `logs/payout-ledger-regression.log` |
| Integration tests (SAFE runner) | PASSED | 63 | 0 | 24‡ | `logs/integration-tests.log` |
| Integration runner safety (A–H) | PASSED | 16 | 0 | 0 | `logs/integration-safety-tests.log` |
| Baseline A/B run 1 | NO NEW REGRESSION | 3/3 both sides | 0 | 0 | `logs/ab-comparison-run-1.log` |
| Baseline A/B run 2 | NO NEW REGRESSION | 3/3 both sides | 0 | 0 | `logs/ab-comparison-run-2.log` |
| Engineering gates | PASSED | tsc ×2, prisma, schema-structural, audit-gates ×3 | 0 | 0 | `logs/engineering-gates.log` |
| Provider sandbox suites | **BLOCKED** | — | — | — | README §provider sandbox |

† skips are jest-reported per-invocation skips only (see ‡); no test was omitted.
‡ the 16 payout-lockdown tests execute across 3 name-chunked runner
invocations with disjoint `-t` filters (4+4+8, verified disjoint and complete
before the run); each chunk reports the other chunks' tests as "skipped".
Every one of the 63 integration tests executed exactly once.

## Release verifier check counts (not a test total)

The packaged verifier (`scripts/verify_release_zip_v114.sh`) defines its own
check set; its count is whatever the current script declares and is reported
verbatim in its `VERIFICATION RESULT` lines. The authoritative count for THIS
artifact is in the external post-freeze records (`verifier-run-1.log` /
`verifier-run-2.log` in the delivery directory). Verifier checks are release
gates, not tests, and are never summed with test counts.

## Count reconciliation (§12 — corrections of earlier claims, none hidden)

| Earlier claim | Where | Status | Correction |
|---|---|---|---|
| Verifier = "52/52 checks PASSED, run TWICE" | superseded archive's attestation md (line 41) | **STALE** — describes an earlier verifier revision | The current verifier's own `VERIFICATION RESULT` lines are authoritative; the in-archive attestation md now describes the corrected verifier without a fixed count claim |
| Frontend "52/52" | docs/TEST_REPORT.md, FINAL_REPORT.md (v1.0.1), PRODUCTION_READINESS_CHECKLIST.md (v1.0.4) | **HISTORICAL, correct for their versions** | left unchanged — version-scoped records; current measurement is 53/53 |
| Flutterwave "4 suites / 168 tests" | previous release's flutterwave-regression.log | **FAILED PROVENANCE** — summary-only, internally inconsistent (3 suites listed, 4 claimed), no raw output, unreproducible against the unchanged src tree | NOT reused; superseded by the fresh raw-output log: **157/157, 3 suites** (the 3 committed flutterwave spec files) |
| Integration "63/63" | previous evidence | **CONFIRMED** — reproduced exactly (63 executed, each exactly once, chunk accounting 4+4+8) | re-measured fresh; unchanged |

## Blocked evidence

| Evidence | Status | Reason | Required dependency | Not executed |
|---|---|---|---|---|
| Flutterwave/Paystack provider sandbox suites | **BLOCKED** | `FLUTTERWAVE_SECRET_KEY` / `PAYSTACK_SECRET_KEY` unavailable in the build environment | provider sandbox credentials | any live-provider verification; no live money-path test was executed or claimed |
