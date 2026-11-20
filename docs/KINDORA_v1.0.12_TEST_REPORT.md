# KINDORA v1.0.12 — TEST REPORT

Scope: Flutterwave payout adapter — pagination contract completeness
(v1.0.12 §3), joint container validation (§4), S3 removal (§5).
Everything outside the Flutterwave payout adapter is regression-covered and
unchanged. All figures in this report are measured in this build
environment on the committed v1.0.12 tree.

---

## 1. Backend unit suite (jest, deterministic)

**Result: 24/24 suites, 568/568 tests PASSED, 0 failed, 0 skipped.**

Payout-adapter subset (5 suites, 241 tests):

| Suite | Tests | Result |
|---|---|---|
| `flutterwave-pagination-integrity-v112.spec.ts` (new) | 55 | 55 ✓ |
| `flutterwave-pagination-identity.spec.ts` (updated §9.4 → AMBIGUOUS) | 75 | 75 ✓ |
| `payout-adapters-v110.spec.ts` (updated to §3.2 precedence) | 58 | 58 ✓ |
| `payout-adapters.spec.ts` (Paystack/shared regression) | 16 | 16 ✓ |
| `payout-lookup-classification.spec.ts` (updated) | 37 | 37 ✓ |

The remaining 19 non-adapter suites (ledger, payments, auth, money, config,
sweeper, etc.) contribute 327 tests, all green — the v1.0.12 adapter change
regressed nothing outside its own contract surface.

### 1.1 New v1.0.12 coverage (55 tests, 8 describe suites)

* **§3 mandatory field sets (13)** — each mandated field (`total`,
  `current_page`, `total_pages`) omitted individually on S1 and S2 ⇒
  AMBIGUOUS; bare `total: 0` and `total: 3` (the §3.1 finding) ⇒ AMBIGUOUS,
  never NOT_FOUND; complete sets with and without `page_size` ⇒
  authoritative NOT_FOUND; positive S1 control (evidence
  `shape: 'PAGINATED_ARRAY'`); §3.2 precedence pinned at verdict-helper
  level (required-field gate fires before relationship validation).
* **§3.3/§3.4 one-based contract (3)** — `current_page: 0`, `-1`, `1.5`
  malformed (CONTRADICTORY) ⇒ AMBIGUOUS.
* **§4 joint containers (13)** — the §4.1 contradiction (outer `total: 1` +
  nested `total: 0`) ⇒ AMBIGUOUS with the disagreement in the reason;
  agreeing containers ⇒ NOT_FOUND; fields SPLIT across containers ⇒
  NOT_FOUND (additive half); empty nested `{}` container contributes
  nothing (both directions); `data.meta` null/`"string"` and
  `data.meta.pagination` null/`"string"`/array ⇒ MALFORMED, never
  outer-fallback (§4.5); three-container agreement ⇒ NOT_FOUND;
  three-container disagreement ⇒ AMBIGUOUS; positive adoption requires the
  FULL joint validation.
* **§4.7 cross-container matrix (8)** — contradiction either direction,
  per-field disagreements, alias-level disagreement (`total` vs
  `total_count`), primitive (number) container, required outer container
  absent, nested container NOT required (flat `data.meta` stays
  authoritative), three-container regression.
* **§8.1 combination matrix (6)** — paired absences, positive total with a
  missing context field, fractional `total_pages`, `current_page >
  total_pages`, and the documented zero-page empty convention
  (`total 0, current_page 1, total_pages 0`) staying CONSISTENT.
* **§9 recovery scenarios A–E (5)** — A: bare `total: 0` ⇒ AMBIGUOUS (no
  resubmission trigger); B: outer/nested contradiction ⇒ AMBIGUOUS;
  C: metadata-free array ⇒ AMBIGUOUS; D: valid identity ⇒ FOUND reconciles
  the ORIGINAL transfer; E: authoritative absence ⇒ NOT_FOUND (the only
  resubmission precondition). (F remains the real-PostgreSQL concurrency
  suite, §2 below.)
* **§5 S3 removal (7)** — empty metadata-free array ⇒ AMBIGUOUS (never
  NOT_FOUND); array carrying the exact matching transfer ⇒ AMBIGUOUS
  (never FOUND); non-empty array without the reference ⇒ AMBIGUOUS;
  unrecognized envelope meta never rescues the shape; detail-only id
  lookups keep their own documented rules; paginated S2 regression guards
  (NOT_FOUND and FOUND still authoritative under the tightened contract).

### 1.2 Legacy matrices corrected (fail-closed preserved)

* `flutterwave-pagination-identity.spec.ts` §9.4 — four legacy-array tests
  now assert AMBIGUOUS per §5 (previously NOT_FOUND / identity path).
* `payout-adapters-v110.spec.ts` — bare-array NOT_FOUND ⇒ AMBIGUOUS; bare
  `total` verdict ⇒ INCOMPLETE; the §3.2 precedence for
  `total: 0, current_page: 3` pinned (INCOMPLETE without `total_pages`,
  CONTRADICTORY with it).
* `payout-lookup-classification.spec.ts` — bare-array NOT_FOUND ⇒
  AMBIGUOUS.

## 2. Backend integration suite (REAL PostgreSQL 17.9 + Redis 7.2.5)

Environment: embedded PostgreSQL **17.9** (`pg_ctl (PostgreSQL) 17.9`,
`fsync=off` scratch cluster, fresh database per chunk) + Redis **7.2.5**
(source build, no persistence), migrations 0001–0006 deployed via
`prisma migrate deploy`, partial unique index `payout_attempt_one_unresolved_per_withdrawal`
verified present, seed applied (`SEED_ADMIN_PASSWORD` supplied). Harness
rebuilt after a sandbox recycle destroyed `/tmp/pgtest` and
`/tmp/redis-7.2.5` (identical builds reinstalled from the lockfile /
source release tarball).

**Result: 63/63 tests PASSED, 0 failed, 0 flakes.**

| Suite | Tests | Result |
|---|---|---|
| `auth.e2e-spec.ts` | 16 | 16 ✓ |
| `webhooks.e2e-spec.ts` | 4 | 4 ✓ |
| `storage.e2e-spec.ts` | 3 | 3 ✓ |
| `money-path.e2e-spec.ts` | 12 | 12 ✓ |
| `withdrawals.e2e-spec.ts` | 12 | 12 ✓ |
| `payout-lockdown.e2e-spec.ts` (chunked) | 16 | 16 ✓ |

Payout-lockdown detail (the v1.0.12-relevant suite; executed as four
name-chunked runs against fresh databases):

* Settlement protocol (§12.1 DTO rejection, §4.5 invalidated cycle, §5.1/§3.4
  two-step intent protocol, §3.1/§3.2 in-lock recheck + durable guard):
  4 ✓.
* REAL-PostgreSQL concurrency scenarios §6.3 (A) / §6.4 (B) / §6.5 (C):
  3 ✓ — exactly ONE payment path may win.
* REAL-PostgreSQL recovery scenarios §6.6 (D) / §6.7 (E) / §6.8 (F): 3 ✓ —
  recovery adopts the ORIGINAL transfer, never submits twice; ambiguous
  lookups preserve the reservation and keep manual settlement blocked.
* §6.9 (G) duplicate-worker claim, §10 reconciliation replay no-op,
  §5.6 executor-identity locking, §12.3 both lease-reclaim scenarios,
  §8.2 reversal lifecycle: 6 ✓.

**Zero flakes.** The single environment-timing flake v1.0.11 reported
(§3.1/§3.2 LOOKUP_PENDING vs ALREADY_SUBMITTED) did NOT occur in this
release's runs; the A/B baseline comparison harness
(`scripts/v112_baseline_ab_comparison.sh`) therefore did not need to be
exercised and no baseline comparison was performed.

## 3. Frontend

No frontend change in this release. Regression re-verified:
**vitest 53/53 green**; `tsc --noEmit` clean (TypeScript 5.9.3, exit 0).

## 4. Static checks

* Backend `npx tsc --noEmit`: clean (0 errors).
* `prisma generate`: clean.
* No new environment variables; no configuration changes.

## 5. Provider sandbox verification — **BLOCKED**

`FLUTTERWAVE_SECRET_KEY` and `PAYSTACK_SECRET_KEY` sandbox credentials are
not available in this build environment. No sandbox authentication,
transfer initiation, list-lookup, pagination or detail-verification test
was executed against the live providers. Nothing in this release claims
provider-side verification.

Risk posture of the change under BLOCKED sandbox verification: the
contract tightening is strictly MORE conservative — every response that
v1.0.12 classifies NOT_FOUND was already classified NOT_FOUND by v1.0.11;
the delta is exclusively responses moving from NOT_FOUND/FOUND into
AMBIGUOUS (manual review). The operational exposure is bounded to
additional manual reviews, never to automatic second transfers.

## 6. Summary

| Layer | Result |
|---|---|
| Backend unit (24 suites) | 568/568 ✓ |
| — payout adapter subset (5 suites) | 241/241 ✓ |
| Backend integration (real PG 17.9 + Redis 7.2.5) | 63/63 ✓ |
| Frontend vitest | 53/53 ✓ |
| TypeScript (backend + frontend) | clean ✓ |
| Provider sandbox | **BLOCKED** (no credentials) |
