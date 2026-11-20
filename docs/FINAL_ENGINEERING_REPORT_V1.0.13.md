# KINDORA v1.0.13 — FINAL ENGINEERING REPORT

**Strict Flutterwave Envelope Validation, Release Verification Completion &
Payout Security Regression Lockdown**
Base: v1.0.12 (release commit `3bf94f0`). All figures are actual measured
results from this build environment. External provider sandbox verification
remains **BLOCKED** (no credentials) — see §H. Final archive checksums and
post-packaging verification results are recorded in
`docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.13.md` (post-packaging record) and
`download/KINDORA_v1.0.13_RELEASE_ATTESTATION.md`.

---

## A. Executive summary

v1.0.13 closes the two confirmed v1.0.12 defects and completes the release
verification tooling, preserving every existing payout-security protection:

1. **P0 — strict null handling in the Flutterwave envelope metadata**
   (`extractFlwEnvelopeMeta()`): `meta === null` is now MALFORMED instead of
   ABSENT. The exploit shape — envelope `meta: null` over a complete, valid
   nested `data.meta`, previously classified as an authoritative NOT_FOUND
   (an automatic resubmission trigger) — is AMBIGUOUS under v1.0.13, with
   the full classification table of §4.2 implemented and unit-tested
   (27 new tests).
2. **Packaging — the release-verification scripts are now packaged INSIDE
   the archive** (`scripts/v113_phase0_backup.sh`,
   `scripts/v113_final_backup.sh`, `scripts/verify_release_zip_v113.sh`,
   `scripts/v113_baseline_ab_comparison.sh`), correcting the v1.0.12
   discrepancy where documented scripts existed only in the engineering
   workspace.
3. **Checksum/attestation handling** — the external release-ZIP sidecar
   (`KINDORA_v1.0.13_SECURITY_COMPLETE.zip.sha256`, computed only after all
   packaging changes are finished), the independent figures file the
   verifier checks against, and a two-copy attestation (in-archive stub
   without self-referential figures; post-packaging measured record) now
   clearly separate nested-backup checksums, the internal source manifest,
   the external ZIP checksum and the post-packaging verification results.

No migration, no frontend change, no architectural change, no new
environment variables. All local automated tests pass; both provider
sandbox suites are BLOCKED → **STAGING READY** (the maximum honest
classification under the §16 rules).

## B. Original v1.0.12 findings and root causes

### Finding 1 (P0) — `meta === null` collapsed into ABSENT

* **File**: `backend/src/payouts/adapters/flutterwave-payout.adapter.ts`,
  function `extractFlwEnvelopeMeta()`.
* **Root cause**: the v1.0.12 guard `if (raw === undefined || raw === null)
  return { kind: 'ABSENT' }` treated two materially different conditions as
  equivalent. `undefined` = the field was not supplied (a legitimate ABSENT);
  `null` = the field was EXPLICITLY SUPPLIED and is malformed evidence. The
  joint-container flow adds the envelope container only when PRESENT and
  rejects the shape only on MALFORMED/UNRECOGNIZED — so a null envelope was
  silently discarded while the nested container alone carried the
  classification, violating the strict evidence-validation policy ("a
  supplied container that is not usable is never silently ignored").
* **Correction**: `undefined` → ABSENT; `null` → MALFORMED with an explicit
  diagnostic reason; envelope primitives/arrays → MALFORMED with reasons;
  object-without-`page_info` / `page_info === undefined` → UNRECOGNIZED;
  `page_info` null/primitive/array → MALFORMED; valid `page_info` object →
  PRESENT subject to the full pagination validation. The extraction type now
  carries diagnostic reasons (`{ kind: 'UNRECOGNIZED' | 'MALFORMED';
  reason: string }`) which propagate into the AMBIGUOUS outcome's reason.
  No existing classification rule was weakened (verified by the retained
  v1.0.11/v1.0.12 matrices passing unchanged).

### Finding 2 (P1) — release-verification scripts missing from the archive

* **Root cause**: the v1.0.12 chain kept its release scripts in the
  engineering workspace (`/home/z/my-project/scripts/`) while the archive
  packaged only the application tree's own `scripts/` directory — the
  documentation referenced artifacts the archive did not contain.
* **Correction**: the four v1.0.13 release scripts were written INTO the
  application tree (`kindora/scripts/`), committed, executed, and verified
  present inside the final archive by
  `verify_release_zip_v113.sh` check 14. They are layout-aware (they work
  both from the development checkout — pinned-rev `git archive` — and from
  a clean extraction of the release ZIP), validate arguments and required
  commands, use strict shell settings, quote paths, avoid destructive
  operations, return meaningful exit codes, preserve readable logs, and
  print no secrets.

### Finding 3 (P1) — archive checksum/attestation incompleteness

* **Root cause**: v1.0.12 packaged only the nested-backup checksum sidecar;
  the external ZIP sidecar and the measured attestation record lived
  outside the archive, so an auditor holding only the ZIP could not verify
  it against an independent checksum.
* **Correction**: §3 above. The ZIP's own checksum is never placed inside
  the ZIP (no self-reference); the figures file lives outside the archive
  and is produced by the packaging step before verification.

## C. Exact source files modified

| File | Change |
|---|---|
| `backend/src/payouts/adapters/flutterwave-payout.adapter.ts` | `extractFlwEnvelopeMeta()` classification table + diagnostic reasons; the two envelope UNSUPPORTED reasons in `classifyFlwListShape()` now include the extraction reason. NO other logic touched. |
| `backend/src/payouts/adapters/flutterwave-envelope-null-v113.spec.ts` | NEW — 27-test regression suite (§4.3 matrix, verbatim fixture, no-upgrade invariant, arrangement independence). |
| `scripts/v113_phase0_backup.sh` | NEW — baseline record + verified deterministic baseline backup. |
| `scripts/v113_final_backup.sh` | NEW — final snapshot with required-file probe + manifest + independent verification. |
| `scripts/verify_release_zip_v113.sh` | NEW — 19-check independent archive verification + git comparison with explicit limitation reporting. |
| `scripts/v113_baseline_ab_comparison.sh` | NEW — deterministic baseline-vs-release A/B runner with NEW-regression detection. |
| `backend/package.json` / `frontend/package.json` / `workers/package.json` (+ lockfiles) | version → 1.0.13 (dependency set unchanged; `npm ci` re-verified). |
| `docs/KINDORA_v1.0.13_RELEASE_NOTES.md`, `docs/KINDORA_v1.0.13_TEST_REPORT.md`, `docs/FINAL_ENGINEERING_REPORT_V1.0.13.md`, `docs/PROVIDER_INTEGRATION_V1.0.13.md`, `docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.13.md` | NEW documentation (this release only; no stale v1.0.12 claims copied). |
| `README.md` | v1.0.13 release section added. |

Untouched: all payout pipeline services, the Paystack/Stripe adapters, the
database schema and migrations, the frontend source, the workers source.

## D. Security invariants preserved (evidence)

Every protection below is regression-proven in THIS release's executed runs
(§E), not asserted from earlier reports:

* Manual settlement/provider initiation mutual exclusion + locked recheck +
  durable guard — `payout-lockdown.e2e-spec.ts` §12.1/§4.5/§5.1/§3.1/§3.2
  (real PostgreSQL): 4 tests green.
* Genuine concurrency (deterministic synchronization barriers holding one
  operation in flight while the competitor proceeds): §6.3–§6.5 (A–C) —
  3 tests green; §6.6–§6.9 (D–G) recovery/lease/duplicate-worker — 4 tests
  green.
* Exactly-once ledger posting, atomic transitions, reservation integrity —
  withdrawals (12) and money-path (12) suites green.
* Four-person separation, MFA, immutable approval snapshots, executor
  identity locking, reversal lifecycle — payout-lockdown 16/16 green.
* The AMBIGUOUS recovery pipeline handles the v1.0.13 classification
  end-to-end (scenario §6.7 (E)): reservation preserved, no second
  transfer, settlement blocked, original transfer reconciled once lookups
  recover.
* No client-controlled flag can disable dual approval or provider
  verification (unchanged server-side policy; no such parameter exists in
  the diff).
* Ledger integrity under duplicate webhooks/refunds — webhooks suite 4/4.

## E. Tests executed and actual results (this release build)

| Suite | Command | Environment | Passed | Failed | Skipped | Independently reproduced |
|---|---|---|---|---|---|---|
| Backend unit | `npx jest --silent` (backend/) | Node 24, npm ci from lockfile | 595/595 (25 suites) | 0 | 0 | yes (full run) |
| — new v1.0.13 envelope suite | included above | deterministic fixtures | 27/27 | 0 | 0 | yes |
| Backend integration | `scripts/v112_e2e_chunk.sh <suite>` × 8 chunks | real PG 17.9 + Redis 7.2.5, fresh DB per chunk | 63/63 | 0 | 0 | yes (chunked runs) |
| Frontend unit | `npx vitest run` (frontend/) | Node 24 | 53/53 (5 files) | 0 | 0 | yes |
| Backend TS | `npx tsc --noEmit` | — | clean | 0 | — | yes |
| Frontend TS | `npx tsc --noEmit` | — | exit 0 | 0 | — | yes |
| Prisma validate | `npx prisma validate` (with DATABASE_URL) | — | valid | 0 | — | yes |
| Migrations | `prisma migrate deploy` per chunk + verifier count | real PG | 6/6 applied | 0 | — | yes |
| Audit gates | `node scripts/audit-gate.mjs backend\|frontend\|workers` | — | 3× PASS | 0 | — | yes |
| Phase-0 backup | `scripts/v113_phase0_backup.sh` ×2 | — | 430/430 entries verified, 0 failures, byte-identical reruns | 0 | — | yes (determinism) |
| Final backup | `scripts/v113_final_backup.sh` | — | all manifest entries verified, 0 failures | 0 | — | yes |
| Archive verification | `scripts/verify_release_zip_v113.sh` | — | see the attestation record | 0 | — | yes |
| A/B comparison | `scripts/v113_baseline_ab_comparison.sh` (1 iteration/side, payout-lockdown §3.1/§3.2) | identical PG 17.9 + Redis 7.2.5, fresh DB each | NO new regression | 0 | — | yes |

Log locations: unit/jest output captured in the run transcripts; e2e logs
`/tmp/migrate-*.log`, `/tmp/seed-*.log`, `/tmp/e2e-*.log`; A/B logs
`release-verification-logs/v113-ab-<stamp>/` (jest, migrate, seed, pg,
npm-ci per side per iteration). Backup/archive logs in the phase-0 record
(`backups/v1.0.13_phase0_baseline_record.txt`) and the attestation.

## F. Tests blocked and reasons

* **Flutterwave sandbox suite** (authentication, transfer initiation,
  merchant-reference persistence, duplicate-reference behaviour, paginated
  reference lookup, valid empty result, incomplete pagination,
  contradictory pagination, null envelope metadata, malformed responses,
  exact-reference verification, detail lookup, amount/currency/beneficiary
  verification, worker-interruption recovery): **BLOCKED** — no
  `FLUTTERWAVE_SECRET_KEY`. Compensating control: the full HTTP-boundary
  matrix is covered by the deterministic mocked-boundary suites (§1 of the
  test report) and the real-database integration suite.
* **Paystack sandbox suite** (authentication, transfer initiation,
  idempotency, reference persistence, exact-reference lookup,
  authoritative not-found, provider unavailability, ambiguous lookup,
  recovery, duplicate-transfer prevention): **BLOCKED** — no
  `PAYSTACK_SECRET_KEY`. The Paystack adapter's local regression suite
  (`payout-adapters.spec.ts`, 16 tests) is green.

No sandbox verification is claimed anywhere. Under §16 the release cannot
be PRODUCTION CANDIDATE; the classification below is the maximum honest
one.

## G. Backup and archive verification evidence

* **Baseline backup** (`backups/KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz`):
  built from the pinned pristine v1.0.12 release tree (`git rev 3bf94f0`)
  plus the release sidecars as `release-metadata/`; deterministic layout
  (sorted entries, fixed mtime, `gzip -n` — two consecutive runs produced
  byte-identical archives, SHA-256 `6ad7b7119c9272c3b6b9f5f4bcd4a86d592a65c550fe56b29b46d88d0df52c3a`,
  1,629,860 bytes, 430 files); manifest over every file; independent
  extraction; EVERY entry verified; 0 failures; migrations and structural
  probe green. Documented exclusions: node_modules (reproducible from
  lockfiles), dist output, caches/logs, real-secret env files (absent from
  the tracked tree — verified by the release secret scan).
* **Final backup** (`backups/KINDORA_v1.0.13_FINAL_BACKUP.tar.gz`):
  post-release deterministic source snapshot; required-file probe (19
  paths) executed before archiving; manifest over every file; independent
  extraction + EVERY-entry verification; figures recorded in the sidecar
  and the attestation.
* **Release archive**: built by `scripts/package_release_v113.sh` from the
  committed release tree; nested recovery backups included (the v1.0.12
  baseline + the v1.0.13 final); internal `SHA256SUMS.txt` manifest over
  every packaged file; external sidecar + figures file; 19-check
  independent verification (`scripts/verify_release_zip_v113.sh`) with the
  git comparison against the release commit tree. Measured values: the
  attestation post-packaging record. The archive is force-tracked in git
  as the recycle-resilient recovery source
  (`git cat-file blob HEAD:download/KINDORA_v1.0.13_SECURITY_COMPLETE.zip`).

## H. Remaining limitations

1. **Provider sandbox verification remains BLOCKED** (no credentials). The
   correction is strictly more conservative: only responses carrying
   malformed envelope evidence move INTO AMBIGUOUS; no response classifies
   more permissively than v1.0.12. Operational exposure is bounded to
   additional manual reviews. Run the §4.2 classification shapes against
   the sandbox before production rollout when credentials exist.
2. **AMBIGUOUS rate monitoring**: responses with explicitly null envelope
   metadata (previously auto-classified) now escalate to manual review —
   intended fail-closed behaviour; operations should watch the manual
   review queue on the Flutterwave payout path.
3. **Build-environment fragility**: the sandbox recycles processes, `/tmp`
   and file modes. Mitigated by the committed archive as recovery source,
   deterministic manifest-verified backups reproducible from git alone,
   and the packaged scripts being layout-aware (they run from a clean
   extraction).
4. **The A/B comparison was exercised with 1 iteration per side** on the
   historically timing-sensitive scenario (no flake occurred this release
   — zero flakes across the 63-test integration suite). For a future
   timing-sensitive regression, run the script with ≥3 iterations per side
   as documented.

## I. Final release classification

**STAGING READY** — all identified code defects are corrected; all
available automated tests pass (unit 595/595, integration 63/63, frontend
53/53, TypeScript clean, prisma valid, migrations deployed, audit gates
PASS); security and packaging checks pass; backups and the release archive
are independently verified; no known critical defect remains; both external
provider sandbox checks are BLOCKED by unavailable credentials (clearly
identified in §F). NOT PRODUCTION CANDIDATE.
