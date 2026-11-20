# KINDORA v1.0.1 — Recovery Guide

How to restore the original version, recover the database, handle failed deployments and restore background processing. Read alongside DEPLOYMENT_GUIDE.md and BACKUP_AND_RECOVERY.md.

---

## 1. Restoring the original v1.0.0 source

The unmodified original is preserved and verified:

- Artifact: `KINDORA_v1.0.0_ORIGINAL_BACKUP.zip`
- SHA-256: `e11d73f30c14ac02a0df8f4d581527328a5c1ebb10f9edfd031306594518cc21` (identical to the supplied `kindora-source-v1.0.0.zip`)
- Integrity: `unzip -t` → *No errors detected in compressed data*

To restore:

```bash
unzip KINDORA_v1.0.0_ORIGINAL_BACKUP.zip -d restore-target/
cd restore-target/kindora/backend && npm ci && npx prisma generate
```

**Database compatibility:** the v1.0.0 code runs safely against a database migrated to 0002_hardening — every added column is nullable or defaulted and every new enum value is additive, so v1.0.0 queries keep working. Do NOT run `prisma migrate resolve --rolled-back 0002_hardening` unless you also need the new columns gone; the additive schema is deliberately backwards-compatible.

## 2. Database recovery

### 2.1 Backup posture
- Enable Render automated daily backups on `kindora-db` (Dashboard → Database → Backups) and keep a 7-day retention minimum.
- For point-in-time safety on high volume, add a weekly `pg_dump` to object storage (cron of your choice):
  `pg_dump "$DATABASE_URL" --no-owner -Fc -f /tmp/kindora-$(date +%F).dump`

### 2.2 Restore procedure (disaster)
1. Stop the API and worker (Render dashboard → Suspend) to prevent writes.
2. Create/restore the database (Render restore-to-new or `pg_restore --clean --if-exists -d "$DATABASE_URL" dump-file`).
3. `npx prisma migrate status` — confirm the migration history matches the restored schema.
4. Resume the API, then the worker.
5. Run the Financial Centre ledger-integrity check (`GET /admin/financial/reconciliation/ledger-integrity`) and the reconciliation digest — treat any violation as an incident, not a data fix: corrections happen only through auditable compensating entries.

### 2.3 Ledger recovery rules
- **Never edit or delete `LedgerTransaction`/`LedgerEntry` rows.** History is immutable by design.
- Wrong amounts can only be corrected with compensating postings (unique references like `refund:<id>`, `fee:donation:<id>` are exactly-once by design).
- If a campaign counter (`raisedAmount`) drifts from the ledger, the integrity check reports it; the ONLY sanctioned repair is a compensating ledger transaction plus a counter adjustment performed in one database transaction, with an `AuditLog` row describing why (document the incident first).

## 3. Failed deployment recovery

### 3.1 Migration failure
`preDeployCommand: npx prisma migrate deploy` failing blocks the release — Render keeps the previous version running.
1. Read the deploy log; identify the failed migration.
2. Fix forward: create a NEW corrective migration; never edit an applied migration file.
3. If you must abort entirely: redeploy the previous commit (Render → Rollback) — the database schema stays valid because every migration is forward-only and additive.

### 3.2 Application startup refusal (fail-fast)
v1.0.1 refuses to boot on unsafe production configuration. The error names every missing item:
- `JWT_SECRET must be set…` → set/generate the variable, redeploy.
- `PROVIDER_MODE=mock is forbidden…` → set `PROVIDER_MODE=live` (or remove mock).
- `At least one payment provider key must be configured…` → configure one provider.
- `CORS_ORIGINS empty in production` (CSRF fail-closed) → list the exact frontend origins.
This is intended behaviour — the platform must never run unprotected.

### 3.3 Version rollback
Render → service → Rollback redeploys the previous image; because migrations are forward-only, the previous application version tolerates the newer schema (§1). Netlify: Deploys → rollback to a previous deploy (frontend is stateless).

## 4. Background workers / queue recovery

- Workers fail fast without `REDIS_URL` by design; if Render Key Value is down, jobs are retained by BullMQ (removeOnFail count 5000) and resume when Redis returns.
- Backend producers degrade to inline-drop when Redis is absent — email/queue side effects during that window are logged `[inline-drop]`; re-trigger critical emails by re-running the affected flows or the weekly reconciliation digest.
- Failed jobs are inspectable via BullMQ (connection details from `REDIS_URL`); reprocess by re-queueing with the SAME idempotency context — every money path is exactly-once via DB-level keys (`IdempotencyKey`, ledger reference uniqueness, conditional status transitions), so safe retries cannot double-post.
- Media jobs: permanent failures set `StoredFile.status=FAILED/REJECTED` with a reason; transient failures rethrow for BullMQ retry (5 attempts, exponential backoff).
- Recurring charges: a crashed run releases its per-cycle idempotency key only when no donation row was written; the next run (≤15 min) retries safely.

## 5. Payment reconciliation after incidents

1. Financial Centre → Payments reconciliation: classify anomalies (`REFERENCE_NOT_FOUND`, `PROVIDER_MISMATCH`, `UNKNOWN_EVENT`, duplicates).
2. Withdrawals reconciliation: settle `needsReconciliation` payouts with evidence (`POST /withdrawals/:id/reconcile`).
3. For provider-recorded payments missing internally: re-trigger server verification (`POST /donations/status/:provider/:ref` is safe and idempotent) or post the webhook by asking the provider to resend — the webhook path is exactly-once.
4. Refunds/disputes: use the admin refund (executes at the provider) or wait for the provider REFUND webhook — both route through the same compensating-entry processor.

## 6. Secret rotation

- `JWT_SECRET`: rotating invalidates outstanding access tokens (15 min max) only — refresh sessions survive. Render → kindora-api → Environment → edit → Save & Deploy.
- Refresh tokens: revoke all sessions for a user by rotating their password (change-password revokes all sessions) or `UPDATE "Session" SET "revokedAt" = now() WHERE "userId" = '…'`.
- Provider keys: rotate in the provider dashboard AND Render env; webhooks re-verify against the new secret automatically.
- Database credentials: Render rotates via blueprint/DB settings; update `DATABASE_URL` on all services that reference the database (blueprint handles propagation).

## 7. Incident response quick reference

| Symptom | First checks | Recovery |
|---|---|---|
| Health 200 but `/health/database` failing | DB status, connection limits | Render DB logs; restore path §2.2 |
| Webhook 500s storming | `/tmp`-less: check `WebhookEvent.status='FAILED'` rows + Sentry | fix root cause; providers auto-retry; events already absorbed stay idempotent |
| Withdrawal marked PAID but no bank receipt | `payoutProviderTxnId`, `evidenceUrl`, audit `WITHDRAWAL_PAID` | §5 reconciliation; mark `FAILED` only if not actually paid |
| Recurring charges stopped | schedules `failureCount`, `lastFailureReason`, PAUSED status | donor updates payment method → donation → new `providerAuthRef` captured |
| Uploads stuck QUARANTINED | `MALWARE_SCAN_ENDPOINT` set? | configure scanner or review manually via audited admin endpoint |
