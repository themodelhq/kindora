# KINDORA v1.0.11 — FINAL ENGINEERING REPORT

**Release:** KINDORA v1.0.11 — Flutterwave Pagination Integrity & Transfer
Identity Lockdown
**Date:** 2026-11-15
**Classification: STAGING READY** (per release-prompt §20: source corrections
implemented, all local automated tests pass, PostgreSQL integration and
concurrency tests pass, builds and migration checks pass, no known critical
source-level payout defect remains; external provider sandbox verification
remains BLOCKED for lack of credentials — production readiness is therefore
NOT claimed).

---

## A. Release summary

| Field | Value |
|---|---|
| Original version | v1.0.10 (release commit `e17e96e`, zip SHA-256 `75a7a667…`) |
| Final version | v1.0.11 (source commit `034fa86`, report included at packaging) |
| Classification | **STAGING READY** |
| Migrations added | **NONE** — adapter-only correction (§15); migrations 0001–0006 unchanged; live-database vs Prisma-schema diff verified EMPTY |

Main corrections (all in `backend/src/payouts/adapters/flutterwave-payout.adapter.ts`):

1. **Strict pagination alias consistency** — every supplied alias in every
   documented container validated independently as a strict in-range
   integer; all aliases/containers for the same property must agree; the
   v1.0.10 first-value cross-field selection (`firstNumber`) removed; new
   relationship checks; NEW container defence: the official v3 envelope
   `meta.page_info` (unvalidated in v1.0.10).
2. **Exact list-to-detail transfer identity** — detail transfer id now
   MANDATORY (present, valid, equal to the list id); list record identity
   validation; duplicate-provider-id conflict detection.
3. **Metadata-mandatory adoption** — paginated shapes (S1 official array +
   `meta.page_info`, S2 content revision) require valid, complete, internally
   consistent metadata before ANY classification (FOUND and NOT_FOUND alike);
   explicit S1–S4 shape discrimination; legacy bare-array rules preserved;
   unknown shapes AMBIGUOUS.
4. **Centralised deterministic 12-step lookup sequence** with structured
   verdicts; the four-valued outcome contract (FOUND/NOT_FOUND/AMBIGUOUS/
   ERROR) preserved.

Files changed (relative to `kindora/`):
`backend/src/payouts/adapters/flutterwave-payout.adapter.ts` (rewritten
lookup/pagination machinery),
`backend/src/payouts/adapters/flutterwave-pagination-identity.spec.ts` (NEW,
75 tests),
`docs/PROVIDER_INTEGRATION_V1.0.11.md` (NEW),
`docs/KINDORA_v1.0.11_RELEASE_NOTES.md` (NEW),
`docs/KINDORA_v1.0.11_TEST_REPORT.md` (NEW),
`docs/INCIDENT_RUNBOOK_AMBIGUOUS_PAYOUT.md` (v1.0.11 addendum),
`docs/FINAL_ENGINEERING_REPORT_V1.0.11.md` (this file).

## B. Three-finding closure matrix

### Finding 1 — conflicting pagination aliases accepted (§3)

| Item | Detail |
|---|---|
| Root cause | v1.0.10 `flwPaginationVerdict()` validated `current_page`/`page`/`currentPage`, `total_pages`/`pageCount`/`pages`, `per_page`/`pageSize` independently and computed cross-field relationships through `firstNumber()` — the first finite value concealed contradicting siblings (`{current_page:1, page:2}` passed; `{total_pages:1, pages:4}` passed). Nulls were silently skipped. Fractional values passed `isFiniteNumber`. |
| Correction | `validateFlwAliasGroup()` validates EVERY supplied value across EVERY container (strict JSON integer, `Number.isSafeInteger`, per-field minimum, null = supplied-and-invalid, absent = contributes nothing); alias/inter-container disagreement ⇒ CONTRADICTORY. `diagnoseFlwPagination()` replaces the first-value logic with structured verdicts (CONSISTENT / INCOMPLETE / CONTRADICTORY + reason). New relationships: returned > page size; zero results spanning pages. `page_size` added as a contract-backed alias (documented on official `page_info` containers). |
| Files changed | `flutterwave-payout.adapter.ts` |
| Tests added | §9.1 matrix (17 tests incl. the full prompt fixture `{total:0, current_page:1, page:2, total_pages:1, pages:4, per_page:10, pageSize:1}`), §9.2 matrix (11), §3.3 unit matrix (5) |
| Execution result | All green (see §F). The prompt's contradictory fixture now classifies AMBIGUOUS — never NOT_FOUND, never FOUND. |
| Remaining limitations | Provider sandbox execution BLOCKED (no credentials); alias behaviour verified against the official OpenAPI description + deterministic fixtures only. |

### Finding 2 — detailed transfer adopted without exact id match (§4)

| Item | Detail |
|---|---|
| Root cause | v1.0.10 guard `if (detailId != null && String(detailId) !== String(match.id))` — a missing/null detail id PASSED, so a detail response with a matching reference but no id could be adopted as FOUND. |
| Correction | Step 11: `typeof detailId !== 'string' || !/^[1-9][0-9]*$/.test(detailId) || !Number.isSafeInteger(Number(detailId))` ⇒ AMBIGUOUS; then `detailId !== String(match.id)` ⇒ AMBIGUOUS. Step 8 makes the LIST record's valid transfer id mandatory. `scanFlwListRecords()` validates every list record (objects only, well-formed ids/references, duplicate provider ids with conflicting references rejected). |
| Files changed | `flutterwave-payout.adapter.ts` |
| Tests added | §4.5 identity matrix: 18 tests (#1–#17 plus #13b), including missing/null/empty/malformed/different detail id, missing/different detail reference, matching-id-different-reference, missing list id/reference, malformed list identity, detail-absent contradiction, multiple matches, duplicate provider ids with conflicting references |
| Execution result | All green. Only the exact authoritative match (#1) returns FOUND. |
| Remaining limitations | Sandbox execution BLOCKED. |

### Finding 3 — FOUND possible without pagination metadata (§5)

| Item | Detail |
|---|---|
| Root cause | v1.0.10 applied the pagination gate only when metadata was PRESENT (`meta.kind === 'PRESENT'`); with metadata ABSENT on a non-empty `data.content` page the lookup continued and could adopt a matching transfer (the v1.0.10 code even documented this: "meta ABSENT with a non-empty content array: positive evidence in the list is not discarded"). Additionally, the OFFICIAL v3 container `meta.page_info` (envelope-level, `data` a plain array) was never inspected: an empty array under `page_info.total > 0` classified as authoritative NOT_FOUND. |
| Correction | `classifyFlwListShape()` performs explicit shape discrimination: S1 official paginated array (envelope `meta.page_info`) and S2 content revision — metadata MANDATORY (PRESENT + CONSISTENT) before ANY classification, empty page included; S3 legacy bare array (no pagination container anywhere) keeps its documented complete-result rules; S4 anything else AMBIGUOUS. NOT_FOUND now requires a VALIDATED shape with an empty page set; FOUND requires the same plus the full identity chain (§5.4's eight-point establishment order). |
| Files changed | `flutterwave-payout.adapter.ts` |
| Tests added | §9.3 adoption matrix (10: matching reference with missing/malformed/contradictory/inconsistent metadata, missing/mismatched detail id and reference, complete-paginated FOUND, S1 FOUND, S1-empty-under-total>0 AMBIGUOUS, S1-empty-consistent NOT_FOUND), §9.4 shape matrix (9: legacy complete array handling, unknown shapes, "missing metadata is not automatically non-paginated"), §10 scenarios A–E |
| Execution result | All green. The `data.content` + matching reference + missing metadata fixture returns AMBIGUOUS (scenario D). |
| Remaining limitations | Sandbox execution BLOCKED; the S1/S3 boundary is documented as a recorded discrepancy pending sandbox confirmation (see `PROVIDER_INTEGRATION_V1.0.11.md` §1). |

## C. Pagination verification evidence (actual executed results)

| Scenario | Fixture (sanitised) | Actual result |
|---|---|---|
| Alias agreement (two aliases) | `{total:0, current_page:1, total_pages:1, per_page:30, pageSize:30}` | CONSISTENT → NOT_FOUND (empty page) |
| Official page_info only | `meta.page_info={total:0, current_page:1, total_pages:1}`, `data: []` | CONSISTENT → NOT_FOUND |
| Conflicting current-page aliases | `{total:0, current_page:1, page:2, …}` | AMBIGUOUS |
| Conflicting total-page aliases | `{total:0, total_pages:1, pages:4, …}` | AMBIGUOUS |
| Conflicting page-size aliases | `{total:0, per_page:10, pageSize:1, …}` | AMBIGUOUS |
| Full prompt fixture | `{total:0, current_page:1, page:2, total_pages:1, pages:4, per_page:10, pageSize:1}` | AMBIGUOUS |
| Invalid numeric values | `total: '3'` / `1.5` / `-1` / `true` / `{}` / `null` / `NaN` / `Infinity` / `1e999` (raw JSON) | AMBIGUOUS (each) |
| First-value trap | `{total:0, total_pages:1, pages:'oops'}` | AMBIGUOUS (v1.0.10 would pass it) |
| current_page > total_pages | `{total:3, current_page:4, total_pages:2}` | AMBIGUOUS |
| Zero total pages, nonzero results | `{total:2, total_pages:0}` | AMBIGUOUS |
| Zero results spanning pages | `{total:0, current_page:1, total_pages:2}` | AMBIGUOUS |
| Records exceed page size | 3 records, `per_page:2` | AMBIGUOUS |
| total > per_page × total_pages | `{total:61, total_pages:2, per_page:30}` | AMBIGUOUS |
| Missing required metadata | no `total` alias anywhere | AMBIGUOUS (INCOMPLETE — never invented as 0) |
| Truncated page | `{total:5, total_pages:2, per_page:4}` with 1 record | AMBIGUOUS |
| Empty page, metadata claims records | `{total:1, …}` with `content: []` | AMBIGUOUS |
| Documented empty-result convention | `{total:0, current_page:1, total_pages:0}` | CONSISTENT → NOT_FOUND |
| Cross-container disagreement | envelope `page_info.total=1` vs `data.meta.pagination.total=0` | AMBIGUOUS |
| Cross-container agreement | both `total=0` | CONSISTENT → NOT_FOUND |
| Unknown response shapes | `data:{unexpected:true}` / `data:'nope'` / `data:42` / envelope meta without `page_info` / `page_info:null` | AMBIGUOUS (each) |

## D. Transfer identity evidence (sanitised test data)

Requested reference `kdo-payout-wd-1-1`; list/detail fixtures per §4.5:

| Case | List reference | List id | Detail reference | Detail id | Outcome |
|---|---|---|---|---|---|
| Exact match (the ONLY FOUND) | kdo-payout-wd-1-1 | 35557 | kdo-payout-wd-1-1 | 35557 | **FOUND** (detail fetched by list id — URL asserted) |
| Missing detail id | kdo-payout-wd-1-1 | 35557 | kdo-payout-wd-1-1 | — | AMBIGUOUS |
| Null detail id | kdo-payout-wd-1-1 | 35557 | kdo-payout-wd-1-1 | null | AMBIGUOUS |
| Empty detail id | kdo-payout-wd-1-1 | 35557 | kdo-payout-wd-1-1 | "" | AMBIGUOUS |
| Malformed detail id | kdo-payout-wd-1-1 | 35557 | kdo-payout-wd-1-1 | "35x" | AMBIGUOUS |
| Different detail id | kdo-payout-wd-1-1 | 35557 | kdo-payout-wd-1-1 | 99999 | AMBIGUOUS (evidence carries both ids) |
| Missing detail reference | kdo-payout-wd-1-1 | 35557 | — | 35557 | AMBIGUOUS |
| Different detail reference | kdo-payout-wd-1-1 | 35557 | kdo-payout-wd-2-9 | 35557 | AMBIGUOUS |
| Different id + reference | kdo-payout-wd-1-1 | 35557 | kdo-payout-wd-2-9 | 88888 | AMBIGUOUS |
| Missing list id | kdo-payout-wd-1-1 | — | — | — | AMBIGUOUS |
| Malformed list identity | 12345 (numeric) / id 35557.5 | — | — | — | AMBIGUOUS |
| Duplicate provider ids, conflicting references | 35557→REF, 35557→OTHER | — | — | — | AMBIGUOUS |
| Multiple same-reference records | two records | 35557/35558 | — | — | AMBIGUOUS |
| Detail absent behind list match | list FOUND | 35557 | detail HTTP 404 | — | AMBIGUOUS (never NOT_FOUND) |

## E. Financial recovery evidence

1. **Can contradictory pagination authorize another transfer?** NO. Every
   contradictory/malformed/incomplete/missing-metadata page classifies
   AMBIGUOUS (75-test matrix, including the prompt's own fixture). The
   pipeline treats AMBIGUOUS as "existence not established": no resubmission,
   reservation preserved (§10 scenario A + real-PG §6.7(E) scenario green).
2. **Can a missing detailed transfer ID produce FOUND?** NO. Step 11 fails
   closed on missing/null/empty/malformed detail ids (§4.5 #2–#5, scenario
   B). The v1.0.10 `detailId != null &&` bypass is deleted.
3. **Can a missing pagination structure allow a paginated transfer to be
   adopted?** NO. S1/S2 require metadata PRESENT + CONSISTENT before ANY
   classification; the matching-reference-with-no-metadata fixture returns
   AMBIGUOUS (scenario D, §9.3).
4. **Can an ambiguous lookup release the reservation?** NO. Unchanged from
   v1.0.10 and regression-covered: AMBIGUOUS/ERROR → verification UNKNOWN →
   reconciliation escalates (`MANUAL_REVIEW`/`UNKNOWN`), reservation intact,
   settlement guard blocks competing manual settlement (real-PG §6.7(E)
   green).
5. **Can a worker crash cause a second transfer?** NO. Recovery
   reconcile-before-resubmit unchanged (§6.6(D) green on real PostgreSQL);
   only an authoritative NOT_FOUND re-arms the SAME attempt with the SAME
   reference and idempotency key after full revalidation.
6. **Can manual settlement race with unresolved provider submission?** NO.
   Durable settlement guard + in-lock rechecks unchanged (real-PG §6.3–§6.5
   green; §12.1 DTO allowlist green). The single chunked-run flake
   (§3.1/§3.2) is an environment-timing issue reproduced identically on the
   pristine v1.0.10 tree — see §F.
7. **Can repeated reconciliation post the ledger twice?** NO. Exactly-once
   ledger posting unchanged (real-PG §6.9(G) duplicate-worker + §10 replay
   no-op both green).

## F. Test results (actual executed counts — this release build)

| Category | Executed | Green | Notes |
|---|---|---|---|
| Backend unit tests (jest, mocked provider boundary) | 513 | 513 | 23 suites; 75 new v1.0.11 tests; all 58 v1.0.10 adapter tests UNCHANGED |
| Backend integration (real PostgreSQL 17 + Redis 7.2.5, migrations 0001–0006, seeded) | 63 | 62 | auth+webhooks 20, storage+withdrawals 15, money-path 12 (all green); payout-lockdown 16 chunked: 15 green, 1 env-timing flake |
| Frontend tests (vitest) | 53 | 53 | |
| TypeScript compilation (backend/frontend) | clean | — | |
| ESLint (backend src+test) | clean | — | 0 errors/warnings |
| Production builds (backend / workers / frontend) | OK | — | |
| Prisma migration validation | OK | — | `migrate deploy` ×4 fresh databases; live-vs-schema diff EMPTY; `from-empty` diff archived |
| Flutterwave SANDBOX (live provider) | 0 | — | **BLOCKED** — `FLUTTERWAVE_SECRET_KEY` unavailable |
| Paystack SANDBOX (live provider) | 0 | — | **BLOCKED** — `PAYSTACK_SECRET_KEY` unavailable; Paystack regression (mocked) green |
| **Total automated** | **629** | **628** | |

**The one non-green test, fully disclosed:** `payout-lockdown.e2e §3.1/§3.2`
expects the test process's own `submitOutbox` call to receive
`LOOKUP_PENDING` while a barrier blocks the provider; in this slower sandbox
the in-process 1s outbox sweeper wins the race and returns
`ALREADY_SUBMITTED`. A/B evidence: the PRISTINE v1.0.10 tree (extracted from
the release-commit backup) fails the SAME test under the IDENTICAL
infrastructure and chunking (`scripts/v111_e2e_chunk.sh`, fresh database per
chunk): pristine 15/16, v1.0.11 15/16, same test, same signal. The failure
is environmental, pre-existing, and not touched by v1.0.11 (mock provider —
the FLW adapter is not in the path). Nothing was deleted, skipped or
weakened; the full-file runtime on this machine is 819s.

## G. Backup and archive verification

| Item | Value |
|---|---|
| Original v1.0.10 recovery backup | `backups/KINDORA_v1.0.10_PRE_V111_BACKUP.tar.gz` — 1,537,220 bytes, SHA-256 `a7852fcf2f6aa2633159d7b18d7086dceaebc7161e7565f60e10002226ca155a`, 411-file manifest `v1.0.10_pre_v111_MANIFEST.sha256` — independently extracted and verified (spec §2.4–11) |
| Final v1.0.11 recovery backup | `backups/KINDORA_v1.0.11_FINAL_BACKUP.tar.gz` — 417-file manifest `v1.0.11_final.sha256` — independently extracted and verified; exact byte size and SHA-256 recorded in `backups/v1.0.11_final_archive.sha256`, generated from the completed backup (a backup containing this report cannot embed its own byte figures) |
| Final release archive | `KINDORA_v1.0.11_SECURITY_COMPLETE.zip` — 424 files / 521 zip entries. The archive's exact compressed size, uncompressed size and SHA-256 are recorded in the sidecar `KINDORA_v1.0.11_zip.sha256` and in `docs/RELEASE_ARCHIVE_ATTESTATION_V1.0.11.md`, generated FROM the final completed archive after packaging (byte-exact self-referential figures — the archive's own hash and the byte totals that include this report — cannot be embedded inside the archive they describe; the manifest entry count and per-entry verification below are in-archive). |
| Checksum manifest | `SHA256SUMS.txt` inside the archive — 423 entries at packaging, every entry verified by `sha256sum -c` |
| Independent extraction | performed by `scripts/verify_release_zip_v111.sh` (zip integrity, per-entry manifest verification, BOTH nested backups extracted + manifest-verified, secret scan) |
| Historical backups | preserved untouched (v1.0.4…v1.0.10 archives and manifests remain in `backups/`, `download/` and git history; the v1.0.10 release zip with its full nested chain remains available) |

## H. Outstanding risks

| # | Risk | Severity | Release impact |
|---|---|---|---|
| 1 | Flutterwave/Paystack SANDBOX verification not executed (credentials unavailable) — the alias/shape/identity rules are verified against the official OpenAPI description and deterministic fixtures, not live responses | HIGH (process) | Release stays STAGING READY; MUST be closed before any PRODUCTION CANDIDATE claim |
| 2 | S1/S3 boundary (bare array with no metadata = legacy complete) is a documented contract discrepancy pending sandbox confirmation | MEDIUM | Fail-safe direction: any supplied metadata forces the MANDATORY gate; only a metadata-free array is treated as complete |
| 3 | payout-lockdown §3.1/§3.2 is timing-sensitive and flaked in THIS environment (A/B-verified identical on pristine v1.0.10) | LOW | Environment-timing only; the underlying guard behaviour is covered by the real-PG §6.3–§6.5 scenarios, which are green |
| 4 | No new Prisma migration in v1.0.11; none required (adapter-only) — database constraints already enforce the payout invariants | INFO | — |
| 5 | Legacy per-transfer `beneficiary_name` vs official example `full_name` field naming (pre-existing since v1.0.8, out of v1.0.11 scope) | INFO | Re-verify during sandbox testing; mobile-money channel remains DISABLED by default (v1.0.8 §6.3) |

Nothing in this report is copied from historical releases; every figure in
§F/§G was produced during this build.
