# Backup and Recovery

Backups for the database and object storage, restore procedures, RPO/RTO guidance, secret
rotation, release rollbacks and the disaster-recovery runbook.

Related: [DATABASE_SETUP.md](DATABASE_SETUP.md) | [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [SECURITY.md](SECURITY.md) | [CRON_JOBS.md](CRON_JOBS.md)

---

## 1. PostgreSQL backups

### 1.1 Render automatic backups (primary mechanism)

Render provides automated backups / point-in-time recovery (PITR) on **paid** database
plans - the free plan does not persist reliably, which is unacceptable for a ledger-backed
platform ([RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)).

1. Render Dashboard -> `kindora-db` -> **Backups**: enable and note the retention window.
2. PITR covers operator error (bad migration, bad delete) within the retention window and
   restores to a specific timestamp.
3. Verify a backup exists after the first week of real data, and after every significant
   milestone.

### 1.2 Manual logical dumps (secondary mechanism)

Run from any machine that can reach the **external** connection string (internal vs
external: [DATABASE_SETUP.md](DATABASE_SETUP.md)):

```bash
# Full logical backup, custom format (compressed, restorable with pg_restore)
pg_dump "postgresql://kindora:<password>@<external-host>.render.com:5432/kindora?sslmode=require" \
  -Fc -f "kindora-$(date +%F).dump"

# Plain SQL backup (readable, larger)
pg_dump "postgresql://kindora:<password>@<external-host>.render.com:5432/kindora?sslmode=require" \
  --no-owner --no-privileges -f "kindora-$(date +%F).sql"

# Single-table example
pg_dump "$DATABASE_URL" -Fc -t '"Donation"' -f donations.dump
```

Schedule dumps (e.g. nightly from any machine with storage) and **test that the files are
restorable** - an untested backup is not a backup. Store dumps outside the database
provider's infrastructure.

## 2. Media bucket backup

- Campaign media / avatars are re-derivable only from the bucket - enable the provider's
  **versioning** and lifecycle rules (Cloudflare R2 and Backblaze B2 support object
  versioning and lifecycle; MinIO supports bucket versioning; Render Object Storage:
  check current docs).
- The worker re-processes images from originals, so keeping the **originals** is what
  matters; derived renditions (thumbnails) are disposable
  ([STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md)).
- For `identity` documents, versioning is a compliance aid; access stays presign-only.
- Optionally sync critical buckets to a second location periodically:

  ```bash
  aws s3 sync s3://<bucket> ./bucket-backup --endpoint-url "$STORAGE_ENDPOINT"
  ```

## 3. RPO / RTO guidance

| Metric | Target (guidance) | How it is met |
| --- | --- | --- |
| **RPO** - acceptable data loss | Near zero for ledger/donation data; minutes for transient tables | Paid-plan PITR (continuous WAL) as the primary mechanism + scheduled dumps as a second copy. Decide the exact number for your deployment and verify PITR granularity with Render |
| **RTO** - acceptable recovery time | Under one hour for full DB loss; minutes for service-level incidents | Restore drill (section 7) + the runbook in section 6; Render rollbacks take minutes; DNS/env changes are the slow path - rehearse them |

Set explicit RPO/RTO numbers for your operation, document them, and re-verify each
quarter with a drill (section 7).

## 4. Restore steps

### 4.1 PostgreSQL from a dump

```bash
# 1. Stop writes: pause traffic (scale kindora-api to 0 or hold deploys) so money is not
#    written during the restore.
# 2. Restore into the target database (this overwrites schema + data):
pg_restore --clean --if-exists --no-owner \
  -d "postgresql://kindora:<password>@<external-host>.render.com:5432/kindora?sslmode=require" \
  kindora-YYYY-MM-DD.dump

# 3. Reconcile migration state if the dump predates a migration:
cd backend && DATABASE_URL='postgresql://...' npx prisma migrate deploy   # applies anything missing

# 4. Restart services, verify health endpoints, spot-check the ledger via the admin
#    transactions view, then resume traffic.
```

### 4.2 PostgreSQL via PITR

1. Render -> `kindora-db` -> Backups -> choose a restore timestamp (or the latest).
2. Render restores into a database instance per the current dashboard flow - note the
   **new connection string** if the hostname changed.
3. Update `DATABASE_URL` on `kindora-api`, `kindora-worker` and **all six cron jobs** if
   the hostname changed; restart/redeploy each.
4. Verify health endpoints and a ledger spot-check before reopening traffic.

### 4.3 Object storage

R2/B2/MinIO: restore a deleted object by re-uploading the previous version (versioning)
or by syncing back from the backup copy (section 2). Record in the incident log what was
restored and when.

## 5. Secrets recovery and rotation

| Secret lost/compromised | Action | Consequence |
| --- | --- | --- |
| `JWT_SECRET` rotated | Set a new value on `kindora-api`, restart | **All sessions invalidate**: access tokens signed with the old secret fail validation and refresh tokens can no longer be exchanged - every user is logged out. Harmless to data; communicate the forced re-login |
| `SESSION_SECRET` rotated | Set new value, restart | Same re-login effect for cookie-dependent flows |
| Provider secret key leaked | Rotate **in the provider dashboard first**, then update the Render env var | Webhooks signed with the new key verify correctly; in-flight checkout sessions may fail - check `WebhookEvent` rows ([PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md)) |
| `FLUTTERWAVE_WEBHOOK_HASH` leaked | Generate a new random string; set it on Render **and** in the Flutterwave dashboard (secret hash) | Brief window while dashboards sync - watch for `FAILED` signature rows |
| `STORAGE_SECRET_KEY` leaked | Revoke/reissue keys at the provider; update API (+ worker) env vars | In-progress presigned uploads may fail; presigns are short-lived so the window is small |
| `DATABASE_URL` password leaked | Change the DB password (Render dashboard), update `DATABASE_URL` on all 7 services | Worker + crons need a restart to pick it up |
| `REDIS_URL` password leaked | Rotate the Key Value password; update `REDIS_URL` on all 8 services | In-flight queue jobs may need re-enqueue; locks expire by TTL |
| SMTP password leaked | Rotate at the provider; update API, worker and the two email-sending crons | Emails queue and retry meanwhile |

Order matters for provider secrets: rotate at the provider first, then update the app -
otherwise the old key keeps working while the new one fails verification.

## 6. Disaster recovery runbook

### 6.1 Database restore (full recovery)

1. **Declare the incident**; stop writes (pause `kindora-api`).
2. **Restore** the database (PITR to the last good moment, or the latest dump per 4.1).
3. **Repoint services**: update `DATABASE_URL` everywhere it is set (API, worker, 6
   crons) if the hostname changed; restart them.
4. **Redeploy the API** if needed (`Manual Deploy -> Deploy latest commit`) so the
   pre-deploy runs `npx prisma migrate deploy` and the schema matches
   ([RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)).
5. **Verify**:
   - `curl https://api.kindora.com/api/v1/health` -> 200
   - `curl https://api.kindora.com/api/v1/health/database` -> 200
   - `curl https://api.kindora.com/api/v1/health/redis` -> 200 (`"configured":true`)
   - Admin transactions view: spot-check recent `donation:<id>` ledger transactions for
     balance and recency.
6. **Reconciliation pass**: trigger the reconciliation digest (Render cron **Run now**, or
   enqueue `payments.reconcile`) and confirm the digest either reports all-clear or lists
   the donations still `PENDING` at providers - resolve each via the backend verifyStatus
   flow; the guarded state machine keeps application exactly-once
   ([CRON_JOBS.md](CRON_JOBS.md), [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md)).
7. **Reopen traffic**; write the incident report (timeline, RPO achieved, deltas).

Donations still PENDING at providers are recoverable by design: nothing is lost while
webhooks were down as long as the ledger database is intact.

### 6.2 Region/instance loss (Render incident)

1. If Render restores the instance, follow 6.1 from step 3.
2. If you must rebuild: create a new database (Blueprint or manual), restore the newest
   dump, update `DATABASE_URL` on all 7 services, redeploy the API (migrations run via
   pre-deploy), restore the media bucket from versioning/backup, verify health +
   reconciliation, then reopen.

### 6.3 Webhook outage

1. Check the provider dashboard event log for delivery attempts and HTTP codes.
2. Check `WebhookEvent` rows: `FAILED` + "signature verification failed" => signature env
   vars mismatched - fix and re-deliver events from the dashboard.
3. No rows at all => reachability: DNS/`api.kindora.com` down, 5xx during deploy, or a
   wrong URL registered. Fix, then run a reconciliation pass (6.1 step 6) to sweep the
   backlog.

### 6.4 Queue backlog

1. Measure: `redis-cli -u "$REDIS_URL" LLEN bull:<queue>:waiting` and `...:failed`
   ([BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md)).
2. Identify the failing dependency in worker logs (SMTP, storage, backend 5xx).
3. Fix the dependency; BullMQ retries with exponential backoff (5 attempts) automatically.
4. For exhausted jobs sitting in `failed`: fix the cause, then re-enqueue the affected
   work (reconciliation and analytics recompute are idempotent).

## 7. Rolling back bad releases

### 7.1 Render rollback

Service -> **Events** -> Rollback to the previous deploy. Applies independently to
`kindora-api`, `kindora-worker` and crons.

### 7.2 Netlify rollback

Site -> **Deploys** -> Rollback to a known-good deploy. Instant, no rebuild.

### 7.3 Migrations after rollback

Rollbacks restore code, not schema. Because migrations follow the expand/contract pattern
([DATABASE_SETUP.md](DATABASE_SETUP.md)), an older release runs fine on a newer schema.
Edge cases:

- **Migration applied but failed midway**: mark it resolved and fix forward -

  ```bash
  # On a machine with the external DATABASE_URL:
  npx prisma migrate resolve --rolled-back <migration_name>
  ```

  Then deploy a corrected migration. Never leave a failed row in `_prisma_migrations`
  while `preDeployCommand` runs - `prisma migrate deploy` refuses to continue.
- **Need to un-apply a migration**: there is no supported automatic down-migration; write
  a forward-fix migration that reverses the change, or restore from PITR/dump if data
  integrity is at stake.

## 8. Regular drills

- **Quarterly**: restore the latest dump into a scratch database, run
  `npx prisma migrate deploy`, and do a ledger spot-check.
- **Quarterly**: restore one object-storage version and confirm the URL serves.
- **After every drill**: rotate any credentials used in the drill that were exposed in
  shell history; update this document if the procedure drifted from reality.

Related: [DATABASE_SETUP.md](DATABASE_SETUP.md) | [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [SECURITY.md](SECURITY.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)
