# KINDORA v1.0.7 RELEASE NOTES

**Release:** KINDORA v1.0.7_SECURITY_COMPLETE — Payout Execution Integrity
**Baseline:** KINDORA v1.0.6
**Tagline:** Goodness, in motion.
**Deployment status:** NOT DEPLOYED. This release is classified **STAGING READY** — it is
not a PRODUCTION CANDIDATE until the provider-sandbox verifications listed below are
executed (the database-integration verification IS now complete; see Section 7).

This is a targeted upgrade of the payout execution path (the money-leaving side). Donation
checkout, the ledger, campaigns and the admin surface outside payouts are unchanged. Every
claim below is derived from the source tree; the executed/blocked verification split is in
[KINDORA_v1.0.7_TEST_REPORT.md](KINDORA_v1.0.7_TEST_REPORT.md).

---

## 1. The eight critical issues fixed vs v1.0.6

| # | Issue (v1.0.6 behavior) | v1.0.7 fix |
| --- | --- | --- |
| 1 | Cross-provider verification routing: a payout naming a provider without a real payout implementation (Stripe) could be executed through another provider's transfer/verification logic. | Provider registry with explicit rejectors: STRIPE/PAYPAL payout requests fail with `PayoutProviderUnsupportedError`; `PAYOUT_SUPPORTED_PROVIDERS` gate + production startup validation; Stripe payouts disabled while Stripe donations remain supported. |
| 2 | Non-atomic reconciliation: success was applied atomically, but pending/unknown/mismatch outcomes scattered attempt + withdrawal writes across separate statements (partial-state windows). | `PayoutReconciliationService.apply()` routes EVERY outcome through ONE transaction: row locks, approval-cycle validation, evidence rows, classification, guarded transitions, exactly-once ledger, audit. |
| 3 | Stale-approval race: `approve()`/`secondApproval()` validated withdrawal state read outside the transaction, so concurrent changes could slip between read and write. | Both now `SELECT ... FOR UPDATE` the authoritative withdrawal (and the first approval row for the second approval) INSIDE the transaction and return the committed record; initiation re-validates the same rules under lock before any provider call. |
| 4 | Approvals not bound to the destination: the destination could change after approval without invalidating the approval cycle. | `Withdrawal.destinationVersion` + `WithdrawalApproval.destinationVersionAtApproval` + `snapshotHash`; `POST /withdrawals/:id/destination` bumps the version and invalidates approvals + beneficiaries in one transaction. |
| 5 | Non-durable initiation: the provider transfer was called without a committed durable intent; a crash between send and record could lose or duplicate a transfer. | `PayoutAttempt` + `PayoutOutbox` committed in ONE transaction BEFORE any provider call; durable conditional claim; crash recovery treats an existing provider identity as never-resubmit; in-process sweeper is the floor. |
| 6 | Blind retry of ambiguous submissions: timeout/5xx/lost responses were retried, risking duplicate transfers. | Ambiguity => `SUBMISSION_PENDING` + `findTransferByReference` lookup; resubmission forbidden; unresolved ambiguity escalates to MANUAL_REVIEW after `PAYOUT_UNKNOWN_ESCALATION_MINUTES` (default 120). |
| 7 | Weak beneficiary identity: provider verification compared a hash of the local destination JSON, which proves nothing about where the provider actually sent money. | `PayoutBeneficiary` model with provider-native identity (`recipient_code` / FLW fingerprint) bound to `destinationVersion`; reconciliation compares provider beneficiary evidence against the bound `externalRef`. |
| 8 | Fail-open settlement inputs: webhook payloads could act as settlement sources, and missing provider amount/currency/beneficiary evidence could be interpreted as a match. | Webhooks only TRIGGER verification (fresh provider API fetch); missing mandatory evidence on a success => `PROVIDER_DATA_INCOMPLETE` => fail closed => manual review; reference mismatches and duplicate references never settle. |

Related tightening: the executor-separation matrix is now complete and enforced BEFORE any
provider call (executor can be neither requester nor first nor second approver) and
re-validated inside the intent transaction under row lock.

## 2. New capabilities

1. **Real provider payout adapters** (`backend/src/payouts/adapters/`): Paystack
   (`/transferrecipient`, `/transfer`, `/transfer/:id`) and Flutterwave
   (`/v3/accounts/resolve`, `/v3/transfers`, `/v3/transfers/:id`, `/v3/transfers?reference=`)
   with per-provider semantics and typed errors (`PayoutTransportError`,
   `PayoutProviderRejectedError`, `PayoutProviderUnsupportedError`).
2. **Durable initiation pipeline** (`payout-initiation.service.ts`): separation + snapshot
   binding before any external call; intent-first commit; outbox submission with bounded
   backoff (30s * 2^n, max 15 min, jitter); crash recovery; escalation windows.
3. **Fail-closed verification + atomic reconciliation** (`payout-verification.service.ts`,
   `payout-reconciliation.service.ts`): fresh provider read per verification; immutable
   `PayoutVerificationEvidence` + `PayoutReconciliation` rows with evidence hash; integer
   minor-unit amount comparison; case-insensitive currency; provider-native beneficiary
   identity.
4. **Manual review workflow** (`manual-review.service.ts`): 13 case categories, four
   resolution types, evidence file + independent reviewer for success confirmations, fresh
   `PAYOUT_MANUAL_REVIEW` MFA; review can never settle directly.
5. **Executor route**: `POST /withdrawals/:id/execute` with fresh `PAYOUT_EXECUTION` MFA;
   destination update endpoint; stale-approval fix.
6. **Worker integration**: new `payouts` BullMQ queue whose handlers are thin triggers
   POSTing to token-gated internal endpoints (`/api/v1/internal/payouts/*`,
   `x-worker-token`, fail-closed 503 without `WORKER_INGEST_TOKEN`); cron
   `npm run cron:payout-recovery` with Redis lock; in-process sweeper
   (`PAYOUT_OUTBOX_SWEEP_SECONDS`, default 30) covers deployments without workers.
7. **Database-level integrity** (migration `0004_payout_execution_integrity`): four new
   tables, enum extensions, unique constraints (`requestFingerprint`, outbox idempotency,
   beneficiary per version) and immutability triggers.
8. **Frontend operator surface**: `payoutAttemptStatusBadge` (nine attempt states),
   `withdrawalStatusBadge` gains `REQUIRES_RECONCILIATION` + `REVERSED`,
   `settlementBlockedExplanation` banner, Stripe payout unavailability note,
   `useManualReviewCases` / `resolveManualReviewCase` / `executePayout` hooks with MFA
   headers.

## 3. New environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAYOUT_SUPPORTED_PROVIDERS` | `PAYSTACK,FLUTTERWAVE` | Active payout provider set. Production startup refuses to boot when it names unimplemented providers (anything besides PAYSTACK/FLUTTERWAVE/MOCK) or lacks `PAYSTACK_SECRET_KEY` / `FLUTTERWAVE_SECRET_KEY` for the listed providers. |
| `PAYOUT_UNKNOWN_ESCALATION_MINUTES` | `120` | Minutes an ambiguous (`SUBMISSION_PENDING`) or `UNKNOWN` attempt may stay unresolved before it escalates to `MANUAL_REVIEW` with an OPEN case. |
| `PAYOUT_OUTBOX_SWEEP_SECONDS` | `30` | In-process outbox sweeper interval. Values below 5 DISABLE the sweeper — do not lower below 5 in real deployments. |
| `WORKER_INGEST_TOKEN` | *(unset)* | Shared secret for worker -> backend internal payout endpoints. Unset = internal surface closed (503) and the backend sweeper owns recovery. Set the SAME value on the API and the worker service. |

Full reference: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) (v1.0.7 section).

## 4. Migration instructions

Migration: `backend/prisma/migrations/0004_payout_execution_integrity/migration.sql`.

1. **Rehearse first** against a restored copy of the production (v1.0.6) database. The
   migration was NOT executed against a real PostgreSQL instance in the release sandbox —
   the rehearsal is an operator step, not an optional nicety.
2. Apply in order 0001 -> 0002 -> 0003 -> 0004 via `npx prisma migrate deploy` (the API
   `preDeployCommand` on Render does this automatically). The v1.0.6 -> v1.0.7 delta is
   0004 only; it is additive (new tables, new columns with defaults, new enum values, new
   indexes/constraints/triggers) and does not rewrite existing financial rows.
3. Enum additions (`ALTER TYPE ... ADD VALUE`) are applied inside the same migration;
   on PostgreSQL 11 or earlier this would need splitting — target PostgreSQL 14+.
4. **Trigger behavior notes:** after 0004, direct `UPDATE`/`DELETE` on `PayoutReconciliation`
   and `PayoutVerificationEvidence` and direct `DELETE` on `PayoutAttempt`,
   `WithdrawalApproval`, `PayoutOutbox`, `ManualReviewCase`, `PayoutBeneficiary` raise a
   database exception (`KINDORA financial record protection`). This is intended: history is
   immutable and payout/reservation records are never cascade-deleted. Operators correct
   state through the documented API paths, not SQL.
5. New columns default safely for existing rows: `Withdrawal.destinationVersion` = 1;
   `destinationVersionAtApproval` is nullable (old approvals are simply not version-bound
   and will be rejected at execution time with "the approval cycle must be restarted").

## 5. Breaking / behavioral changes

| Change | Detail |
| --- | --- |
| Strict executor separation | The payout executor can no longer be the first (or second) approver, in any path. A dual-approval payout now requires three distinct identities: requester, first approver, second approver — and a fourth for execution. |
| Dual approval binds `destinationVersion` | Existing v1.0.6 approval rows are not version-bound; executing a payout on such a cycle returns 409 and requires a fresh approval cycle after the upgrade. |
| Destination changes invalidate everything downstream | `POST /withdrawals/:id/destination` bumps `destinationVersion`, retires beneficiaries and invalidates ACTIVE approvals; the withdrawal cannot change destination once a transfer was initiated (409). |
| `PROCESSING` payouts keep `REQUIRES_RECONCILIATION` | Unverifiable/unknown states no longer auto-move. The reservation stays; only authoritative verification (or the manual-settlement path) changes state. |
| Manual review replaces silent escalation | Every blocked settlement, mismatch, incomplete-evidence case and stale unknown opens a visible `ManualReviewCase`; operators are expected to work the queue. |
| Worker payouts need a token | Worker-driven payout jobs require `WORKER_INGEST_TOKEN` on both sides; without it the internal endpoints return 503 and the backend in-process sweeper owns recovery. |
| Stripe payouts | Payout requests naming STRIPE fail with an explicit unsupported error (donations unaffected). |

## 6. Operator actions required at deployment

1. Set the four new environment variables (Section 3) on the API; set `WORKER_INGEST_TOKEN`
   on both API and worker; add the new cron job `npm run cron:payout-recovery` (or rely on
   the worker's 5-minute recovery producer + backend sweeper).
2. Rehearse migration 0004 against the restored database (Section 4) before rollout.
3. Configure Paystack / Flutterwave transfer webhooks if not already present
   (`transfer.*` / `transfer.completed|failed|reversed` on the existing signed webhook URLs);
   they trigger verification only.
4. Administrators: verify MFA enrollment covers the new purposes (`PAYOUT_EXECUTION`,
   `PAYOUT_MANUAL_REVIEW`) and rehearse the manual-review runbook
   ([MANUAL_REVIEW_PROCEDURES_V1.0.7.md](MANUAL_REVIEW_PROCEDURES_V1.0.7.md)).
5. Confirm `PAYOUT_OUTBOX_SWEEP_SECONDS` >= 5 and the sweeper log line appears at API boot.

## 7. Verification status (honest)

| Verification | Status |
| --- | --- |
| Backend unit tests (jest, mocked Prisma/providers) | EXECUTED: 255 passed / 0 failed across 16 suites (re-run clean after every fix). |
| Frontend unit tests (vitest) | EXECUTED: 52 passed. |
| Backend `tsc --noEmit` + `nest build`; workers `tsc --noEmit` + build; frontend `tsc -b` + `vite build` | EXECUTED: all clean. |
| **Migration 0004 against a real PostgreSQL 18 instance (fresh AND v1.0.6-upgrade paths)** | **EXECUTED: 34/34 checks passed** — structure, constraints, immutability triggers, FOR UPDATE locking, no data loss (see test report §4). |
| **`prisma migrate diff` migrations vs schema** | **EXECUTED: "No difference detected"** on a real shadow database. |
| **Backend integration suite (`backend/test/*`) on real PostgreSQL 18 + Redis 7.2.5** | **EXECUTED: 47/47 passed across 5 suites** (auth, webhooks, storage, money-path, withdrawals) with real dual-approval + fresh-MFA flows. Found and fixed 3 real defects (see test report §5). |
| Paystack / Flutterwave sandbox execution | **NOT RUN / BLOCKED** (no provider credentials). |
| Multi-instance outbox concurrency on deployed infrastructure | **NOT RUN**. |
| Deployment (Render/Netlify) | **NOT DEPLOYED** — no deployment has been performed for v1.0.7. |

No provider sandbox results, transfer IDs or provider references are claimed anywhere in
these release notes; none were observed.

## 8. Known limitations and blockers

1. ~~No real-database integration run~~ **RESOLVED:** migration 0004 verified 34/34 on
   PostgreSQL 18 (fresh + upgrade paths) and the 47-test integration suite passes on real
   PostgreSQL + Redis. Multi-instance concurrency on DEPLOYED infrastructure remains
   untested (Section 7).
2. No provider sandbox run: the adapters' field-level correctness against the real Paystack
   and Flutterwave APIs is unverified until sandbox credentials are available.
3. Worker-driven payouts require `WORKER_INGEST_TOKEN`; deployments that skip it must accept
   sweeper-paced recovery (which still works, just without the queue's acceleration).
4. The sweeper must not be disabled: `PAYOUT_OUTBOX_SWEEP_SECONDS < 5` turns it off; keep
   the default 30 (or >= 5) in every environment where payouts can be initiated.
5. Escalation timing depends on `PAYOUT_UNKNOWN_ESCALATION_MINUTES`; a very low value would
   escalate normal provider latency into manual review — keep the default 120 unless you
   have measured your provider's transfer latency.
6. Residual rollout risk (post-verification): the integration suite exercised the money path
   against a SINGLE API instance. Render deployments with more than one API replica must
   still observe the outbox-claim behavior in staging first.

## 9. Release classification

**STAGING READY.**

The source-level payout execution integrity controls are implemented and the executable
automated verification passes: unit suites (255 + 52), typechecks and builds (all three
packages), migration 0004 on a real PostgreSQL instance (fresh + upgrade, 34/34), and the
full backend integration suite on real PostgreSQL 18 + Redis 7.2.5 (47/47) — which found
and fixed three real boot/security defects (test report §5). The remaining gap to
PRODUCTION CANDIDATE is provider-sandbox execution: Paystack and Flutterwave transfer
initiation + verification against the real sandbox APIs (blocked on credentials), plus the
multi-instance staging check. Both are documented in Section 8 and the checklist in
[KINDORA_v1.0.7_TEST_REPORT.md](KINDORA_v1.0.7_TEST_REPORT.md).
