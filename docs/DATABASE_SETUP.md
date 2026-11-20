# Database Setup (PostgreSQL)

Provisioning, connecting, migrating, seeding and safeguarding the KINDORA PostgreSQL
database. The schema (`backend/prisma/schema.prisma`, PostgreSQL dialect) holds the
double-entry ledger, so treat this database as the most valuable artifact in the platform.

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) | [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) | [SECURITY.md](SECURITY.md)

---

## 1. Create the database on Render

1. Render Dashboard -> **New -> PostgreSQL**.
2. Name: `kindora-db`; database name: `kindora`; user: `kindora` (these match the Blueprint).
3. Plan: `basic-256mb` matches the Blueprint default; upgrade as data or connection needs
   grow. Choose a paid tier - only paid plans provide automated backups/PITR.
4. Region: **the same region as `kindora-api` and `kindora-worker`** - latency and the
   internal network path depend on it.
5. After creation, the dashboard shows the internal and external connection strings
   (section 2).

If you deployed the Blueprint, `kindora-db` already exists and `DATABASE_URL` is wired
automatically (`fromDatabase: connectionString` on every service that needs it).

## 2. Internal vs external connection strings

Render databases expose two hostnames:

| Hostname | Reachable from | Use for |
| --- | --- | --- |
| Internal (private hostname shown as "Internal Database URL") | Services in the **same region** | `kindora-api`, `kindora-worker`, all six cron jobs |
| External (public host, TLS required) | Anywhere on the internet | Your workstation: `psql`, `pg_dump`, `pg_restore`, Prisma Studio, seed runs |

Use the **internal** connection string for co-located services: lower latency and traffic
stays on Render's private network. The Blueprint's `fromDatabase` wiring already resolves
the internal string. Use the **external** string only from your machine; it requires TLS.

## 3. DATABASE_URL format

```text
postgresql://<user>:<password>@<host>:<port>/<database>?sslmode=require
```

Examples:

```text
# External (workstation):
postgresql://kindora:<password>@<external-host>.render.com:5432/kindora?sslmode=require
# Internal (Render services, rendered by fromDatabase):
postgresql://kindora:<password>@<internal-host>/<database>
```

Notes:

- URL-encode special characters in the password.
- Append `?sslmode=require` for external connections (Render's copy of the string usually
  includes it).
- `DATABASE_URL` is a **secret**: store it only in service environment variables. Never in
  the frontend, never in `VITE_` variables, never in git
  ([ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)).

Seven services consume `DATABASE_URL`: `kindora-api`, `kindora-worker` and the six cron
jobs.

## 4. Migrations flow

Migrations live in `backend/prisma/migrations/` (currently `0001_init` plus the
`migration_lock.toml`). Production applies them via the API's pre-deploy command:

```yaml
# render.yaml (kindora-api)
preDeployCommand: npx prisma migrate deploy
```

`prisma migrate deploy`:

- applies every pending migration exactly once, in order;
- records each in the `_prisma_migrations` table;
- **never resets or destructively edits** the database - it will not run `db push`-style
  diffing, and it refuses to proceed if a previous migration is recorded as failed.

Locally you create migrations with `npx prisma migrate dev --name <name>`
([LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md)). CI validates the migration state on every
push (`npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma`)
and applies the real migrations to a fresh PostgreSQL before the integration tests
([GITHUB_ACTIONS.md](GITHUB_ACTIONS.md)).

### 4.1 Backward-compatible migration strategy

During a Render deploy the old release can still serve traffic against the new schema (the
pre-deploy command runs before the new instance takes over, and a rollback re-deploys old
code). Every migration must therefore work with both old and new application code:

1. **Expand**: `ALTER TABLE ... ADD COLUMN` with nullable columns or safe defaults - old
   code ignores them, new code handles `NULL`.
2. **Backfill**: a separate migration (or the weekly `kindora-database-maintenance` /
   `kindora-daily-analytics` cadence) fills values.
3. **Contract**: only in a later release, add `NOT NULL` constraints or drop columns once
   no running code depends on the old shape.

Never combine a destructive change (`DROP COLUMN`, type changes) with the release that
stops using that column. Code rollbacks do not roll back migrations - this discipline is
what makes rollback safe ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)).

## 5. Seeding (optional in production)

The seed (`npm run prisma:seed` -> `ts-node --transpile-only prisma/seed.ts`) is idempotent
(upserts by email/slug/reference). It creates:

- the admin/organizer/donor users (`admin@kindora.com` gets role ADMIN);
- 12 campaign categories;
- a verified organization and six sample campaigns (one USD);
- a **ledger-consistent** donation history - every seeded donation posts a balanced
  double-entry transaction (`1100:CLEARING:*` / `2000:CAMPAIGN:*`), so reports and the
  impact page stay correct;
- a matching pool, a settled withdrawal, a circle, notifications and 14 days of platform
  stats (`PlatformStatDaily`).

For production this is optional and usually unnecessary - the platform works with a clean
database, and the first real admin can be created by promoting a registered user. If you
do seed production (e.g. to have content ready for review):

```bash
# From your workstation, using the EXTERNAL connection string
cd backend
SEED_ADMIN_PASSWORD='<strong-unique-password>' \
DATABASE_URL='postgresql://kindora:<password>@<external-host>.render.com:5432/kindora?sslmode=require' \
npm run prisma:seed
```

Then immediately:

1. **Change the admin password.** The seed logs `Admin login: admin@kindora.com (password
   from SEED_ADMIN_PASSWORD)`. There is NO default administrator password (v1.0.14
   completion patch §9 removed the historical fixed credential): the seed REFUSES to run
   unless a strong `SEED_ADMIN_PASSWORD` is supplied. Rotate the value after handover
   and never reuse it across environments.
2. **Delete seed campaigns if unwanted** via the admin console. Their ledger entries are
   balanced and labelled with `SEED` references, so keeping or removing them is a content
   decision - but do the decision **before** opening donations so counters start clean.
3. Seed **before** public launch, never while real donations are flowing.

## 6. Connection pooling notes

- Prisma maintains a per-process connection pool sized relative to the machine
  (see https://www.prisma.io/docs/orm/prisma-client/setup/databases-connections).
  `DATABASE_URL` connects the pool directly to PostgreSQL; KINDORA does not use PgBouncer.
- Multiple processes share the one database: the API, the worker and six cron jobs each
  hold their own small pool. Cron scripts are short-lived (connect, run, disconnect), so
  steady-state load is API + worker.
- Rule of thumb: keep (instances x pool size) comfortably below the plan's max connections.
  If you scale the API horizontally or see pool-timeout errors, upgrade the DB plan before
  adding instances.
- Application code keeps transactions short (`$transaction` blocks; ledger postings run
  inside single transactions), which keeps pool occupancy low.

## 7. Indexes overview

The schema is indexed for its hot paths (selection from `backend/prisma/schema.prisma`):

| Area | Indexes |
| --- | --- |
| Identity | `User(email) unique + @@index`, `User(status)`; `Session(tokenHash) unique`, `Session(userId)`; `AuthToken(userId, purpose)`, `tokenHash unique` |
| Donations | `Donation(campaignId, status)`, `Donation(donorUserId)`, `Donation(createdAt)`, `Donation(status)`; `publicRef unique` |
| Webhooks | `WebhookEvent(provider, eventId) unique` (duplicate detection), `reference`, `(status, createdAt)` |
| Recurring | `RecurringDonation(nextChargeAt, status)` - the cron's `WHERE nextChargeAt <= now AND status='ACTIVE'` scan |
| Withdrawals | `Withdrawal(campaignId, status)`, `Withdrawal(status)` |
| Ledger | `LedgerAccount(code) unique`, `(campaignId)`; `LedgerTransaction(reference) unique` (exactly-once postings); `LedgerEntry(accountId)`, `(transactionId)` |
| Campaigns | `(status, isFeatured)`, `categoryId`, `createdById`, `organizationId`, `country`, `createdAt` |
| Ops tables | `FraudSignal(status, severity)`, `Notification(userId, readAt)/(userId, createdAt)`, `AuditLog(createdAt)/(entityType, entityId)`, `EmailLog(to, createdAt)`, `IdempotencyKey(key) unique`, `MatchingPool(campaignId, status)` |
| Stats | `CampaignStatDaily`, `PlatformStatDaily` (per-date rows, upserted by analytics jobs) |

The weekly `kindora-database-maintenance` cron keeps transient tables
(`AuthToken`, `Session`, `IdempotencyKey`, `WebhookEvent`, `EmailLog`) lean so these
indexes stay effective ([CRON_JOBS.md](CRON_JOBS.md)).

## 8. Backups (policy pointer)

The schema contains the double-entry ledger - backups are mandatory, not optional:

1. Render Dashboard -> `kindora-db` -> **Backups**: enable automated backups /
   point-in-time recovery (paid plans) and note the retention window.
2. Take a manual `pg_dump` at launch and after any significant schema/data milestone:

   ```bash
   pg_dump "postgresql://kindora:<password>@<external-host>.render.com:5432/kindora?sslmode=require" \
     -Fc -f "kindora-$(date +%F).dump"
   ```

3. Verify restorability (an untested backup is not a backup) and store dumps outside the
   database provider's infrastructure.

Full backup/restore procedures, RPO/RTO guidance and the disaster-recovery runbook:
[BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).

## 9. Monitoring

| Signal | Where | Action on anomaly |
| --- | --- | --- |
| `GET /api/v1/health/database` | Uptime monitor | 503 => migrations not run or DB unreachable; check the deploy log first |
| Connection count / latency | Render database metrics | Sustained growth => review pool sizing and slow queries; upgrade plan before scaling instances |
| Disk usage | Render database metrics | Grow the plan before the disk fills |
| Migration failures | API deploy log (`preDeployCommand`) | Fix with `prisma migrate resolve` / a forward-fix migration ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)) |
| Slow queries | Application logs, Sentry | Index or split the query; keep transactions short |

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) | [REDIS_SETUP.md](REDIS_SETUP.md) | [CRON_JOBS.md](CRON_JOBS.md)
