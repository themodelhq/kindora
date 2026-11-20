# KINDORA v1.0.14 — RELEASE NOTES

**Targeted Release Integrity Correction, Payment Validation Preservation &
Verification Hardening**
Base: v1.0.13 (release commit `2edb74c`). Classification: **STAGING READY**
(provider sandbox verification remains BLOCKED for lack of sandbox
credentials — see `docs/KINDORA_v1.0.14_VERIFICATION_REPORT.md` §Provider).

---

## What changed

A verification-integrity release. NO application code path changed: the
Flutterwave payout adapter is byte-identical to v1.0.13 (verified
`git diff` = 0 lines), no migration, no frontend change. Every change below
serves a documented v1.0.14 defect or verification requirement.

### 1. Destructive integration-test script replaced with a SAFE runner (Phase 6)

* **Defect**: `scripts/run_integration_tests.sh` began with `pkill -9
  postgres` and `pkill -f "redis-server 127"` — killing ANY PostgreSQL and
  ANY loopback Redis on the host — plus fixed shared `rm -rf` paths and no
  cleanup on interruption. `scripts/verify_schema_match.sh` carried the
  same `pkill` pattern.
* **Correction**: the runner now (a) never kills by name or pattern; (b)
  detects port conflicts and FAILS with a diagnostic instead of touching
  the occupant; (c) creates UNIQUE per-run data/socket directories under
  `/tmp/kindora-itest-*`; (d) tracks the exact postmaster and Redis PIDs it
  created and shuts them down gracefully first (bounded waits, SIGTERM,
  SIGKILL only as a last resort against the tracked PID); (e) removes its
  run root only after a strict self-created-path guard; (f) separates
  [SETUP]/[TEST]/[RESULTS]/[CLEANUP] phases with trap-based cleanup that
  runs on success, failure AND interruption (a terminated run can no longer
  resume and print a PASS afterwards); (g) supports `--dry-run`,
  `--suite`, `--name`.
* **Proof** (`scripts/v114_safe_runner_scenarios.sh`, workspace): all six
  required scenarios pass with UNRELATED decoy PostgreSQL (:5599) and Redis
  (:5598) running — dry-run, success, failed-test (logs preserved,
  services stopped), SIGTERM-mid-jest (exit 143, cleanup ran, no orphans),
  missing-service (clean exit 2), port-conflict (clean exit 2, the foreign
  listener SURVIVES). Decoy liveness re-verified after every scenario.

### 2. A/B verification log reconciliation (Phase 5)

* **Finding**: the v1.0.13 session left four A/B log directories of differing
  completeness; the full jest logs were silently excluded by the repository's
  `*.log` ignore rule, so the tracked evidence could not support a single
  added-up count.
* **Correction**: `docs/A_B_VERIFICATION_RECONCILIATION_V1.0.14.md` enumerates
  every invocation (A = pristine v1.0.12 baseline from the pinned backup;
  B = the v1.0.13 release tree), the script revision that produced it, and
  its evidentiary status: 1 invocation ABORTED before any test (script
  defect, fixed), 1 invocation EXECUTED-but-UNRESOLVED (aggregation crashed;
  logs lost to the ignore rule — explicitly marked UNRESOLVED, excluded from
  the result), 2 VALID invocations (4 successful executions, both scenarios
  passing on both sides, 0 regressions). Nothing was added together.
* **Fresh v1.0.14 evidence**: new A/B runs (baseline = the pristine v1.0.13
  backup, verified against its sidecar) executed with the committed script,
  every run identifying its source commit and artifact; complete logs
  (jest/migrate/seed/infra) are now committed in the release evidence
  package (`git add -f` defeats the `*.log` ignore for that directory).

### 3. Artifact checksum/attestation integrity (Phase 3)

* The v1.0.13 attestation lineage is documented in the Phase-0 record: the
  FIRST v1.0.13 packaging (commit `35a67ac`, zip `8bf7fa12…`, 5,210,077
  bytes) was SUPERSEDED by the repackaging (`2edb74c`, zip `3a52754b…`,
  5,211,261 bytes) that shipped the fixed verifier, and the attestation
  record was corrected in `cf52ccf`. The committed attestation and the
  actual v1.0.13 archive AGREE (measured, not copied).
* For v1.0.14: the ZIP is built once, frozen, and every figure (SHA-256,
  size, entries, files, uncompressed bytes, manifest count) is measured
  FROM the final artifact by the verifier and the evidence package — no
  figure is copied from any earlier release. The verifier now also checks
  for DUPLICATE archive paths (Phase 3 item 10) and cross-checks the
  figures file, the sidecar, the internal manifest and the actual archive
  against each other; any disagreement FAILS verification.
* The v1.0.13 checksums are historical reference data only — they appear
  in this release solely inside the Phase-0 lineage record.

### 4. Phase-0 baseline preservation (Phase 1)

* `scripts/v114_phase0_backup.sh` verifies the pristine pre-v114 baseline
  (`KINDORA_v1.0.13_FINAL_BACKUP.tar.gz`) end-to-end — sidecar, independent
  extraction, every manifest entry, structural probe, and a contamination
  guard (the baseline must contain no v1.0.14 markers) — and records the
  v1.0.13 artifact figures by measuring the actual archive.
* Sandbox-recycle provenance: on 2026-11-17 the backup tarballs were
  dropped from the workspace while their sidecars survived; both were
  restored from INSIDE the committed v1.0.13 zip and re-verified against
  their sidecars. The committed-archive-as-recovery-source design worked
  as intended.

## What did NOT change (Phase 2 — preservation, all re-verified)

* The v1.0.13 Flutterwave envelope correction is BYTE-IDENTICAL:
  `git diff HEAD -- …/flutterwave-payout.adapter.ts` = 0 lines. ABSENT
  (`undefined`) → ABSENT; explicit `null` → MALFORMED → AMBIGUOUS;
  primitives/arrays/invalid `page_info` → MALFORMED → AMBIGUOUS; valid
  envelopes continue through the full validation flow. The 27-test
  regression suite `flutterwave-envelope-null-v113.spec.ts` is retained
  and re-executed green (27/27).
* Exact transfer identity, idempotency, duplicate-webhook protection,
  payout state transitions, ambiguous-transaction handling, ledger
  integrity, reconciliation behaviour, webhook signature verification —
  all regression-proven (Phase 8 matrix; ambiguous transactions are never
  retried, approved, settled or released — REAL-PostgreSQL scenario §6.7).
* Paystack adapter, Stripe/donation flows, database schema and migrations
  0001–0006, frontend, deployment configuration: unchanged and green.
* No new environment variables.

## Versioning

`backend/package.json`, `frontend/package.json`, `workers/package.json`
→ `1.0.14` (lockfiles synced; dependency set unchanged). Release notes,
verification report, attestation and backup filenames carry v1.0.14.
