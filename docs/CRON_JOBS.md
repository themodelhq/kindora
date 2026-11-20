# Cron Jobs

The six scheduled jobs KINDORA runs as Render Cron Jobs, their schedules exactly as
defined in `render.yaml`, what each does, and the idempotency mechanisms that make them
safe to re-run or overlap.

Code references: `workers/src/cron/*.ts`, `workers/src/lib/redis.ts` (locks),
`workers/src/lib/env.ts` (`adminEmails`, `frontendUrl`), `render.yaml`.

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | [REDIS_SETUP.md](REDIS_SETUP.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## 1. Overview (schedules from render.yaml)

All six are Cron Job services with `rootDir: workers`, build command
`npm ci && npm run build`, and start commands `node dist/cron/<script>.js`. Every cron
also gets `NODE_ENV=production`, `DATABASE_URL` and `REDIS_URL` from the Blueprint.

| Cron service | Schedule | Meaning (UTC) | Start command | Extra env (sync: false) |
| --- | --- | --- | --- | --- |
| `kindora-daily-analytics` | `30 2 * * *` | Daily at 02:30 | `node dist/cron/daily-analytics.js` | none |
| `kindora-campaign-reminders` | `5 * * * *` | Hourly at minute 05 | `node dist/cron/campaign-reminders.js` | `FRONTEND_URL` |
| `kindora-recurring-donations` | `*/15 * * * *` | Every 15 minutes | `node dist/cron/recurring-donations.js` | none |
| `kindora-weekly-reports` | `0 7 * * 1` | Mondays at 07:00 | `node dist/cron/weekly-reports.js` | SMTP set (`SMTP_HOST`, `SMTP_PORT`=587, `SMTP_USER`, `SMTP_PASSWORD`), `EMAIL_FROM_ADDRESS`, `ADMIN_EMAILS` |
| `kindora-database-maintenance` | `0 3 * * 0` | Sundays at 03:00 | `node dist/cron/db-maintenance.js` | none |
| `kindora-reconciliation-digest` | `0 4 * * *` | Daily at 04:00 | `node dist/cron/reconciliation-digest.js` | SMTP set, `EMAIL_FROM_ADDRESS`, `ADMIN_EMAILS` |

Each script is self-contained (Prisma client + Redis lock, everything closed on exit) and
uses the npm script aliases `npm run cron:<name>` locally (`cron:reconciliation-digest`
also has a `cron:reconciliation` alias in `workers/package.json`).

## 2. Per-job detail

### 2.1 kindora-daily-analytics (02:30 UTC daily)

- **What it does**: completeness sweep - rebuilds **yesterday's** `PlatformStatDaily` row
  directly from the authoritative `Donation` rows: count/sum grouped by actual currency
  (falls back to the existing row's currency, then the default), then upserts it.
  `newUsers` / `newCampaigns` are owned by other processes and preserved.
- **Idempotency**: the upsert overwrites the donation counters for the day - running it
  twice for the same date produces the same result.
- **Duplicate safety**: a missed run leaves one stale day; the Redis lock only prevents
  concurrent runs. Re-running manually after an outage is always safe.

### 2.2 kindora-campaign-reminders (hourly at :05)

- **What it does**: for ACTIVE campaigns whose deadline falls within the next 3 days,
  notifies the organizer **once per day** with (1) an in-app `Notification` row and
  (2) a `push.send` job on the push queue (email reminder jobs are also part of the
  email catalog). `FRONTEND_URL` builds the campaign links.
- **Idempotency**: the once-per-day guard is a durable `IdempotencyKey` row with
  key `campaign-reminder:<campaignId>:<YYYY-MM-DD>`, created **before** fanout; a unique
  violation (`P2002`) means today's reminder already went out and the campaign is skipped.
- **Duplicate safety**: hourly scheduling + the durable key = at most one reminder per
  campaign per day even if Render double-triggers or instances overlap (the Redis lock
  serializes whole runs). Trade-off documented in the script: if the process dies between
  key creation and fanout, that day's reminder is lost - at-most-once semantics for an
  advisory reminder.

### 2.3 kindora-recurring-donations (every 15 minutes)

- **What it does**: finds ACTIVE `RecurringDonation` schedules with
  `nextChargeAt <= now` (limit 100, oldest first) and, for each, creates one PENDING
  `Donation` from the schedule and advances the schedule (`nextChargeAt` by frequency,
  `chargeCount + 1`, `lastChargeAt`, `lastDonationId`) in a single transaction.
- **Idempotency (two layers)**:
  1. **Durable per-record lock via `IdempotencyKey`**:
     key = `recurring:<scheduleId>:<nextChargeAt.toISOString()>` (scope
     `recurring-donation-charge`, expires after 7 days). A unique violation means this
     cycle was already generated - skip. On transaction failure the key is deleted so the
     next run can retry the schedule.
  2. **Redis run lock**: `SET kindora:lock:cron:recurring-donations NX PX 600000`
     (10 min TTL) so two instances never process the same batch simultaneously.
- **Duplicate safety**: the key embeds the observed `nextChargeAt`, so the *next* cycle
  (after the schedule advanced) gets a fresh key; per-record locking means re-runs and
  overlaps cannot create two donations for one cycle.
- **Documented limitation**: this job does **not** charge the donor. Executing a charge
  against a stored authorization needs provider APIs (e.g. Paystack
  `transaction/charge_authorization` with the saved `providerAuthRef`) which live in the
  backend payment flow. Created donations stay `PENDING` for the provider flow (backend
  verifyStatus / provider webhook) to resolve - exactly like a checkout-initiated
  donation. Schedules without `providerAuthRef` are skipped with a warning.

### 2.4 kindora-weekly-reports (Mondays 07:00 UTC)

- **What it does**: computes the weekly platform summary (shared pipeline
  `src/lib/weekly-report.ts` - the same one the `report.weekly` queue job uses) and emails
  it to every address in `ADMIN_EMAILS`.
- **Idempotency**: the aggregation is a read-only snapshot; a re-run only re-sends an
  email.
- **Graceful degradation**: exits 0 with a warning when `ADMIN_EMAILS` is unset; in
  SMTP-less environments it records `SKIPPED_NO_SMTP` `EmailLog` rows.

### 2.5 kindora-database-maintenance (Sundays 03:00 UTC)

- **What it does**: purges expired/transient rows so indexes stay lean:
  - `AuthToken`: expired > 7 days ago (and consumed ones older than 7 days)
  - `Session`: expired > 30 days ago (and revoked ones older than 30 days)
  - `IdempotencyKey`: `expiresAt < now`
  - `WebhookEvent`: older than 90 days - but `FAILED` events are kept only 30 days
    (debug window, then purged)
  - `EmailLog`: older than 180 days
- **Idempotency**: `deleteMany` by timestamp conditions - running twice deletes nothing
  extra.
- **Run lock**: Redis `SET NX PX` with a 20-minute TTL, released (compare-and-delete Lua)
  on exit.

### 2.6 kindora-reconciliation-digest (daily 04:00 UTC)

- **What it does**: collects two operational counts and emails a digest to `ADMIN_EMAILS`:
  1. `WebhookEvent` rows with status `FAILED` created in the last 24 hours;
  2. stale `PENDING` donations (created more than 30 minutes ago on a live provider -
     `provider != MANUAL`).
- **No provider APIs are called and no state changes**: verifying live provider status is
  the backend verifyStatus flow's responsibility (webhook + `GET /donations/status/...`).
  When there is nothing to report the script logs an all-clear and sends nothing.
- **Idempotency / duplicate safety**: read-only reporting; the Redis lock (10 min TTL)
  prevents concurrent runs; a duplicate email is the worst case.

## 3. How the distributed lock works (all jobs)

Every cron script follows the same pattern (`workers/src/lib/redis.ts` + each script's
`main()`):

1. **Acquire**: `SET kindora:lock:cron:<name> <owner-token> NX PX <ttlMs>` - Redis SET
   with `NX` (only succeeds when the key does not exist) and a millisecond TTL. The owner
   token is unique per process/run. Failure means another instance holds the lock and the
   script **exits 0** ("lock held by another instance - exiting 0") - its work is being
   done elsewhere.
2. **Run** the work function (which itself uses durable `IdempotencyKey` rows where
   per-record dedupe matters, e.g. reminders and recurring cycles).
3. **Release**: compare-and-delete via Lua
   (`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`)
   so a stale owner can never free a live lock; otherwise the lock simply expires by TTL.
   Lock TTLs (10-20 minutes) comfortably exceed expected runtimes.
4. **Cleanup**: Prisma and Redis connections are always closed; errors log
   `[cron:<name>] failed after ...` and **exit 1** so Render marks the run failed.

Guarantees: at most one instance per job at a time; overlapping schedules never
double-execute; Render's occasional double-trigger of the same schedule is harmless.

### Why this makes the jobs duplicate-safe

| Layer | Mechanism | Protects against |
| --- | --- | --- |
| Redis `SET NX PX` run lock (`kindora:lock:cron:<name>`) | Only one execution at a time | Overlapping schedules, double triggers, manual + scheduled collision |
| Durable `IdempotencyKey` rows (unique key) | Per-entity exactly-once within a window | Re-runs after crashes, multi-instance races, retried cycles |
| Conditional DB state transitions (donation state machine, unique ledger references) | Exactly-once money application | Any residual duplication reaching the money path |

Without Redis available, `acquireLock` returns null and a script may run concurrently -
acceptable only on a laptop, never in production ([REDIS_SETUP.md](REDIS_SETUP.md)).

## 4. Changing schedules

Schedules live in `render.yaml` (`schedule:` per cron service) - the cron jobs are
Blueprint-managed:

1. Edit the `schedule` value of the relevant `kindora-*` service in `render.yaml`
   (standard 5-field cron expressions, evaluated in UTC).
2. Commit and push to the Blueprint branch; Render applies the change on the next
   blueprint sync (approve the sync if your project is set to ask).
3. Verify on the Render dashboard: open the cron job -> the schedule shows the new value.

Keep the lock TTL longer than the worst-case runtime when moving to more frequent
schedules (e.g. recurring-donations runs every 15 minutes with a 10-minute lock - if you
shorten the interval, verify runs complete well within it).

## 5. One-off manual runs

Options, from most to least controlled:

1. **Render dashboard**: open the cron job -> **Run now** - executes the start command on
   the current deploy; logs stream in the dashboard.
2. **Run the script against production data** from your workstation (uses the external
   `DATABASE_URL` + `REDIS_URL`; lock semantics still apply):

   ```bash
   cd workers
   npm ci && npm run build
   DATABASE_URL='postgresql://...?sslmode=require' \
   REDIS_URL='redis://...' \
   FRONTEND_URL='https://kindora.com' \
   npm run cron:daily-analytics
   ```

3. **Trigger the underlying queue job instead** where one exists (e.g. enqueue
   `payments.reconcile`, `analytics.recompute-day {date}`, or `report.weekly` directly) -
   useful when only the worker-side behaviour is needed.

Manual runs are always safe: the lock prevents overlap with a scheduled run, and every job
is idempotent by design (section 2).

## 6. Verification checklist

- [ ] All six crons show `Live`/scheduled on Render with the exact schedules from the
      table in section 1
- [ ] Each cron succeeded at least once (Render events show exit 0; logs show
      `[cron:<name>] done in ...ms`)
- [ ] A second concurrent/triggered run logs `lock held by another instance — exiting 0`
      or is skipped as expected (no duplicates)
- [ ] `kindora-weekly-reports` and `kindora-reconciliation-digest` delivered a test email
      to `ADMIN_EMAILS` (SMTP set, `EmailLog` rows created)
- [ ] `kindora-recurring-donations` skips schedules without `providerAuthRef` with clear
      warnings
- [ ] `kindora-database-maintenance` purges as expected (row counts drop in the targeted
      tables)

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | [REDIS_SETUP.md](REDIS_SETUP.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md)
