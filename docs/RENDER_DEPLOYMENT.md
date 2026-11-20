# Render Deployment (API, Database, Redis, Worker, Crons)

Provision the KINDORA backend on Render from the committed Blueprint: the NestJS API,
PostgreSQL, the Redis-compatible Key Value service, the BullMQ background worker and six
cron jobs. Blueprint reference: https://render.com/docs/blueprint-spec

Everything in this document comes from `render.yaml` at the repository root, plus
`backend/package.json`, `workers/package.json`, `backend/src/main.ts` and
`backend/src/health/health.controller.ts`.

Related: [DATABASE_SETUP.md](DATABASE_SETUP.md) | [REDIS_SETUP.md](REDIS_SETUP.md) | [CRON_JOBS.md](CRON_JOBS.md) | [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)

---

## 1. Blueprint deploy flow

`render.yaml` defines the full stack. Deploy it like this:

1. Push the repository to GitHub (Render connects to a GitHub repo).
2. Render Dashboard -> **New** -> **Blueprint** -> select the repository and the branch
   (use `main` for production).
3. Render parses `render.yaml` and lists the resources it will create (section 2).
4. Fill the `sync: false` secrets when prompted (section 4). Secrets are entered in the
   dashboard and never committed.
5. Apply. Render builds each Node service with its `buildCommand`, runs the API's
   `preDeployCommand`, and starts everything with its `startCommand`.

`autoDeploy: true` on the web service and worker means every push to the Blueprint branch
deploys automatically - gate pushes with CI ([GITHUB_ACTIONS.md](GITHUB_ACTIONS.md)).

## 2. Resources created by the Blueprint

| Resource | Type | Plan | Root dir | Key settings from render.yaml |
| --- | --- | --- | --- | --- |
| `kindora-api` | web service (Node) | `starter` | `backend` | build `npm ci && npm run build`; pre-deploy `npx prisma migrate deploy`; start `npm run start:prod`; health check `/api/v1/health`; `NODE_ENV=production`; `PROVIDER_MODE=live` |
| `kindora-db` | PostgreSQL | `basic-256mb` | - | database name `kindora`, user `kindora` |
| `kindora-redis` | Key Value (Redis-compatible) | `starter` | - | `maxmemoryPolicy: noeviction` |
| `kindora-worker` | background worker (Node) | `starter` | `workers` | build `npm ci && npm run build`; start `npm run start:prod`; `NODE_ENV=production` |
| `kindora-daily-analytics` | cron | - | `workers` | schedule `30 2 * * *`; start `node dist/cron/daily-analytics.js` |
| `kindora-campaign-reminders` | cron | - | `workers` | schedule `5 * * * *`; start `node dist/cron/campaign-reminders.js` |
| `kindora-recurring-donations` | cron | - | `workers` | schedule `*/15 * * * *`; start `node dist/cron/recurring-donations.js` |
| `kindora-weekly-reports` | cron | - | `workers` | schedule `0 7 * * 1`; start `node dist/cron/weekly-reports.js` |
| `kindora-database-maintenance` | cron | - | `workers` | schedule `0 3 * * 0`; start `node dist/cron/db-maintenance.js` |
| `kindora-reconciliation-digest` | cron | - | `workers` | schedule `0 4 * * *`; start `node dist/cron/reconciliation-digest.js` |

Cron schedules and behaviour: [CRON_JOBS.md](CRON_JOBS.md). Worker queue matrix:
[BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md).

Wired automatically by the Blueprint (no manual entry):

- `DATABASE_URL` on the API, worker and all six crons comes from the `kindora-db` database
  (`fromDatabase: { name: kindora-db, property: connectionString }`).
- `REDIS_URL` on the API, worker and all six crons comes from the `kindora-redis`
  Key Value service (`fromService: { type: keyvalue, name: kindora-redis, property: connectionString }`).
- `JWT_SECRET` and `SESSION_SECRET` on the API are generated with `generateValue: true`.

## 3. Static environment values set by the Blueprint

| Service | Key | Value |
| --- | --- | --- |
| API / worker / crons | `NODE_ENV` | `production` |
| API | `PROVIDER_MODE` | `live` |
| API | `PLATFORM_FEE_PERCENT` | `0` (tip-based model, no platform fee) |
| API | `STORAGE_REGION` | `us-east-1` (override to your provider's region) |
| API | `STORAGE_FORCE_PATH_STYLE` | `true` |
| API / worker / weekly-reports / reconciliation-digest crons | `SMTP_PORT` | `587` |
| API | `PAYPAL_ENV` | `sandbox` (**set `live` when going live with PayPal**) |

## 4. `sync: false` secrets you are prompted for

These variables are intentionally blank in `render.yaml`; Render prompts for them at
deploy time. Complete each service's list:

**kindora-api**

| Variable | Source |
| --- | --- |
| `FRONTEND_URL` | Your frontend URL, e.g. `https://kindora.com` |
| `BACKEND_URL` | Your API URL, e.g. `https://api.kindora.com` |
| `CORS_ORIGINS` | Comma-separated exact browser origins, e.g. `https://kindora.com,https://www.kindora.com` |
| `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_PUBLIC_BASE_URL` | S3-compatible provider - [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS` | Your SMTP provider - [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) |
| `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` | Provider dashboards - [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` |
| `AI_PROVIDER_API_KEY`, `AI_PROVIDER_BASE_URL`, `AI_PROVIDER_MODEL` | Any OpenAI-compatible endpoint (optional) |
| `SENTRY_DSN` | Sentry project (optional) |

**kindora-worker**

| Variable | Source |
| --- | --- |
| `FRONTEND_URL` | `https://kindora.com` (links in emails and push) |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS` | Same SMTP provider as the API |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Same VAPID keys as the API |
| `ADMIN_EMAILS` | Comma-separated admin addresses for digests and alerts |

**kindora-campaign-reminders**

| Variable | Source |
| --- | --- |
| `FRONTEND_URL` | `https://kindora.com` (links inside reminder notifications) |

**kindora-weekly-reports** and **kindora-reconciliation-digest**

| Variable | Source |
| --- | --- |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS` | Same SMTP provider |
| `ADMIN_EMAILS` | Comma-separated admin addresses receiving the weekly report / reconciliation digest |

**kindora-daily-analytics**, **kindora-recurring-donations**, **kindora-database-maintenance**

No `sync: false` variables - `NODE_ENV`, `DATABASE_URL` and `REDIS_URL` are wired by the
Blueprint.

Secret rules: values live only in service environment variables; never commit them, never
put them in `VITE_` variables. Full reference: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md).

## 5. Migrations on deploy

The API service declares:

```yaml
preDeployCommand: npx prisma migrate deploy
```

Before each new release takes traffic, Render runs the committed Prisma migrations from
`backend/prisma/migrations/` exactly once, in order, recorded in `_prisma_migrations`.
Migrations must therefore stay backward-compatible (expand -> backfill -> contract): during
a deploy the old release may still serve requests against the new schema. Details and the
authoring pattern: [DATABASE_SETUP.md](DATABASE_SETUP.md).

The worker and the cron jobs do **not** run migrations; they generate the Prisma client at
build time (workers' `postinstall`/`generate` script) and read the schema the API's
pre-deploy step applied.

## 6. Health check and endpoints

Render pings `healthCheckPath: /api/v1/health` and restarts unhealthy instances. The
endpoints (from `backend/src/health/health.controller.ts`):

| Endpoint | Behaviour |
| --- | --- |
| `GET /api/v1/health` | Liveness. Never touches external systems: returns `{status: "ok", service: "kindora-api", version, uptimeSeconds, timestamp}` |
| `GET /api/v1/health/database` | Runs `SELECT 1`; `200 {"status":"ok","component":"database"}` or `503 {"status":"degraded",...}` (never exposes connection details) |
| `GET /api/v1/health/redis` | Redis `PING`; `200` when reachable, `503 {"status":"degraded","component":"redis","configured":true\|false}` otherwise |

Verify after the first deploy:

```bash
curl -i https://api.kindora.com/api/v1/health
curl -i https://api.kindora.com/api/v1/health/database
curl -i https://api.kindora.com/api/v1/health/redis
```

`/health/database` returning 503 usually means migrations have not run or the database is
unreachable - check the deploy log for the `preDeployCommand` output first.

## 7. Custom domain api.kindora.com

1. `kindora-api` service -> **Settings -> Custom Domains -> Add Custom Domain**:
   `api.kindora.com`.
2. At your DNS provider add `CNAME api -> <your-render-service>.onrender.com`
   (Render shows the exact target on the custom domain page).
3. Render verifies DNS and issues the TLS certificate automatically.
4. Update the places that reference the API domain: `VITE_API_URL` (Netlify),
   `BACKEND_URL` (API + digests), `CORS_ORIGINS`, the CSP `connect-src` in
   `frontend/netlify.toml`, and the payment webhook URLs
   ([DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md),
   [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md)).

Keep the `onrender.com` URL as a fallback for smoke tests; production configuration should
use `api.kindora.com` everywhere.

## 8. Free vs paid plans (important for a money platform)

The Blueprint ships `starter` plans. The `render.yaml` header note applies verbatim:
**free plans sleep and lack production persistence.**

| Consequence of free plans | Why it matters |
| --- | --- |
| Free web services sleep after inactivity | A sleeping API misses provider webhooks and cannot serve the donation status poll - donations stall in `PENDING` |
| Free plans lack persistence guarantees | Not acceptable for a ledger-backed financial platform |
| Free PostgreSQL has no automated backups/PITR | The ledger is authoritative; backups are mandatory ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)) |

Recommendations:

- `kindora-api`: paid plan (starter or higher) - always-on.
- `kindora-worker`: paid plan - queue consumers are inherently always-on.
- `kindora-db`: `basic-256mb` or larger on a paid tier; enable automated backups/PITR.
- Cron jobs: they run on schedule; confirm current cron billing at https://render.com/docs.

## 9. Manual service creation (alternative to the Blueprint)

If you prefer to create services by hand, replicate exactly what the Blueprint encodes:

**Database (`kindora-db`, PostgreSQL)**

- Database name `kindora`, user `kindora`, plan `basic-256mb`, same region as the services.
- Copy the **internal** connection string into `DATABASE_URL` for co-located services
  ([DATABASE_SETUP.md](DATABASE_SETUP.md)).

**Redis (`kindora-redis`, Key Value)**

- Plan `starter`; set `maxmemory_policy` to `noeviction`
  ([REDIS_SETUP.md](REDIS_SETUP.md)).

**API (`kindora-api`, Web Service, runtime Node)**

- Root directory: `backend`
- Build command: `npm ci && npm run build`
- Pre-deploy command: `npx prisma migrate deploy`
- Start command: `npm run start:prod` (runs `node dist/main.js`)
- Health check path: `/api/v1/health`
- Auto-deploy: yes
- Environment: `NODE_ENV=production`, `PROVIDER_MODE=live`, `PLATFORM_FEE_PERCENT=0`,
  `JWT_SECRET` and `SESSION_SECRET` (generate long random values), plus everything in
  section 4.

**Worker (`kindora-worker`, Background Worker, runtime Node)**

- Root directory: `workers`
- Build command: `npm ci && npm run build`
- Start command: `npm run start:prod` (runs `node dist/index.js`)
- Environment: `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL` (mandatory - the worker
  exits without it), `FRONTEND_URL`, SMTP set, `EMAIL_FROM_ADDRESS`, VAPID keys,
  `ADMIN_EMAILS`.

**Cron jobs (six Cron Job services, runtime Node, root directory `workers`)**

- Build command: `npm ci && npm run build`
- Start commands and schedules:

| Cron | Schedule | Start command |
| --- | --- | --- |
| kindora-daily-analytics | `30 2 * * *` | `node dist/cron/daily-analytics.js` |
| kindora-campaign-reminders | `5 * * * *` | `node dist/cron/campaign-reminders.js` |
| kindora-recurring-donations | `*/15 * * * *` | `node dist/cron/recurring-donations.js` |
| kindora-weekly-reports | `0 7 * * 1` | `node dist/cron/weekly-reports.js` |
| kindora-database-maintenance | `0 3 * * 0` | `node dist/cron/db-maintenance.js` |
| kindora-reconciliation-digest | `0 4 * * *` | `node dist/cron/reconciliation-digest.js` |

(The `workers` package also exposes npm aliases - `npm run cron:daily-analytics` etc. -
which invoke the same `dist/cron/*.js` scripts.)

## 10. First-deploy checklist

- [ ] Blueprint applied; API, worker and all six crons show `Live`; DB and Redis available
- [ ] All `sync: false` variables filled on API, worker and the crons that need them
- [ ] `npx prisma migrate deploy` ran green via the pre-deploy command (check the API deploy log)
- [ ] `curl https://api.kindora.com/api/v1/health` -> 200
- [ ] `curl https://api.kindora.com/api/v1/health/database` -> 200
- [ ] `curl https://api.kindora.com/api/v1/health/redis` -> 200 with `"configured":true`
- [ ] Worker boot log shows `[worker] redis connection verified` and
      `[worker] online — queues: email, push, notifications, analytics, media, fraud, payments, reports`
- [ ] Custom domain `api.kindora.com` serving with a valid certificate
- [ ] `CORS_ORIGINS` contains the exact production frontend origins (no localhost)
- [ ] `PROVIDER_MODE=live` on the API (mock is dev/test-only)
- [ ] Payment webhooks registered against
      `https://api.kindora.com/api/v1/payments/<provider>/webhook`
      ([PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md))
- [ ] Database seeded only if intended, admin password changed
      ([DATABASE_SETUP.md](DATABASE_SETUP.md))
- [ ] Paid plans confirmed; automated backups enabled on the database

## 11. Deploy flow and rollback

- Every push to the Blueprint branch auto-deploys (`autoDeploy: true`). CI should be green
  first - enable branch protection on `main` ([GITHUB_ACTIONS.md](GITHUB_ACTIONS.md)).
- Manual deploy: service -> **Manual Deploy -> Deploy latest commit**.
- Rollback: service -> **Events** -> roll back to a previous deploy. For database-related
  incidents also read [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) (including
  `prisma migrate resolve` guidance). Code rollbacks do not roll back migrations - follow
  the expand/contract discipline in [DATABASE_SETUP.md](DATABASE_SETUP.md).

Related: [DATABASE_SETUP.md](DATABASE_SETUP.md) | [REDIS_SETUP.md](REDIS_SETUP.md) | [CRON_JOBS.md](CRON_JOBS.md) | [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)
