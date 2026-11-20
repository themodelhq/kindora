# KINDORA v1.0.7 TEST REPORT

**Release:** KINDORA v1.0.7_SECURITY_COMPLETE — Payout Execution Integrity
**Baseline:** KINDORA v1.0.6
**Environment:** offline release sandbox (Linux, Node 24). During the final verification
pass of this release the sandbox gained **userspace PostgreSQL 18** (embedded binaries) and
**Redis 7.2.5** (compiled from source), which unblocked the previously BLOCKED database and
integration verifications. Provider credentials (Paystack / Flutterwave / Stripe / PayPal)
and S3-compatible storage remain unavailable.

Honesty rule: this report distinguishes **EXECUTED** (actually ran in this sandbox) from
**NOT RUN / BLOCKED** (requires infrastructure or credentials that do not exist here). No
result is claimed for anything in the second category. No provider sandbox responses,
transfer IDs or references appear in this report because none were observed.

Related: [KINDORA_v1.0.7_RELEASE_NOTES.md](KINDORA_v1.0.7_RELEASE_NOTES.md) |
[PAYOUT_ARCHITECTURE_V1.0.7.md](PAYOUT_ARCHITECTURE_V1.0.7.md) |
[PROVIDER_INTEGRATION_V1.0.7.md](PROVIDER_INTEGRATION_V1.0.7.md)

---

## 1. Executed verification (this release)

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| 1 | Backend unit tests (`jest`, mocked Prisma/providers) | **PASS — 255 tests, 0 failures, 16 suites** | All 16 suite files listed in Section 3. Re-run clean after every fix below. |
| 2 | Frontend unit tests (`vitest`) | **PASS — 52 tests** | `frontend/tests/unit/` (5 files: money, utils, auth store, withdrawal form, demo adapter). |
| 3 | Backend typecheck (`tsc --noEmit`) | PASS | Exit 0. |
| 4 | Backend production build (`nest build`) | PASS | `dist/` produced. |
| 5 | Workers typecheck + build (`tsc --noEmit`, `npm run build`) | PASS | Includes the payouts processor + payout-recovery cron. |
| 6 | Frontend typecheck (`tsc -b`) + production build (`vite build`) | PASS | PWA bundle produced (fixed: `@types/node` was missing for `vite.config.ts`). |
| 7 | **Migration 0004 on a real PostgreSQL 18 instance — 34/34 checks PASS** | **EXECUTED (was NOT RUN at code-freeze)** | Fresh path (0001→0004) AND upgrade path (0001→0003 with v1.0.6-era legacy data → 0004): all six new tables, enum extensions, unique constraints, immutability triggers verified; legacy rows survive with `destinationVersion=1`; no data loss. See Section 4. |
| 8 | **`prisma migrate diff` (migrations vs schema)** | **PASS — "No difference detected"** | The applied migration chain produces EXACTLY `schema.prisma` (definitive structural check, run against the real shadow database). |
| 9 | **Backend integration suite on real PostgreSQL 18 + Redis 7.2.5** | **EXECUTED (was NOT RUN at code-freeze) — 47/47 PASS, 5/5 suites** | auth, webhooks, storage, money-path, withdrawals — with `RUN_INTEGRATION=1`, `PROVIDER_MODE=mock`, real dual-approval + fresh-MFA flows through real Redis. Found and fixed three real defects (Section 5). |

Not claimed (not executed here): Playwright e2e against a running frontend, image-processing
pipeline, multi-instance outbox concurrency on deployed infrastructure. They may run in CI;
no result is asserted in this report.

## 2. The five payout suites introduced/extended by v1.0.7

### 2.1 `payout-state-machine.spec.ts` (29 tests)

- Canonical withdrawal graph: every documented edge permitted; every other edge rejected;
  terminal states closed; no self-transition; the enum set is fully covered.
- `PROCESSING -> FAILED` is only reachable through authoritative verification — an admin
  force-fail of an ambiguous transfer is impossible.
- Provider status classification tables for Paystack and Flutterwave; unrecognized statuses
  and unknown provider names classify UNKNOWN — never FAILED.
- Fail-closed reconciliation model: provider success with complete evidence finalizes;
  missing amount / currency / beneficiary identity => `PROVIDER_DATA_INCOMPLETE`; amount,
  currency, beneficiary mismatches escalate; case-insensitive currency without conversion;
  `REFERENCE_MISMATCH`; `DUPLICATE_REFERENCE`; `PROVIDER_REVERSED` recorded separately; no
  verification => `PROVIDER_UNKNOWN` / `REQUIRES_MANUAL_INVESTIGATION`; missing evidence on
  a terminal FAILURE does not block the failure.
- Attempt state machine: `INITIATED` never jumps to `SUCCESSFUL`; `SUBMISSION_PENDING` has
  no edge back to `INITIATED` (no blind resubmission); terminal attempt states closed except
  `SUCCESSFUL -> REVERSED`; the six unresolved statuses block new transfers.

### 2.2 `payout-initiation.service.spec.ts` (14 tests)

- Executor separation BEFORE any provider call: requester, first approver and second
  approver each rejected as executor; identical first/second approver rejected;
  non-APPROVED withdrawal cannot initiate.
- Provider gating: STRIPE payout rejected with the honest disable reason (never routed to
  another provider); a misconfigured provider aborts before any intent is committed.
- Durable intent + outbox: attempt + outbox committed atomically with the submission
  dispatched after commit; an unresolved attempt blocks a second intent; a concurrent state
  change between read and commit aborts initiation without submitting anything.
- Submission outcomes: definite provider rejection => attempt FAILED + withdrawal FAILED +
  outbox FAILED_PERMANENT; ambiguous transport error => `SUBMISSION_PENDING` with the outbox
  back to PENDING on backoff and NO resubmission; provider acceptance persists ref + id and
  marks the outbox SUBMITTED; an attempt that already carries a provider identity is NEVER
  resubmitted (crash recovery).

### 2.3 `payout-adapters.spec.ts` (16 tests)

- Paystack (9): recipient creation posts the documented fields and returns `recipient_code`
  as the beneficiary identity; missing bank fields fail closed; unsupported corridor (BANK +
  KES) rejected, never converted; initiation posts `source=balance`, minor-unit amount and
  the sanitized >=16-char reference; a definite 4xx maps to `PayoutProviderRejectedError`;
  an ambiguous 5xx maps to `PayoutTransportError`; verification returns the
  `recipient_code` as beneficiary evidence with a minor-unit amount; an unknown transfer
  (404) reports `exists:false` and is never a failure; the submission reference is
  deterministic, sanitized and length-valid.
- Flutterwave (7): account-resolve is called and a bank fingerprint derived; an
  unresolvable destination fails closed with no transfer; initiation posts the inline
  beneficiary body with MAJOR-unit amount; mobile-money initiation posts the mobile number,
  not bank fields; rejection/transport error mapping; verification converts MAJOR to minor
  exactly and derives the beneficiary fingerprint from the transfer's own fields;
  major->minor conversion is exact for 2-decimal currencies.

### 2.4 `payout-reconciliation-atomic.spec.ts` (9 tests)

- Verified success settles in ONE transaction: attempt SUCCESSFUL + withdrawal PAID + ledger
  posting + evidence + reconciliation + audit rows together.
- Pending outcome keeps PROCESSING and the reservation with no ledger posting.
- Authoritative provider failure applies attempt FAILED + withdrawal FAILED atomically.
- Verified reversal is recorded separately (PAID -> REVERSED) with audit and a manual review
  case — never an ordinary failure.
- Amount mismatch never settles: reservation intact, escalation case opened.
- Missing provider beneficiary evidence on a success => `PROVIDER_DATA_INCOMPLETE`, fail
  closed.
- Provider beneficiary not matching the approved one => `DESTINATION_MISMATCH`, never
  settles.
- A failing withdrawal state update aborts the ENTIRE transaction (no partial commit).
- A duplicate provider reference bound to another attempt => `DUPLICATE_REFERENCE`, never
  settles.

### 2.5 `manual-review-and-verification.spec.ts` (9 tests)

- `CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE` requires a registered evidence file.
- It requires an INDEPENDENT reviewer (two distinct administrators; self-review rejected).
- A resolution NEVER settles directly: the withdrawal stays non-PAID and no settlement path
  is invoked by the resolver.
- An already-resolved case cannot be resolved again (idempotency guard).
- Stale UNKNOWN attempts escalate to OPEN cases with the attempt in `MANUAL_REVIEW`.
- Fail-closed verification: provider-reported amount/currency/beneficiary pass into
  reconciliation unchanged (exact comparison happens there); a transport failure during
  verification classifies UNKNOWN — never FAILED; a transfer the provider does not know
  classifies UNKNOWN (`exists=false`); an attempt without any provider identity cannot be
  verified (submission incomplete).

## 3. Suite inventory (16 suites, 255 tests, 0 failures)

| Suite | Area |
| --- | --- |
| `payouts/payout-state-machine.spec.ts` | withdrawal/attempt state machines, classification, reconciliation model (extended from 25 tests in v1.0.4) |
| `payouts/payout-initiation.service.spec.ts` | initiation pipeline (new in v1.0.7) |
| `payouts/adapters/payout-adapters.spec.ts` | Paystack/Flutterwave adapters (new in v1.0.7) |
| `payouts/payout-reconciliation-atomic.spec.ts` | atomic reconciliation (new in v1.0.7) |
| `payouts/manual-review-and-verification.spec.ts` | manual review + fail-closed verification (new in v1.0.7) |
| `withdrawals/withdrawals-approval.spec.ts` | dual approval, separation, invalidation |
| `ledger/ledger.service.spec.ts` | double-entry invariants, reservations |
| `payments/donation-payment.service.spec.ts` | donation success exactly-once |
| `payments/providers/paystack.service.spec.ts` | donation-side Paystack verification |
| `payments/providers/flutterwave.service.spec.ts` | donation-side Flutterwave verification |
| `auth/auth.service.spec.ts` | authentication, refresh rotation |
| `mfa/mfa.service.spec.ts` | challenge lifecycle, fail-closed Redis |
| `mfa/totp.util.spec.ts` | RFC 4226/6238 vectors |
| `common/utils/crypto.util.spec.ts` | hashing/encryption primitives |
| `common/utils/redis-url.util.spec.ts` | strict Redis URL validation |
| `common/utils/money.spec.ts` | minor-unit money math |

All executed with jest against mocked Prisma clients and mocked provider HTTP. The backend
e2e/integration suite (`backend/test/`) is covered in Sections 4-5 (now EXECUTED); the
frontend Playwright suite (`frontend/tests/e2e/`) remains **NOT RUN** in this sandbox
(requires a running frontend + browser infrastructure).

## 4. Real-PostgreSQL verification (migration 0004) — EXECUTED

A userspace PostgreSQL 18 cluster (embedded binaries, socket + TCP) ran two database paths:

- **Path A — fresh install:** `0001_init` → `0002_hardening` → `0003_payout_lockdown` →
  `0004_payout_execution_integrity` applied cleanly via the simple query protocol.
- **Path B — v1.0.6 upgrade:** `0001..0003` applied, v1.0.6-era legacy rows seeded (a
  withdrawal in `APPROVED` with two active approvals and NO `destinationVersion` binding),
  then `0004` applied on top. **34/34 checks passed**:

| Group | Checks |
| --- | --- |
| Structure | 6 new tables exist (`PayoutAttempt`, `PayoutOutbox`, `PayoutBeneficiary`, `PayoutVerificationEvidence`, `PayoutReconciliation`, `ManualReviewCase`); `PayoutAttemptStatus` extended with the 9 durable initiation states; `WithdrawalStatus` gained `REQUIRES_RECONCILIATION` + `REVERSED`. |
| Upgrade safety | Legacy withdrawal + both approvals survive 0004 with no data loss; `destinationVersion` defaults to 1. |
| Constraints | Unique `requestFingerprint` rejects a duplicate submission fingerprint; unique `idempotencyKey` rejects a second logical attempt; `PayoutOutbox` uniqueness rejects a duplicate event; FK enforcement blocks an attempt pointing at a missing withdrawal. |
| Immutability | `UPDATE` and `DELETE` on `PayoutReconciliation` are blocked by the financial-record-protection triggers; deleting the withdrawal while payout history exists is blocked (no cascade of financial history). |
| Concurrency | `SELECT ... FOR UPDATE` on the withdrawal row: a second connection's `FOR UPDATE NOWAIT` is correctly blocked while the first transaction holds the lock — the serialization primitive behind atomic reconciliation. |

`npx prisma migrate diff --from-migrations --to-schema-datamodel --shadow-database-url ...`
reports **"No difference detected"** — the migration chain and `schema.prisma` are structurally
identical.

## 5. Defects found and fixed by the real-database integration run

The integration suite had never been executed before this pass (no database existed in the
sandbox at code-freeze). Running it for the first time found **three real defects** that all
unit suites missed:

1. **`InternalPayoutsModule` DI failure — the API could not boot.**
   The controller injects `PayoutInitiationService`, `PayoutVerificationService` and
   `ManualReviewService`, but the module never imported `PayoutsModule`. Any real boot
   (and every integration spec) failed with "Nest can't resolve dependencies". Unit tests
   missed it because they mocked the DI container. **Fix:** import `PayoutsModule` in
   `src/internal/internal-payouts.module.ts`.
2. **`DonationsModule` missing the same import for `WebhooksController`** (transfer.*
   webhooks trigger payout verification). Same "can't resolve" failure class.
   **Fix:** import `PayoutsModule` in `src/donations/donations.module.ts`.
3. **TOTP verification used the wrong key — real administrators could never enroll.**
   `MfaService.confirm()`/`issueChallenge()` hashed the ASCII bytes of the base32 secret
   STRING (`Buffer.from(secretText)`), while every RFC 6238 authenticator app hashes the
   base32-DECODED key bytes. The unit spec had replicated the same wrong encoding (testing
   the implementation against itself). Financial impact: the fresh-MFA step-up that guards
   payout approval/settlement would have been unusable in production. **Fix:** verify over
   `base32Decode(decryptSecret(...))` in both paths; the unit spec now computes codes the
   way authenticator apps do. `totp.util.spec.ts` RFC vectors still pass unchanged.

Two v1.0.6-era spec expectations were updated to the (stricter) v1.0.7 contract — no
financial control was weakened:

- **Self-approval probe:** an approval attempt by the withdrawal's requester WITHOUT a fresh
  MFA challenge now correctly expects the fail-closed MFA error first (v1.0.7 §8.4 makes
  fresh MFA mandatory for first approval; the guard must not reveal any other decision to a
  session that has not proven freshness). Separation of duties is asserted WITH a valid
  challenge (`"cannot approve"`).
- **Executor identity:** v1.0.7 §8.2 requires the executor to differ from BOTH approvers (a
  fourth identity). The specs now (a) assert the first approver's execution attempt is
  rejected and (b) settle with a dedicated fourth administrator carrying their own evidence
  file.

Test-harness robustness (no product change): the e2e MFA helper now retries the challenge
exchange across TOTP windows — when enroll + an earlier challenge have consumed both
verifiable counters of a 30-second window, replay suppression correctly rejects the code and
the helper waits for the next window (bounded to 3 windows; `jest.setTimeout(240s)`).

## 6. NOT RUN / BLOCKED verification

| Verification | Why it is blocked | What it would prove |
| --- | --- | --- |
| Paystack sandbox execution (recipient creation, transfer, verification, reference lookup) | **BLOCKED** — no `PAYSTACK_SECRET_KEY` | Field-level adapter correctness against the real API. |
| Flutterwave sandbox execution (account resolve, transfer, verification, reference query) | **BLOCKED** — no `FLUTTERWAVE_SECRET_KEY` | Same, for Flutterwave. |
| Multi-instance outbox concurrency on real infrastructure | Requires deployed infrastructure | That the durable claim prevents duplicate submissions across N instances. |
| Signed transfer webhooks end-to-end | Requires deployed API + provider sandbox | Trigger-only webhook behavior against real signatures. |

No provider sandbox test ran; therefore no sandbox result, transfer ID or provider reference
is reported, implied or fabricated anywhere in this document.

## 7. What a full verification run requires

Checklist for the operator/engineer completing verification:

1. **PostgreSQL 14+** (local or hosted) and a restored copy of the v1.0.6 database (or a
   fresh database migrated 0001 -> 0004).
   - `cd backend && npx prisma migrate deploy` — confirm 0004 applies.
   - Verify the immutability triggers (an `UPDATE` on `PayoutReconciliation` must fail) and
     the unique constraints (a duplicate outbox idempotency key must conflict).
2. **Redis (optional but recommended)** — required for fresh-MFA flows and the recovery
   locks; the outbox sweeper works without it.
3. **Provider test keys** — `PAYSTACK_SECRET_KEY` / `FLUTTERWAVE_SECRET_KEY` (test/sandbox
   mode) plus `PROVIDER_MODE=live` semantics in a staging deployment; then:
   - resolve a test beneficiary, initiate a sandbox transfer with a `kdo-...` reference,
     verify via the API, and exercise one ambiguous case (drop the response) to confirm
     `SUBMISSION_PENDING` -> provider lookup -> verification;
   - exercise one definite-rejection case (invalid beneficiary) to confirm
     attempt FAILED + withdrawal FAILED without a transfer.
4. **`RUN_INTEGRATION=1`** — `cd backend && npm run test:integration` on the real database;
   the CI `backend-integration` job runs the same suite on every push.
5. **Multi-instance check** — two API instances (or one API + worker) with
   `WORKER_INGEST_TOKEN` set on both sides; confirm a single outbox claim and no duplicate
   submission.
6. Record results in this report's successor; until then the NOT RUN entries above stand.

## 8. Test-count summary

| Package | Executed | Result |
| --- | --- | --- |
| backend unit (jest, mocked) | 255 tests / 16 suites | all pass |
| frontend unit (vitest) | 52 tests | all pass |
| migration verification (real PostgreSQL 18, fresh + upgrade paths) | 34 checks | all pass |
| `prisma migrate diff` (migrations vs schema) | 1 structural check | no difference |
| backend integration (real PostgreSQL 18 + Redis 7.2.5) | 47 tests / 5 suites | all pass |
| provider sandbox (Paystack/Flutterwave) | not run | BLOCKED (no credentials) |
