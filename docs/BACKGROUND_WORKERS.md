# Background Workers

The `workers/` package: structure, the full BullMQ queue/job matrix, retry and backoff
defaults, dead-letter monitoring, environment requirements, and scaling.

Deployed as ONE Render Background Worker (`kindora-worker`, root dir `workers`,
`npm run start:prod` -> `node dist/index.js`). The API (`kindora-api`) is the queue
**producer** (`backend/src/common/queue.service.ts`); the worker is the **consumer**.

Related: [REDIS_SETUP.md](REDIS_SETUP.md) | [CRON_JOBS.md](CRON_JOBS.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)

---

## 1. Package structure

```
workers/
├── prisma/schema.prisma          # Prisma schema the worker generates its client from
├── src/
│   ├── index.ts                  # entrypoint: boots one BullMQ Worker per queue
│   ├── lib/
│   │   ├── redis.ts              # REDIS_URL check (exits 1 if missing), ioredis singleton,
│   │   │                         #   SET NX PX locks (`kindora:lock:*`) + Lua release
│   │   ├── queues.ts             # QUEUES map + enqueue helper for cron scripts
│   │   ├── prisma.ts             # Prisma client singleton + disconnect
│   │   ├── env.ts                # frontendUrl(), backendUrl(), adminEmails()
│   │   ├── mailer.ts             # nodemailer SMTP sender (EmailLog rows)
│   │   ├── push.ts               # web-push VAPID sender
│   │   ├── templates.ts          # HTML email layout helpers
│   │   ├── weekly-report.ts      # shared weekly aggregation + email pipeline
│   │   ├── money.ts / format.ts / dayjs.ts / logger.ts
│   ├── cron/                     # six standalone cron scripts (see CRON_JOBS.md)
│   │   ├── daily-analytics.ts
│   │   ├── campaign-reminders.ts
│   │   ├── recurring-donations.ts
│   │   ├── weekly-reports.ts
│   │   ├── db-maintenance.ts
│   │   └── reconciliation-digest.ts
│   └── processors/               # one handler map per queue
│       ├── email.processor.ts
│       ├── push.processor.ts
│       ├── notifications.processor.ts
│       ├── analytics.processor.ts
│       ├── media.processor.ts    # honest stub (see STORAGE_CONFIGURATION.md section 6)
│       ├── fraud.processor.ts
│       ├── payments.processor.ts
│       └── reports.processor.ts
└── package.json                  # scripts: build, start:prod, typecheck, cron:*
```

Build (`npm run build`) runs `tsc -p tsconfig.json` -> `dist/`; the cron scripts run from
`dist/cron/*.js`. The worker generates its own Prisma client at install/build time
(`postinstall` / `generate` script). Runtime deps: `@prisma/client`, `bullmq`, `ioredis`,
`nodemailer`, `sharp`, `web-push`, `dayjs`.

## 2. Behaviour contract (workers/src/index.ts)

- **REDIS_URL is REQUIRED.** The process exits 1 without it (clear `FATAL:` message) and
  exits 1 if the initial `PING` fails ([REDIS_SETUP.md](REDIS_SETUP.md)).
- Unknown job names are acknowledged and dropped - a mismatched producer can never crash
  the consumer.
- Handler errors are logged and **rethrown** so BullMQ applies its retry/backoff policy.
- When the LAST attempt fails (`failed` with `attemptsMade >= attempts`), a
  `CRITICAL: ... permanently failed after N/N attempts — manual intervention required`
  line is logged for log-based alerting.
- SIGTERM/SIGINT drain all workers before exiting 0 (20 s shutdown timeout forces exit so
  Render redeploys never hang); queues, Prisma and Redis are closed.
- `unhandledRejection` is logged; `uncaughtException` exits 1.

## 3. Queue + job matrix

One `Worker` per queue, all in a single Node process. Concurrency per queue
(`WORKER_SPECS`):

| Queue | Concurrency | Jobs |
| --- | --- | --- |
| `email` | 5 | `email.receipt` / `email.donation-receipt`, `email.donation-organizer`, `email.verify-email`, `email.password-reset`, `email.campaign-approved`, `email.campaign-update`, `email.campaign-reminder`, `email.refund-processed`, `email.weekly-report`, `email.recurring-due` |
| `push` | 10 | `push.send` |
| `notifications` | 5 | `notifications.campaign-update` |
| `analytics` | 5 | `analytics.record-donation`, `analytics.recompute-day` |
| `media` | 2 | `media.process-image` |
| `fraud` | 5 | `fraud.score-donation` |
| `payments` | 3 | `payments.reconcile`, `webhook-retry` (passthrough), `recurring.charge-due` |
| `reports` | 2 | `report.generate {kind:'weekly'}`, `report.weekly` (alias) |

Producer defaults (`backend/src/common/queue.service.ts`) match the consumer-side policy.

### 3.1 Job details

| Job | Payload | Behaviour |
| --- | --- | --- |
| `email.*` | varies (`donationId`, `campaignId`, `token`, ...) | Sends via SMTP; every send persists an `EmailLog` row. With `SMTP_HOST` empty, emails are **skipped** with `EmailLog{status: SKIPPED_NO_SMTP}` and the job still succeeds |
| `push.send` | `{userId, title, body?, url?}` | Web Push via stored VAPID subscriptions; dead subscriptions are pruned |
| `notifications.campaign-update` | `{campaignId, updateId?, updateTitle}` | Creates in-app `Notification` rows for campaign supporters |
| `analytics.record-donation` | `{campaignId, donationId?, amountMinor, matchedMinor?, currency}` | Increments daily stat rows |
| `analytics.recompute-day` | `{date}` (`YYYY-MM-DD`) | Delete + rebuild `CampaignStatDaily`/`PlatformStatDaily` for that UTC day - idempotent |
| `media.process-image` | `{key, bucket?, url?, kind?}` | Honest stub: acknowledges, marks object `pending-external-processing` (no storage SDK in this package); non-image kinds skipped |
| `fraud.score-donation` | `{donationId, ip?}` | Advisory rules only - signals NEVER block money flow; one `FraudSignal` row per (donation, rule); **no-op when `PROVIDER_MODE=mock`** |
| `payments.reconcile` | `{}` | Lists stale `PENDING` donations (older than 30 minutes, provider != MANUAL, batch 200) and emails an ops digest to `ADMIN_EMAILS`; **read-only**, no provider calls, no state changes |
| `webhook-retry` | passthrough | Acknowledged with a warning - webhook processing is synchronous in the backend |
| `recurring.charge-due` | `{recurringDonationId, dueAt}` | Legacy: creates the PENDING cycle donation + advances the schedule in one transaction; skips when already charged for that due date. New cycles come from the `recurring-donations` cron |
| `report.generate` / `report.weekly` | `{kind:'weekly'}` | Weekly platform summary emailed to `ADMIN_EMAILS` (shared pipeline `src/lib/weekly-report.ts`) |

Fraud rules (advisory, `workers/src/processors/fraud.processor.ts`):
`donation_velocity` (MEDIUM - >= 5 PENDING/SUCCEEDED donations for one identity in 10
minutes), `large_first_donation` (HIGH - first donation on the campaign, > 2,000,000 minor
units or > 2000 major, within 1h of `publishedAt`), `duplicate_message` (LOW - >= 3
donations with the identical message). Request IPs/emails are masked in signal details.

## 4. Retry, backoff and dead-letter handling

Default job options (identical on producer and consumer):

| Option | Value |
| --- | --- |
| `attempts` | **5** |
| `backoff` | **exponential, delay 3000 ms** (3 s, 6 s, 12 s, 24 s, 48 s) |
| `removeOnComplete` | keep last 1000 |
| `removeOnFail` | keep last 5000 |

Notes:

- Handler exceptions are rethrown; BullMQ retries automatically.
- After the final attempt the job stays in the failed set (`bull:<queue>:failed`,
  capped at 5000) for inspection - this is the dead-letter store.
- Monitoring: worker logs emit `CRITICAL:` lines on permanent failures; queue depth can be
  inspected with `redis-cli`:

  ```bash
  redis-cli -u "$REDIS_URL" LLEN bull:email:waiting     # per-queue depth
  redis-cli -u "$REDIS_URL" LLEN bull:email:failed      # dead letters
  redis-cli -u "$REDIS_URL" ZCARD bull:email:delayed    # scheduled/delayed
  ```

- Alert when a waiting depth grows unbounded or `failed` climbs - usually a downstream
  outage (SMTP, storage, backend). Runbook: [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)
  (queue backlog section).

## 5. Environment requirements

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | Same PostgreSQL as the API (Blueprint-wired) |
| `REDIS_URL` | **Mandatory** - the worker exits without it ([REDIS_SETUP.md](REDIS_SETUP.md)) |
| `FRONTEND_URL` | Links inside emails and push (`workers/src/lib/env.ts`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM_ADDRESS` | Outbound email (`sendEmail` / `EmailLog`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web push (`push.send`) |
| `ADMIN_EMAILS` | Recipients for `payments.reconcile` digests, the weekly report and the reconciliation digest |
| `PROVIDER_MODE` | `live` in production; `mock` disables fraud scoring |

Full reference: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md). The Blueprint sets
`NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, and prompts for `FRONTEND_URL`, SMTP,
`EMAIL_FROM_ADDRESS`, VAPID keys and `ADMIN_EMAILS` on `kindora-worker`
([RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)).

## 6. Scaling

| Lever | How | When |
| --- | --- | --- |
| Worker plan (CPU/RAM) | Render dashboard -> `kindora-worker` -> plan | CPU-bound backlog |
| Concurrency | Per-queue numbers in `WORKER_SPECS` (`workers/src/index.ts`) | I/O-bound queues lagging (email 5, push 10, notifications 5, analytics 5, media 2, fraud 5, payments 3, reports 2) |
| More worker instances | Add a second background worker with the same env vars | Horizontal scale; BullMQ distributes jobs safely |
| Batch sizes | Batch constants in cron scripts / processors | Larger recurring sweeps |

Do not scale by scheduling more cron instances - cron locks
(`kindora:lock:cron:<name>`, [CRON_JOBS.md](CRON_JOBS.md)) ensure single execution, and
duplicate-safe semantics already cover overlaps.

## 8. Email job catalog (reference)

All email jobs persist an `EmailLog` row; with `SMTP_HOST` empty they are skipped with
`EmailLog{status: SKIPPED_NO_SMTP}` and the job still succeeds, so nothing re-drives
endlessly. Producers:

| Job | Enqueued by | Trigger |
| --- | --- | --- |
| `email.verify-email` | API auth service | New registration |
| `email.password-reset` | API auth service | Forgot-password request |
| `email.donation-receipt` | API donation state machine (post-commit) | Donation applied as SUCCEEDED (account donors) |
| `email.donation-organizer` | API donation state machine (post-commit) | Donation applied as SUCCEEDED |
| `email.campaign-approved` | API moderation flow | Campaign approved by admin |
| `email.campaign-update` | API campaign updates flow | Organizer posts an update |
| `email.campaign-reminder` | `kindora-campaign-reminders` cron | Deadline within 3 days (once per day per campaign) |
| `email.refund-processed` | API admin refund flow | Admin refund committed |
| `email.weekly-report` | Reports pipeline / weekly-reports cron | Weekly summary fanout to `ADMIN_EMAILS` |
| `email.recurring-due` | Legacy `recurring.charge-due` handler | Recurring cycle donation created |

## 9. Verification after deploy

- [ ] Worker shows `Live` on Render; boot log contains
      `[worker] redis connection verified` and
      `[worker] online — queues: email, push, notifications, analytics, media, fraud, payments, reports`
- [ ] A test donation produces: receipt email delivered (or a `SKIPPED_NO_SMTP` EmailLog
      row with SMTP on the fix list), `analytics.record-donation` completed,
      `fraud.score-donation` completed
- [ ] No `CRITICAL:` lines after the first hour of real traffic
- [ ] `ADMIN_EMAILS` set; the daily reconciliation digest (04:00 UTC) is deliverable

Related: [REDIS_SETUP.md](REDIS_SETUP.md) | [CRON_JOBS.md](CRON_JOBS.md) | [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
