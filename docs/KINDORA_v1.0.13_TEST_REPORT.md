# KINDORA v1.0.13 — TEST REPORT

Scope: (1) the strict envelope-metadata null-handling correction in
`extractFlwEnvelopeMeta()` (v1.0.13 §4); (2) full regression of every
payout-security protection; (3) the completed release-verification tooling.
All figures below were ACTUALLY EXECUTED in this build environment against
the v1.0.13 tree. Nothing is carried over from earlier reports without
re-execution. Environment: Linux sandbox, Node 24, npm ci from the
committed lockfiles; integration runs on embedded PostgreSQL **17.9**
(`pg_ctl (PostgreSQL) 17.9`, fresh database per chunk, `fsync=off` scratch
cluster) + Redis **7.2.5** (built from the official source tarball,
no persistence). The harness was rebuilt from scratch in this session.

---

## 1. Adapter unit tests (jest, deterministic, fetch mocked at the boundary)

### 1.1 New v1.0.13 suite — `flutterwave-envelope-null-v113.spec.ts`

**Result: 27/27 PASSED.**

Coverage mapped to the release prompt §4.3 requirements:

| # | Requirement | Tests |
|---|---|---|
| 1 | Absent envelope `meta` → ABSENT (S1 array falls to the §5 bare-array rule, NOT an envelope defect) | 1 |
| 2 | Explicit null envelope `meta` → MALFORMED, never ABSENT (S1 array; reason carries "envelope meta is null") | 1 |
| 3 | Valid `meta.page_info` accepted only after ALL pagination checks: complete+consistent ⇒ NOT_FOUND; incomplete field set ⇒ AMBIGUOUS (INCOMPLETE); full identity chain ⇒ FOUND | 3 |
| 4 | Null `page_info` → MALFORMED (S1 array; and on S2 with otherwise valid nested metadata) | 2 |
| 5 | Primitive `page_info` (number/string/boolean) → MALFORMED | 3 |
| 6 | Array `page_info` → MALFORMED | 1 |
| 7 | Unrecognized envelope structure cannot authorize NOT_FOUND (S1 array; and overriding valid nested metadata on S2) | 2 |
| 8 | THE §4.3 FIXTURE: `meta: null` + complete valid nested `data.meta` → AMBIGUOUS, never NOT_FOUND/FOUND; plus the S1 array carrying the exact match with `meta: null` → AMBIGUOUS, never FOUND | 2 |
| 9 | Container-arrangement independence: null envelope + flat valid `data.meta` ≡ null envelope + nested `data.meta.pagination` (both AMBIGUOUS, same reason); control: valid envelope + same nested split ⇒ NOT_FOUND | 2 |
| 10 | No malformed envelope upgrades a lookup: 9 malformed envelope variants × otherwise-authoritative empty page ⇒ all AMBIGUOUS (never NOT_FOUND); 5 malformed variants × page carrying the exact match ⇒ all AMBIGUOUS (never FOUND) | 9 + 1 |

Total: 27 executed tests. The §4.3 fixture is executed VERBATIM as
specified in the release prompt (envelope `meta: null`, nested
`data.meta {total: 0, current_page: 1, total_pages: 1}`, empty content —
asserted AMBIGUOUS with the malformed-envelope reason).

### 1.2 Full backend unit suite

**Result: 25/25 suites, 595/595 PASSED, 0 failed, 0 skipped** (the 27 new
tests included). Payout-adapter subset: 6 suites, 268/268:

| Suite | Tests | Result |
|---|---|---|
| `flutterwave-envelope-null-v113.spec.ts` (new) | 27 | 27 ✓ |
| `flutterwave-pagination-integrity-v112.spec.ts` | 55 | 55 ✓ |
| `flutterwave-pagination-identity.spec.ts` | 75 | 75 ✓ |
| `payout-adapters-v110.spec.ts` | 58 | 58 ✓ |
| `payout-adapters.spec.ts` | 16 | 16 ✓ |
| `payout-lookup-classification.spec.ts` | 37 | 37 ✓ |

Prompt §10.1 matrix coverage (executed across these suites — the items not
in the new v113 suite are covered by the retained v1.0.11/v1.0.12
matrices, re-executed in this run): envelope absent/null/primitive/array,
missing/null/primitive/array `page_info`, valid outer+nested metadata,
conflicting outer/nested metadata (§4.7 matrix), missing mandatory fields
(§3 suites), conflicting aliases (identity §/v110 suites), fractional
values, numeric strings, unsafe integers, invalid page relationships,
empty result sets with complete AND incomplete pagination evidence,
metadata-free arrays (S3 removal matrix), unknown response structures,
provider errors, malformed JSON (`rawText` fixtures), exact-reference
mismatch, transfer-id mismatch, missing transfer id, amount/currency/
beneficiary mismatch, incomplete detail lookup.

## 2. Backend integration tests (real PostgreSQL 17.9 + Redis 7.2.5)

Command: `scripts/v112_e2e_chunk.sh <suite>` per chunk (fresh database per
chunk, migrations 0001–0006 via `prisma migrate deploy`, guard partial
unique index verified present, seeded); jest `--runInBand`, complete logs
preserved under `/tmp/migrate-*.log`, `/tmp/seed-*.log` and the jest
outputs. **Result: 63/63 PASSED, 0 failed, 0 flakes.**

| Suite | Tests | Result |
|---|---|---|
| `auth.e2e-spec.ts` | 16 | 16 ✓ |
| `webhooks.e2e-spec.ts` | 4 | 4 ✓ |
| `storage.e2e-spec.ts` | 3 | 3 ✓ |
| `money-path.e2e-spec.ts` | 12 | 12 ✓ |
| `withdrawals.e2e-spec.ts` | 12 | 12 ✓ |
| `payout-lockdown.e2e-spec.ts` (4 name-chunks) | 16 | 16 ✓ |

Payout-lockdown (the §7-relevant suite — mutual exclusion, snapshots,
durable guard, recovery):

* Settlement protocol: §12.1 DTO rejection, §4.5 invalidated cycle,
  §5.1/§3.4 two-step intent protocol, §3.1/§3.2 in-lock recheck + durable
  guard — 4 ✓.
* REAL-PostgreSQL concurrency scenarios (§10.2's genuine in-flight
  requirement — each scenario holds one operation in flight via
  deterministic synchronization barriers while the competitor proceeds):
  §6.3 (A) intent-vs-provider race, §6.4 (B) provider-in-flight exclusion,
  §6.5 (C) manual-first exclusion — 3 ✓.
* REAL-PostgreSQL recovery scenarios: §6.6 (D) crash-after-accept adopts
  the ORIGINAL transfer (never submits twice), §6.7 (E) ambiguous lookups
  preserve the reservation and keep manual settlement blocked, §6.8 (F)
  lease expiry reconciles the existing transfer — 3 ✓.
* §6.9 (G) duplicate-worker single claim; §10 reconciliation replay no-op;
  §5.6 executor-identity locking; §12.3 both lease-reclaim scenarios; §8.2
  reversal lifecycle — 6 ✓.

The null-envelope fix creates no bypass in any of these workflows: the
scenarios exercise AMBIGUOUS handling end-to-end on real PostgreSQL (§6.7),
and all four-person-separation/MFA/snapshot assertions passed unchanged.

## 3. Frontend (no change in this release)

`npx vitest run`: **5 files, 53/53 PASSED**. `npx tsc --noEmit`: exit 0.

## 4. Static checks and gates

| Check | Command | Result |
|---|---|---|
| Backend TypeScript | `npx tsc --noEmit` | clean (0 errors) |
| Frontend TypeScript | `npx tsc --noEmit` | exit 0 |
| Prisma schema validation | `DATABASE_URL=… npx prisma validate` | "The schema at prisma/schema.prisma is valid" |
| Migration verification | `prisma migrate deploy` (per e2e chunk) + verifier migration count | 0001–0006 deployed cleanly; 6 migrations present |
| Audit gates | `node scripts/audit-gate.mjs backend\|frontend\|workers` | 3× PASS (only the DOCUMENTED-ACCEPTED prisma build-tooling advisory noted) |

## 5. Release verification (the completed §8 tooling)

* `scripts/v113_phase0_backup.sh` — executed (twice; byte-identical
  deterministic output): baseline record + `KINDORA_v1.0.12_BASELINE_BACKUP.tar.gz`
  (430 files), manifest 430 entries, independent extraction, EVERY entry
  verified, 0 failures, 6 migrations, structural probe green.
* `scripts/v113_final_backup.sh` — executed after the source freeze:
  required-file probe (19 files), deterministic archive, manifest over
  every file, independent extraction + EVERY-entry verification, 0
  failures (figures in the attestation record).
* `scripts/verify_release_zip_v113.sh` — executed against the final ZIP:
  results recorded in the attestation (§ post-packaging record).
* `scripts/v113_baseline_ab_comparison.sh` — exercised once (1 iteration
  per side) with the historically timing-sensitive payout-lockdown §3.1/§3.2
  scenario against the pristine v1.0.12 baseline backup: NO new regression
  (the scenario passes on BOTH sides under identical infrastructure);
  complete logs preserved under `release-verification-logs/`.

## 6. Provider sandbox verification — **BLOCKED**

`FLUTTERWAVE_SECRET_KEY` and `PAYSTACK_SECRET_KEY` are not available in
this build environment. NO live-provider test was executed or claimed: the
Flutterwave workflow (authentication, transfer initiation, duplicate
reference behaviour, paginated lookup, sandbox empty/incomplete/
contradictory pagination, null envelope metadata, detail verification,
recovery) and the Paystack regression set are BLOCKED in full. All
HTTP-boundary behaviour was verified through mocked-boundary tests
(§1) and real-database integration tests (§2) instead. The release is
therefore classified **STAGING READY** (the maximum honest classification
under §16 of the release prompt), never PRODUCTION CANDIDATE.

## 7. Summary

| Layer | Suites | Passed | Failed | Skipped |
|---|---|---|---|---|
| Backend unit (jest) | 25 | 595 | 0 | 0 |
| — payout adapter subset | 6 | 268 | 0 | 0 |
| Backend integration (real PG 17.9 + Redis 7.2.5) | 6 | 63 | 0 | 0 |
| Frontend vitest | 5 | 53 | 0 | 0 |
| TypeScript backend + frontend | — | clean | — | — |
| Prisma validate / migrations / audit gates | — | PASS | 0 | 0 |
| Provider sandbox (Flutterwave + Paystack) | — | **BLOCKED** | — | — |
