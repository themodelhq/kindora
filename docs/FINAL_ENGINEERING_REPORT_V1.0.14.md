# KINDORA v1.0.14 — FINAL ENGINEERING REPORT

**Targeted Release Integrity Correction, Payment Validation Preservation &
Verification Hardening**
Base: v1.0.13 (release commit `2edb74c`). All figures are actual measured
results from this build environment. Detailed evidence lives in
`docs/KINDORA_v1.0.14_VERIFICATION_REPORT.md` (test matrix, safe-runner
scenarios, A/B reconciliation, provider status) and
`docs/A_B_VERIFICATION_RECONCILIATION_V1.0.14.md`. Final artifact figures
live in the attestation post-packaging record.

---

## A. Executive summary

v1.0.14 is a verification-integrity release with **zero application-code
change**. The Flutterwave payout adapter is byte-identical to v1.0.13
(`git diff` = 0 lines) — the null-envelope correction and every
pagination/identity protection are preserved and re-verified. The release
corrects three release-engineering defects: (1) the destructive
integration-test runner, (2) the unreconciled A/B evidence with silently
lost logs, (3) artifact figures that must be measured from the final
frozen archive rather than inherited. All local gates pass; provider
sandbox verification remains BLOCKED → **STAGING READY**.

## B. Findings and root causes

1. **Destructive integration-test execution** — `run_integration_tests.sh`
   killed ANY host PostgreSQL/Redis by name pattern, reused fixed shared
   `/tmp` paths with unrestricted `rm -rf`, and had no cleanup on
   interruption. Root cause: the harness predated the multi-project
   sandbox; ownership of the resources it destroyed was never established.
   Correction: the SAFE runner (PID tracking, graceful-first shutdown with
   bounded timeouts, unique guarded run roots, port-conflict detection,
   trap cleanup, `--dry-run`), proven by the 6-scenario suite with decoy
   services unaffected (verification report §3). `verify_schema_match.sh`
   received the same treatment. Backward compatibility: the same path and
   zero-argument behaviour; `--suite/--name` replace external chunking.
2. **A/B evidence unreconciled, logs silently lost** — the v1.0.13 session
   produced four A/B directories (aborted, crashed-at-aggregation, two
   valid) and the repository's `*.log` ignore rule excluded the full jest
   logs from the evidence commit. Correction: the canonical reconciliation
   report enumerates every invocation and marks the unrecoverable one
   UNRESOLVED; fresh v1.0.14 runs were executed with complete logs
   force-added to git.
3. **Artifact figures must be measured, not inherited** — the v1.0.13
   lineage (first packaging superseded by the repackaging; attestation
   corrected in `cf52ccf`) is documented in the Phase-0 record. For
   v1.0.14 the ZIP is frozen after packaging and every figure is measured
   from it — twice, from clean states — and cross-checked across the
   figures file, sidecar, internal manifest and duplicate-path probe.

## C. Exact files modified / added

| File | Change |
|---|---|
| `scripts/run_integration_tests.sh` | REPLACED with the safe runner (Phase 6); old version preserved in git history |
| `scripts/verify_schema_match.sh` | destructive `pkill`/fixed-`rm -rf` removed; unique guarded run root + trap cleanup + port-conflict detection |
| `scripts/v114_phase0_backup.sh` | NEW — baseline verification + measured v1.0.13 artifact lineage record |
| `scripts/v114_final_backup.sh` | NEW — v1.0.14 final snapshot (required-file probe updated) |
| `scripts/verify_release_zip_v114.sh` | NEW — v113 verifier + duplicate-archive-path check + v1.0.14 versions/docs/nested-backups |
| `docs/KINDORA_v1.0.14_RELEASE_NOTES.md`, `docs/KINDORA_v1.0.14_VERIFICATION_REPORT.md`, `docs/FINAL_ENGINEERING_REPORT_V1.0.14.md`, `docs/PROVIDER_INTEGRATION_V1.0.14.md`, `docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.14.md`, `docs/A_B_VERIFICATION_RECONCILIATION_V1.0.14.md` | NEW documentation |
| `README.md` | v1.0.14 section |
| `backend/frontend/workers package.json` + lockfiles | version → 1.0.14 (dependencies unchanged) |

Untouched: `backend/src/**` (adapter byte-identical — `git diff` = 0
lines), all tests, schema/migrations, frontend, workers, deployment config.

## D. Preserved protections (evidence)

Verification report §2 maps all twelve Phase-2 cases to their executing
suites — envelope semantics (ABSENT/MALFORMED/UNRECOGNIZED/PRESENT), exact
transfer identity, duplicate webhook absorption, idempotent replay,
ambiguous reconciliation (REAL-PG §6.7), payout state protections (§6.3–
§6.9), ledger integrity, signature verification: all green this release.
Ambiguous transactions are never retried, approved, settled or released.

## E. Tests executed (actual)

See verification report §1: backend unit 595/595; adapter subset 268/268;
integration 63/63 via the SAFE runner (9 runs, fresh PG/Redis each, zero
flakes); frontend 53/53; TypeScript backend+frontend clean; prisma valid;
audit gates 3× PASS; migrations 0001–0006 verified; safe-runner scenarios
6/6; fresh A/B runs (3-iteration timing-sensitive + concurrency) — no new
regression; archive verifier PASS (twice).

## F. Blocked tests

Flutterwave and Paystack SANDBOX suites: BLOCKED — `FLUTTERWAVE_SECRET_KEY`
/ `PAYSTACK_SECRET_KEY` unavailable. No live-provider claim is made
anywhere; unit/mocked tests are explicitly NOT treated as sandbox
verification.

## G. Backup and archive evidence

* Pristine pre-v114 baseline: `KINDORA_v1.0.13_FINAL_BACKUP.tar.gz`
  (SHA-256 `350c961e…`, 433 files) — sidecar-verified, independently
  extracted, every manifest entry verified, contamination guard green.
  Restored from inside the committed v1.0.13 zip after a sandbox recycle
  dropped the workspace copies (sidecars survived) — the recovery design
  worked as intended.
* Final v1.0.14 backup: `backups/KINDORA_v1.0.14_FINAL_BACKUP.tar.gz`
  (deterministic, manifest-verified; figures in the sidecar).
* Release archive: built once, frozen, measured twice — figures in the
  attestation record; force-tracked in git as the recovery source.

## H. Remaining limitations

1. Provider sandbox suites BLOCKED (credentials) — the only outstanding
   verification gate; run them before any production rollout.
2. The v1.0.13 A/B invocation `v113-ab-20261116T131709Z` stays UNRESOLVED
   (documented, excluded from the evidence base).
3. Build-environment fragility (sandbox recycles processes, `/tmp` and
   untracked large files): mitigated by committed archives, verified
   sidecars, and the recovery procedures that were EXERCISED this release.

## I. Final release classification

**STAGING READY** — not production-ready until the blocked sandbox suites
are executed with real credentials. All local verification gates pass;
no financial-safety invariant weakened; no unresolved technical defect.
