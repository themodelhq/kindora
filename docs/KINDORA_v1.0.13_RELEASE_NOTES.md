# KINDORA v1.0.13 — RELEASE NOTES

**Strict Flutterwave Envelope Validation, Release Verification Completion & Payout Security Regression Lockdown**
Base: v1.0.12 (release commit `3bf94f0`). Classification: **STAGING READY**
(see `docs/FINAL_ENGINEERING_REPORT_V1.0.13.md` §H — provider sandbox
verification remains BLOCKED for lack of sandbox credentials).

---

## What changed

A targeted correction release with two confirmed v1.0.12 defects closed and
the release-verification tooling completed. No database migration, no
frontend change, no architectural change. Every v1.0.12 payout-security
protection is preserved and regression-proven.

### 1. P0 — explicit null envelope metadata is MALFORMED, not ABSENT (v1.0.13 §4)

* **Defect**: `extractFlwEnvelopeMeta()` in
  `backend/src/payouts/adapters/flutterwave-payout.adapter.ts` classified
  `meta === undefined` and `meta === null` identically as ABSENT. The two
  are materially different: `undefined` means the metadata was not supplied;
  an explicit `null` was SUPPLIED and is malformed evidence. Under the
  strict evidence-validation policy a supplied malformed container must be
  rejected, never silently ignored.
* **Exploit shape closed** (the §4.3 fixture): a response with envelope
  `meta: null` AND a complete, valid nested `data.meta`
  (`{total: 0, current_page: 1, total_pages: 1}`) previously passed the
  pagination gate using the nested container alone and classified as an
  authoritative NOT_FOUND — an automatic resubmission trigger for a
  transfer that may actually exist. It is now AMBIGUOUS: the malformed
  envelope is never silently discarded just because another container
  carries valid fields.
* **The full classification table** (implemented and unit-tested):
  `meta === undefined` → ABSENT; `meta === null` → MALFORMED;
  `meta` string/number/boolean/array → MALFORMED; envelope object without
  `page_info` → UNRECOGNIZED (existing contract); `meta.page_info ===
  undefined` → UNRECOGNIZED; `meta.page_info` null/primitive/array →
  MALFORMED; `meta.page_info` valid object → PRESENT subject to the full
  v1.0.12 pagination validation. Diagnostic reasons now accompany every
  MALFORMED/UNRECOGNIZED envelope verdict and appear in the AMBIGUOUS
  outcome's reason string.

### 2. Packaging defect — the release-verification scripts are now IN the archive (v1.0.13 §8)

* **v1.0.12 issue**: the v1.0.12 documentation referenced four release
  scripts that lived in the engineering workspace but were never packaged —
  the archive's `scripts/` directory contained only four unrelated files.
* v1.0.13 packages four genuine, argument-validating, strict-mode scripts
  inside the archive:
  * `scripts/v113_phase0_backup.sh` — baseline inspection record + verified
    restorable baseline backup (manifest, independent extraction,
    EVERY-entry verification, deterministic tar layout, nonzero exit on any
    failure);
  * `scripts/v113_final_backup.sh` — final source snapshot with required-
    file probe, manifest, archive sidecar and independent verification;
  * `scripts/verify_release_zip_v113.sh` — 19-check independent archive
    verification (integrity, counts against the recorded figures, manifest
    completeness in BOTH directions, both nested backups extracted and
    manifest-verified, migrations, structure, docs, scripts, secret
    scanning, version consistency, temp-file absence, archive metadata,
    external sidecar) plus the git comparison with an explicit
    limitation report when Git is unavailable;
  * `scripts/v113_baseline_ab_comparison.sh` — deterministic A/B runner for
    timing-sensitive regressions: same test, same infrastructure, fresh
    database per iteration, N iterations per side, complete logs preserved,
    NEW-regression detection (a test passing on the pristine baseline but
    failing on the release fails the comparison — a failure is never
    assumed harmless because an earlier release reportedly had one).

### 3. Archive checksum and attestation handling corrected (v1.0.13 §9)

* **v1.0.12 issue**: the archive carried only the NESTED backup checksum
  sidecar (`v1.0.12_final_archive.sha256`); the external release-ZIP
  sidecar and the post-packaging attestation record existed only in the
  engineering workspace.
* v1.0.13 ships `KINDORA_v1.0.13_SECURITY_COMPLETE.zip.sha256` (the actual
  SHA-256 of the completed ZIP, calculated only after all packaging changes
  are finished), an explicit `KINDORA_v1.0.13_RELEASE_ATTESTATION.md` that
  separates nested-backup checksums from the internal source manifest, the
  external ZIP checksum and the post-packaging verification results, and a
  `download/KINDORA_v1.0.13_release_figures.txt` figures file that the
  verifier checks the archive against. The ZIP's own checksum is never
  placed inside the ZIP (no self-reference).

## What did NOT change

* Every v1.0.12 pagination contract: the per-shape mandatory field sets
  (`FLW_REQUIRED_S1`/`FLW_REQUIRED_S2` = `{total, current_page,
  total_pages}`), strict alias validation, joint container validation with
  exact cross-container agreement, the S3 removal (metadata-free arrays are
  AMBIGUOUS in both directions), the S1/S2 shape distinction, and the
  deterministic 12-step lookup sequence. v1.0.13 adds NO permissive
  fallback and simplifies nothing (§5 of the release prompt).
* The four-valued lookup contract (`FOUND` / `NOT_FOUND` / `AMBIGUOUS` /
  `ERROR`) and its strict meanings: NOT_FOUND remains reachable ONLY through
  a recognized shape with complete, consistent metadata and no unresolved
  transport ambiguity; HTTP 401/403/429/5xx, timeouts, malformed JSON,
  empty bodies, unexpected shapes, missing pagination fields, explicit null
  metadata, conflicting aliases, contradictory containers, truncated
  results, metadata-free arrays and incomplete detail lookups are never
  authoritative absence.
* The payout state machine, manual-settlement mutual exclusion, four-person
  separation, MFA, approval snapshots, executor identity locking,
  exactly-once ledger posting, reservations, idempotency and the AMBIGUOUS
  recovery pipeline — all regression-proven on real PostgreSQL (§6.3–§6.9
  scenarios A–G green).
* Paystack payout adapter, Stripe donation flow, donation providers.
* Database schema and migrations (0001–0006 unchanged).
* Frontend (no change; test suite re-run green).
* Environment variables: no new variables, no configuration changes.

## Verification evidence

* Backend unit tests: **595/595 green** (25 suites), including the new
  `flutterwave-envelope-null-v113.spec.ts` (**27 tests**) executing the
  §4.3 requirements: absent/null/primitive/array envelope metadata, null/
  primitive/array `page_info`, unrecognized structures cannot authorize
  NOT_FOUND, malformed envelope + valid nested metadata stays AMBIGUOUS,
  container-arrangement independence, and the no-upgrade invariant in BOTH
  directions (never NOT_FOUND on an otherwise-authoritative empty page,
  never FOUND on a page carrying the exact match).
* Backend integration tests (real PostgreSQL 17.9 + Redis 7.2.5): **63/63
  green, zero flakes** — auth 16, webhooks 4, storage 3, money-path 12,
  withdrawals 12, payout-lockdown 16 (chunked; REAL-PostgreSQL concurrency
  scenarios §6.3–§6.9 A–G all green).
* Frontend: **53/53 green**; TypeScript clean.
* Backend TypeScript clean; `prisma validate` valid; migrations 0001–0006
  deploy-verified; audit gates PASS for backend/frontend/workers.
* Flutterwave/Paystack provider sandbox tests: **BLOCKED** (no credentials).
  Maximum honest classification: STAGING READY.
* Details: `docs/KINDORA_v1.0.13_TEST_REPORT.md`.

## Versioning

`backend/package.json`, `frontend/package.json` and `workers/package.json`
all carry `1.0.13` (lockfiles synced; dependency set unchanged).
