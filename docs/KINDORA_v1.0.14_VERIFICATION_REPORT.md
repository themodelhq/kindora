# KINDORA v1.0.14 — RELEASE VERIFICATION REPORT

All figures are ACTUAL measured results from this build environment against
the v1.0.14 tree. Nothing is carried over without re-execution. Where the
release prompt's phases produced artifacts, this report references them by
exact path. Build environment: Linux sandbox, Node 24, npm ci from the
committed lockfiles; integration runs on embedded PostgreSQL **17.9** +
Redis **7.2.5** (built from the official source tarball) provisioned BY THE
SAFE RUNNER (`scripts/run_integration_tests.sh`) with PID tracking and
trap-based cleanup.

---

## §1. Test matrix (Phase 8 — actual counts)

| Test category | Result | Executed | Failed | Skipped |
|---|---|---:|---:|---:|
| Backend unit tests (`npx jest --silent`) | PASS | 595 | 0 | 0 |
| Payment adapters (subset: v113 27 + v112 55 + identity 75 + v110 58 + adapters 16 + lookup-classification 37) | PASS | 268 | 0 | 0 |
| Flutterwave regression (envelope-null suite + pagination matrices) | PASS | 127 | 0 | 0 |
| Paystack regression (`payout-adapters.spec.ts` Paystack cases + shared) | PASS | 16 | 0 | 0 |
| Payout tests (adapter subset + payout-lockdown e2e) | PASS | 268 + 16 | 0 | 0 |
| Ledger integrity (ledger/webhooks/money suites) | PASS | included in 595 unit + 16 e2e | 0 | 0 |
| Webhook tests (webhooks.e2e + unit webhook cases) | PASS | 4 e2e + unit subset | 0 | 0 |
| Idempotency tests (duplicate webhook absorption, refresh-replay, exactly-once) | PASS | included above | 0 | 0 |
| Integration tests (safe runner, real PG 17.9 + Redis 7.2.5) | PASS | 63 | 0 | 60 (name-chunked runs skip non-matching tests; every test runs in at least one chunk) |
| Frontend tests (`npx vitest run`) | PASS | 53 | 0 | 0 |
| Build validation (backend `tsc --noEmit`, frontend `tsc --noEmit`, `prisma validate`) | PASS | 3 | 0 | 0 |
| Release archive verification (`verify_release_zip_v114.sh` ×2) | PASS | 2 runs | 0 | 0 |

Integration detail (each run = one fresh PG/Redis instance via the safe
runner): auth 16 ✓, webhooks 4 ✓, storage 3 ✓, money-path 12 ✓,
withdrawals 12 ✓, payout-lockdown 16 ✓ (4 name-chunks: 4+3+3+6). Zero
flakes. The 60 "skipped" figures are jest's per-chunk accounting of tests
outside that chunk's name filter — each of the 16 lockdown tests executed
in exactly one chunk.

## §2. Phase-2 preservation matrix (12 required cases → executing suites)

| # | Required case | Executing suite/test (all green this release) |
|---|---|---|
| 1 | Undefined metadata | `flutterwave-envelope-null-v113.spec.ts` #1 |
| 2 | Explicit null metadata | v113 #2 + the verbatim §4.3 fixture #8 |
| 3 | Primitive metadata | v113 #10 matrix (number/string/boolean envelopes) |
| 4 | Array metadata | v113 #6 + #10 (`[]`) |
| 5 | Invalid page_info | v113 #4/#4b (null) + #5×3 (primitives) + #6 (array) |
| 6 | Valid metadata | v113 #9b (control) + #3a |
| 7 | Valid pagination | v113 #3a/#3c + retained v112 §3/§4 suites (55 tests) |
| 8 | Invalid transfer identity | `flutterwave-pagination-identity.spec.ts` (75 tests: detail-id missing/mismatch, reference mismatch, duplicates) |
| 9 | Duplicate webhook delivery | `webhooks.e2e-spec.ts` ("applies charge.success exactly once: duplicate deliveries are absorbed") + unit webhook cases |
| 10 | Ambiguous transfer reconciliation | `payout-lockdown.e2e-spec.ts` §6.7 (E) on real PostgreSQL + v113 suite |
| 11 | Idempotent replay | webhooks.e2e duplicate absorption + auth refresh-reuse rejection (16 ✓) + identity suite |
| 12 | Payout state protections | payout-lockdown 16 ✓ (mutual exclusion, snapshots, executor locking, lease reclaim) + withdrawals suite (overdraw race) |

The adapter is byte-identical to v1.0.13 (`git diff` = 0 lines); no
assertion was weakened; no existing test was deleted.

## §3. Safe-runner scenario proof (Phase 6)

`scripts/v114_safe_runner_scenarios.sh` — **6/6 scenarios PASS** with
unrelated decoy PostgreSQL (:5599) and Redis (:5598) running throughout;
decoy liveness re-verified after EVERY scenario:

| Scenario | Result | Key assertion |
|---|---|---|
| 1. Dry-run | PASS | plan printed; nothing created |
| 2. Successful execution | PASS | 3/3 tests; run root removed (0 leftovers) |
| 3. Failed test execution | PASS | nonzero exit; logs preserved at `/tmp/kindora-itest-*-FAILED`; runner postgres stopped |
| 4. Interruption (SIGTERM mid-jest, process group) | PASS | exit 143; cleanup ran; NO orphaned services; a terminated run never prints PASS afterwards |
| 5. Missing service | PASS | clean exit 2 with diagnostic |
| 6. Port conflict | PASS | clean exit 2; the FOREIGN listener survives |

Dangerous operations removed: `pkill -9 postgres`, `pkill -f "redis-server
127"` and the fixed shared `rm -rf` paths no longer exist in
`scripts/run_integration_tests.sh` or `scripts/verify_schema_match.sh`.
Log references: `release-verification-logs/v114-safe-runner-scenarios/`.

## §4. A/B reconciliation and fresh evidence (Phase 5)

* Canonical reconciliation: `docs/A_B_VERIFICATION_RECONCILIATION_V1.0.14.md`
  — 4 tracked invocations enumerated (1 aborted, 1 UNRESOLVED with logs
  lost, 2 valid); canonical result: 4 successful executions, 0 failures,
  0 regressions; the unresolved invocation is excluded, not averaged in.
* Fresh v1.0.14 runs (A = pristine v1.0.13 backup `350c961e…` sidecar-verified
  after the recycle restore; B = the v1.0.14 tree):
  * payout-lockdown §3.1/§3.2 — 3 iterations per side: **1 test, PASSED on
    both sides in all 3 iterations — no new regression** (log dir
    `v113-ab-20261117T092615Z`).
  * withdrawals concurrency — 1 iteration per side: **PASSED on both
    sides — no new regression** (`v113-ab-20261117T092807Z`).
  * Both runs identify their source commit (HEAD at execution) and target
    the same final ZIP during final verification; complete logs committed.

## §5. Provider verification (Phase 7)

| Provider | Unit/regression status | Sandbox status |
|---|---|---|
| Flutterwave | PASS (envelope classification, pagination contract, identity chain — 127 adapter tests + 16 e2e recovery/concurrency scenarios) | **BLOCKED** — `FLUTTERWAVE_SECRET_KEY` not available |
| Paystack | PASS (`payout-adapters.spec.ts` 16/16: signature validation, idempotency, exact-reference lookup, authoritative not-found) | **BLOCKED** — `PAYSTACK_SECRET_KEY` not available |
| Stripe / donation providers | PASS (existing suites inside the 595-test unit run) | not applicable (existing regression scope) |

No sandbox verification is claimed. The exact missing prerequisites are
the two secret-key environment variables; the release therefore retains
outstanding external verification.

## §6. Artifact integrity (Phase 3/10)

The final ZIP is built once and FROZEN; the verifier runs TWICE from clean
states against the same SHA-256. Actual measured figures: the release
attestation (`release/KINDORA_v1.0.14.attestation.json` +
`docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.14.md` post-packaging record) and
the figures file — generated from the final artifact, never copied. The
v1.0.13 checksums (5,211,261 bytes / `3a52754b…`) are historical reference
data and appear only in the Phase-0 lineage record.

## §7. Release classification

**STAGING READY** — every local gate passes; both external provider
sandbox suites are BLOCKED by unavailable credentials (Phase 7), so the
release is not PRODUCTION CANDIDATE. Not production-ready until sandbox
verification is executed with real credentials.

## §8. Unresolved items

1. Flutterwave + Paystack sandbox verification: BLOCKED (missing
   credentials) — the only outstanding verification gate.
2. The v1.0.13 A/B invocation `v113-ab-20261116T131709Z` remains UNRESOLVED
   (logs lost to the historical `*.log` ignore rule before the force-add
   correction); its console transcript suggested both sides passed, but it
   is excluded from the evidence base by design.
