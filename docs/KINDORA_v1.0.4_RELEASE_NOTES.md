# KINDORA v1.0.4 RELEASE NOTES

**Release:** KINDORA v1.0.4 — Payout State Machine Lockdown & Approval Separation
**Baseline:** KINDORA v1.0.3_SECURITY_COMPLETE
**Tagline:** Goodness, in motion.
**Deployment:** Netlify (frontend) + Render (API, workers, PostgreSQL, Redis)

This is a targeted security remediation release. No feature was removed, no database was reset, and no financial history was altered. Every fix below is verified against source and regression tests (see the test report for the exact executed/blocked split).

---

## Breaking changes (API contract)

| Change | Detail |
|---|---|
| Legacy payout endpoints removed | `POST /withdrawals/:id/mark-paid`, `POST /withdrawals/:id/mark-failed`, `POST /withdrawals/:id/mark-processing` now return **404**. Settlement is `POST /withdrawals/:id/settle`; retry is `POST /withdrawals/:id/retry`. |
| Fresh MFA required | All 11 sensitive payout/financial endpoints require the `x-mfa-challenge` header with a single-use token from `POST /mfa/challenge`. Read-only endpoints unchanged. |
| Evidence contract | `mark-paid`'s free-text `evidenceUrl` is GONE. Settlement requires `evidenceFileId` — a private, scanned `PAYOUT_EVIDENCE` StoredFile uploaded by the acting administrator. |
| Dual approval policy | Default mode is `ALL`: EVERY payout requires two distinct approvers AND executor separation. `WITHDRAWAL_DUAL_APPROVAL_MODE=THRESHOLD` requires a positive `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR`. The "0 disables dual approval" convention no longer exists. |

## New capabilities

1. **Canonical payout state machine** (`backend/src/payouts/`) — one owner of every withdrawal transition; forbidden edges are impossible; terminal states are terminal. Two new states: `REQUIRES_RECONCILIATION` (ambiguous outcome, reservation held) and `REVERSED`.
2. **Payout attempt registry** — durable `PayoutAttempt` rows with unique idempotency keys and unique provider transfer references; HTTP/job/webhook retries cannot duplicate transfers.
3. **Authoritative provider transfer verification** — read-only `verifyTransfer` for Paystack and Flutterwave; response classification into SUCCESSFUL/FAILED/PENDING/UNKNOWN/REVERSED where unknown is NEVER failure.
4. **Immutable approval history** — `WithdrawalApproval` rows (FIRST_APPROVER/SECOND_APPROVER/EXECUTOR) bound to exact amount+currency per approval cycle; invalidation keeps history; approval reuse after amount/currency change is impossible.
5. **Fresh MFA** — TOTP enrollment + single-use, purpose- and scope-bound challenges, fail-closed on Redis unavailability (`backend/src/mfa/`).
6. **Secure manual evidence** — registered private scanned files with unique per-withdrawal binding and audited access.
7. **Structured reconciliation** — `PayoutReconciliation` result model (10 categories) persisted with provider evidence.
8. **Strict Redis URL validation** — backend startup + runtime + workers; credentials never logged.
9. **CI security gates** — payout/MFA/dual-approval regression jobs, production-dependency audit gate with an explicit accepted-risk list, checksum verification, real sharp image pipeline test.

## Dependency remediation

| Package | From | To |
|---|---|---|
| nodemailer (backend+workers) | 6.9.16 | **10.5.0** |
| zod (frontend) | 3.24.1 | **4.6.7** |
| sharp (workers) | 0.33.x | **0.35.5** |
| @sentry/node (backend) | 8.50.0 (unused) | removed |

See `docs/DEPENDENCY_SECURITY_REPORT.md` for the advisory-by-advisory mapping and the one documented accepted dev-chain risk (prisma CLI → deepmerge-ts, build tooling only).

## Database migration

`0003_payout_lockdown` — additive, forward-only: new tables `MfaCredential`, `WithdrawalApproval`, `PayoutAttempt`, `PayoutReconciliation`; new enum values (`WithdrawalStatus.REQUIRES_RECONCILIATION`/`REVERSED`, `StoredFileKind.PAYOUT_EVIDENCE`); `StoredFile.evidenceForWithdrawalId` (unique); `Withdrawal.approvalCycle` (default 1). Existing financial history is untouched. Details: `docs/DATABASE_MIGRATION_GUIDE.md`.

## Operator actions required at deployment

1. Apply migrations via the API `preDeployCommand` (automatic in render.yaml) after rehearsing against a restored v1.0.3 database.
2. Set the new environment variables (`WITHDRAWAL_DUAL_APPROVAL_MODE`, optional `MFA_ENCRYPTION_KEY`, `REDIS_REQUIRE_TLS`) — see `docs/PRODUCTION_ENVIRONMENT_VARIABLES.md`.
3. Rehearse migration 0003 against the restored v1.0.3 database before production rollout.
4. Complete the deployment verification checklist in `PRODUCTION_READINESS_CHECKLIST.md` (Redis/provider/storage/SMTP connectivity).
5. Administrators: enroll in MFA (`POST /api/v1/mfa/enroll`) before performing payout approvals; note the new three-admin settlement flow in `docs/PAYOUT_OPERATIONS_GUIDE.md`.

## Artifacts

- `KINDORA_v1.0.4_SECURITY_COMPLETE.zip` (full source, migrations, tests, docs)
- `KINDORA_v1.0.3_ORIGINAL_BACKUP.zip`, `KINDORA_v1.0.3_SOURCE_RECOVERY_BACKUP.zip`, `KINDORA_v1.0.3_DATABASE_MIGRATIONS_BACKUP.zip`
- `KINDORA_v1.0.4_SHA256SUMS.txt` + `KINDORA_v1.0.4_BACKUP_MANIFEST.md`
- `KINDORA_v1.0.4_TEST_REPORT.md`, `KINDORA_v1.0.4_SECURITY_AUDIT.md`, `PRODUCTION_READINESS_CHECKLIST.md`

## Release classification

**SECURITY-HARDENED — DEPLOYMENT VERIFICATION PENDING**

All source-level security controls and the automated tests executable in this environment pass; live deployment verification (Render/Netlify/Redis/providers/SMTP/migration rehearsal) is explicitly pending and documented — no production-readiness claim is made beyond that.
