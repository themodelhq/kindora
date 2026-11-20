# KINDORA v1.0.4 — Database Migration Guide

Applies to: `backend/prisma/migrations/` (PostgreSQL), executed by
`npx prisma migrate deploy`. Blueprint wiring: the **API service only** runs migrations
via `preDeployCommand` (see `render.yaml`); workers and cron jobs never run
`prisma migrate`.

## 1. How migrations work

- Command: `npx prisma migrate deploy` — applies every migration recorded under
  `backend/prisma/migrations/` that is not yet in the `_prisma_migrations` table, in
  filename (timestamp) order.
- **Forward-only.** There is no down-migration. Rollback = deploy the previous
  application release; the database stays where it is (all migrations are additive, so
  older code keeps working against newer schema).
- The lock file `backend/prisma/migrations/migration_lock.toml` pins the provider
  (postgresql). Never change or delete it.
- A migration that fails inside `preDeployCommand` aborts the release: the API keeps
  running the previous version and Render rolls the deploy back. Money state is never
  left half-migrated by a broken release.

## 2. Migration history

| Migration | Release | Content |
| --- | --- | --- |
| `0001_init` | v1.0.0 | Initial schema: users, campaigns, donations, withdrawals, ledger, audit log, stored files, webhooks, queues. |
| `0002_hardening` | v1.0.1 | Security/integrity hardening (constraints, indexes, webhook/ledger protections). |
| `0003_payout_lockdown` | v1.0.4 | Payout lockdown schema (details below). |

## 3. `0003_payout_lockdown` in detail

**Additive only** — no column is dropped, no existing row is rewritten destructively.

### 3.1 New enums

| Enum | Values |
| --- | --- |
| `ApprovalRole` | `FIRST_APPROVER`, `SECOND_APPROVER`, `EXECUTOR` |
| `ApprovalStatus` | `ACTIVE`, `INVALIDATED` |
| `PayoutAttemptStatus` | `INITIATED`, `PENDING`, `SUCCESSFUL`, `FAILED`, `UNKNOWN`, `REVERSED` |
| `ReconciliationResult` | `MATCHED`, `PROVIDER_SUCCESS_INTERNAL_PENDING`, `PROVIDER_FAILED_INTERNAL_PROCESSING`, `PROVIDER_PENDING`, `PROVIDER_UNKNOWN`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DESTINATION_MISMATCH`, `DUPLICATE_REFERENCE`, `REQUIRES_MANUAL_INVESTIGATION` |
| `MfaCredentialStatus` | `ENROLLING`, `ACTIVE`, `DISABLED` |

### 3.2 Enum additions (PostgreSQL `ALTER TYPE ... ADD VALUE`)

- `WithdrawalStatus` += `REQUIRES_RECONCILIATION`, `REVERSED`
- `StoredFileKind` += `PAYOUT_EVIDENCE`

### 3.3 New tables

| Table | Key columns | Constraints |
| --- | --- | --- |
| `MfaCredential` | `userId` (PK, FK→User RESTRICT), `secretEnc` (AES-256-GCM ciphertext), `status` (default `ENROLLING`), `confirmedAt`, `lastUsedAt` | One credential per user |
| `WithdrawalApproval` | `withdrawalId` (FK RESTRICT), `cycle`, `role`, `approverId` (FK RESTRICT), `status`, `amountAtApproval`, `currencyAtApproval`, `note`, `invalidatedAt/ById` | **UNIQUE (withdrawalId, cycle, role)** — one role-holder per approval cycle; indexes on `withdrawalId`, `approverId` |
| `PayoutAttempt` | `withdrawalId` (FK RESTRICT), `attemptNo`, `provider`, `idempotencyKey`, `providerTransferRef`, `amount`, `currency`, `destinationRef`, `status`, `providerStatus`, `classification`, `failureReason`, `lastVerifiedAt`, `initiatedById` | **UNIQUE `idempotencyKey`** (`payout:<withdrawalId>:<attemptNo>`), **UNIQUE `providerTransferRef`**, **UNIQUE (withdrawalId, attemptNo)**; indexes on `withdrawalId`, `status` |
| `PayoutReconciliation` | `withdrawalId` (FK RESTRICT), `attemptId` (FK→PayoutAttempt, SET NULL), `result`, `providerStatus`, `internalStatus`, `amountMatched`/`currencyMatched`/`destinationMatched` (nullable booleans), `providerEvidence` JSONB, `note`, `createdById` | Indexes on `withdrawalId`, `attemptId`, `result` |

### 3.4 Columns added to existing tables

- `StoredFile.evidenceForWithdrawalId TEXT` + **UNIQUE** index and FK→Withdrawal
  (`SET NULL` on delete). Binds a payout-evidence file to exactly one withdrawal —
  evidence reuse across withdrawals is impossible at the DB level.
- `Withdrawal.approvalCycle INTEGER NOT NULL DEFAULT 1`. **Existing rows get
  `approvalCycle = 1`**, so historical withdrawals immediately participate in the new
  approval-cycle model without any data migration.

### 3.5 Compatibility with v1.0.3 data (preserved behaviour)

- Historical withdrawals keep their legacy fields (`payoutProvider`,
  `providerTransferRef`, `paidAt`, `reviewedById`, etc.). Nothing is cleared.
- Historical `evidenceUrl` data is **retained and readable**, but it is **no longer
  accepted as input**: settlement/reconciliation now require a registered `StoredFile`
  of kind `PAYOUT_EVIDENCE` (private, scanned CLEAN, bound to the withdrawal). Old
  free-text URLs remain purely as historical records.
- No enum value was removed or renamed — v1.0.3 rows read and write unchanged.

## 4. Migration safety rules

1. **Never destructive.** No `prisma migrate reset`, no `db push --force-reset`, no
   manual `DROP`/`TRUNCATE` on production. Reset commands exist for local dev only.
2. **Test on a restored v1.0.3 database before production.** Restore the latest
   production backup into a staging database, run `npx prisma migrate deploy` there,
   then boot the v1.0.4 API against it and smoke-test login, withdrawal list, and a
   read-only admin flow. Only then deploy to production.
3. **One migration = one PR.** Never edit a migration after it has been applied in any
   shared environment; add a new migration instead.
4. **Additive-first.** New columns must be nullable or carry a DEFAULT (see
   `approvalCycle DEFAULT 1`) so the old release keeps running during the deploy window.
5. **`ALTER TYPE ADD VALUE` caveat.** Adding multiple values to one enum in a single
   migration requires PostgreSQL 12+ (Render's PostgreSQL is newer — fine). On very old
   targets, split one value per migration.
6. Migrations run only via the API's `preDeployCommand`. Do not run `prisma migrate` in
   worker/cron services or manually against production while a deploy is in flight.

## 5. Inspecting migration status

```bash
cd backend

# Which migrations exist and their status (applied/failed/pending)
npx prisma migrate status

# Direct DB check (read-only)
psql "$DATABASE_URL" -c 'SELECT migration_name, finished_at, rolled_back_at
                          FROM _prisma_migrations ORDER BY finished_at;'
```

Expected on a healthy v1.0.4 deployment: `0001_init`, `0002_hardening`,
`0003_payout_lockdown` all applied, nothing pending. `prisma migrate deploy` re-run on
an up-to-date database is a no-op (`No pending migrations`).

Verify the new schema objects after deploying v1.0.4:

```bash
psql "$DATABASE_URL" -c '\dt'   # MfaCredential, WithdrawalApproval, PayoutAttempt, PayoutReconciliation exist
psql "$DATABASE_URL" -c "SELECT enum_range(NULL::\"ReconciliationResult\");"
psql "$DATABASE_URL" -c 'SELECT count(*) FROM "Withdrawal" WHERE "approvalCycle" IS NULL;'  # must be 0
```

## 6. When the preDeployCommand fails

1. **Read the API deploy log.** Render surfaces the Prisma error verbatim; the release
   is marked failed and the previous deploy keeps serving.
2. **Diagnose the `_prisma_migrations` row.** A failed migration is recorded with
   `rolled_back_at` NULL and logs:
   ```bash
   psql "$DATABASE_URL" -c 'SELECT migration_name, logs FROM _prisma_migrations
                             WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
                             ORDER BY started_at DESC LIMIT 5;'
   ```
3. **Common causes:** DB connection limit exhausted (wait/retry the deploy), a
   concurrent manual `prisma migrate` fighting the pre-deploy (do not do that),
   or a genuinely broken SQL statement (fix in a NEW migration file; never edit the
   applied one).
4. **Mark and resolve a genuinely failed migration** only after fixing the cause:
   `npx prisma migrate resolve --rolled-back <migration_name>` (or `--applied` if it
   actually completed but failed to record), then redeploy.
5. **Escalation gate:** if the failure touches money tables (`Withdrawal`,
   `LedgerEntry`, `PayoutAttempt`), stop and reconcile balances from the restored
   backup before retrying. Never "just re-run" against a half-applied state without
   understanding the transaction boundaries — every `0003` statement is independent and
   re-entrant at the statement level, but the cause must be understood first.
6. Once the deploy is green, re-check `GET /api/v1/health/database` and
   `npx prisma migrate status` before resuming payout operations.
