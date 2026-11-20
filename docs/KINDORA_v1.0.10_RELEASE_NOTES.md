# KINDORA v1.0.10 — Release Notes

**Provider Reference Integrity, Reconciliation Lockdown & Payout Concurrency Fixes**
Classification: **STAGING READY** (external provider sandbox verification BLOCKED — no credentials; see §C/§F of the final engineering report).

v1.0.10 is a focused security-hardening release on the v1.0.9 payout architecture.
It closes the four findings of the v1.0.9 review. Nothing was redesigned; all
existing security controls (dual approval, four-person separation, MFA, approval
snapshots, the durable settlement guard, the outbox pipeline and the double-entry
ledger) are preserved.

## The four findings and their closure

### 1. Flutterwave false NOT_FOUND (P1)
`isAuthoritativeFlwReferenceNotFound()` accepted an empty `content` array as
authoritative evidence of absence without validating pagination metadata — the
contradictory response `{content:[], meta:{total:1}}` classified NOT_FOUND, which
could authorize a second transfer while the original existed.

**Correction:** the paginated shape now requires PRESENT and INTERNALLY
CONSISTENT pagination metadata for authoritative absence (required result count,
well-typed fields, no contradiction with the returned records, no truncation);
missing/malformed/contradictory metadata is AMBIGUOUS. The same consistency gate
runs before positive adoption. Unit matrix: 15+ pagination cases.

### 2. Exact provider reference identity (P1)
Lookup methods could report FOUND without proving the returned transfer carried
the requested merchant reference; a transfer id/code could silently substitute.

**Correction:** both adapters now verify EXACT reference identity on every
reference-based lookup — Paystack adopts only records whose own `data.reference`
equals the requested reference (id/code-only records are AMBIGUOUS); Flutterwave
verifies the list match through the detailed record (exact reference + same id)
and treats list/detail contradictions (including a NOT_FOUND detail behind an
existing list match) as AMBIGUOUS. Comparison is exact and case-sensitive; no
normalization. AMBIGUOUS lookups never trigger a submission; stable idempotency
keys and references are preserved.

### 3. Locked executor identity in final reconciliation (P1)
The locked payout-attempt query did not select `initiatedById`; the approval
validator received the PRE-TRANSACTION `attempt.initiatedById` — not
sufficiently strong for the final authorization decision.

**Correction:** the `SELECT ... FOR UPDATE` now explicitly selects `initiatedById`
(with `withdrawalId`, `provider`, `idempotencyKey` and the settlement fields); the
validator receives `locked.initiatedById`; a missing locked executor blocks
settlement; a locked row diverging from the pre-transaction read (withdrawalId /
idempotencyKey / provider / amount / currency) aborts reconciliation before any
write; all post-lock provider reads use the locked row; the settlement audit
event records the locked executor identity. Four-person separation is re-proven
inside the transaction.

### 4. Ineffective manual/API concurrency test (P1)
The v1.0.9 `§3.2/§12.5` test called `settleManual()` directly WITHOUT an
authorized manual settlement intent and had no controlled provider delay — it
proved only the rejection of an INVALID manual attempt.

**Correction:** the test was retired and replaced by SEVEN deterministic
scenarios (A–G) on REAL PostgreSQL 17 + Redis 7.2.5, using a controllable mock
provider with deferred-promise barriers (hold / signal / release, duplicate-
reference rejection, per-reference scoping) — every scenario asserts the final
withdrawal status, attempt status, lease/guard state, provider request count,
provider reference count, settlement records, exactly one ledger entry, the
amount in minor units and the audit trail. The coordination implementation itself
was audited (guard claims, in-lock rechecks, lease recovery, no transaction held
across the provider call) and stands unchanged.

## Files changed
- `backend/src/payouts/adapters/flutterwave-payout.adapter.ts` — pagination
  validation, exact-reference identity, contradiction handling.
- `backend/src/payouts/adapters/paystack-payout.adapter.ts` — exact-reference
  identity gate.
- `backend/src/payouts/adapters/mock-payout.adapter.ts` — deterministic
  concurrency control for the integration suite.
- `backend/src/payouts/payout-reconciliation.service.ts` — locked executor
  identity, locked-row tripwires, locked-provider reads, executor in audit
  metadata.
- `backend/src/payouts/adapters/payout-adapters-v110.spec.ts` — NEW §3.3/§4.4/§8/§9
  unit matrix.
- `backend/src/payouts/adapters/payout-lookup-classification.spec.ts` — corrected
  empty-paginated-list expectation (v1.0.10 contract) + new cases.
- `backend/src/payouts/payout-reconciliation-atomic.spec.ts` — locked-row shell
  + §5.6 executor matrix.
- `backend/test/payout-lockdown.e2e-spec.ts` — deterministic scenarios A–G +
  §5.6 integration proof; defective test retired.
- `frontend/tests/unit/withdrawal-form.test.ts` — stale pre-allowlist fixtures
  updated to the v1.0.8+ manual-channel allowlist contract (test-only; the
  production validator was already correct).
- `docs/*` — this release's documentation set.

## Migrations
None. The existing schema safely supports the corrected implementation
(§12: no migration merely because code changed). Fresh `prisma migrate deploy`
verified on PostgreSQL 17; `prisma migrate diff` reports NO drift between
`schema.prisma` and migrations 0001–0006.

## Documentation
- `docs/PAYOUT_ARCHITECTURE_V1.0.10.md` — exact-reference verification, pagination
  validation, authoritative NOT_FOUND, locked executor identity, coordination,
  the corrected concurrency proof, outcome model and financial guarantees.
- `docs/PROVIDER_INTEGRATION_V1.0.10.md` — Paystack + Flutterwave reference, test
  matrices, sandbox BLOCKED status.
- `docs/OUTBOX_RECOVERY_V1.0.10.md` — worker recovery guide (crash, lease expiry,
  ambiguous lookups, duplicate workers).
- `docs/MANUAL_SETTLEMENT_PROCEDURES_V1.0.10.md` — manual settlement guide with the
  v1.0.10 concurrency guarantees.
- `docs/KINDORA_v1.0.10_TEST_REPORT.md` — executed test report.
- `docs/FINAL_ENGINEERING_REPORT_V1.0.10.md` — vulnerability closure matrix,
  evidence, packaging figures (derived from the actual archive).
- `docs/SECURITY.md`, `docs/ENVIRONMENT_VARIABLES.md` — updated for v1.0.10.

## Verification summary
- Backend unit tests: **438 passed** (was 373 in v1.0.9).
- Backend integration tests (REAL PostgreSQL 17 + Redis 7.2.5): **63 passed**
  (was 56), including the seven deterministic payout-concurrency scenarios.
- Frontend regression tests: **53 passed**.
- TypeScript compilation (backend + frontend): pass.
- ESLint: 0 errors (pre-existing warnings only).
- Production builds (backend nest build + frontend vite build): pass.
- Prisma migrations (fresh deploy + schema diff): pass, no drift.
- Paystack / Flutterwave sandbox verification: **BLOCKED** (no credentials).
