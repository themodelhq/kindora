# Local Development

The daily development loop for KINDORA: environment setup per package, migrations, seeding,
ports, optional Redis, the mock payment provider, testing and lint commands, and demo mode.

Assumes you completed [INSTALLATION.md](INSTALLATION.md).

Related: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [DATABASE_SETUP.md](DATABASE_SETUP.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## 1. Daily workflow

```bash
# 0. One-time (or after reboot): start the local datastores
docker start kindora-postgres kindora-redis

# 1. Pull the latest code
git pull --rebase

# 2. If backend/prisma/migrations changed
cd backend && npx prisma migrate deploy && npx prisma generate

# 3. Run the three processes (three terminals)
cd backend  && npm run start:dev      # API      http://localhost:10000
cd frontend && npm run dev            # Frontend http://localhost:3000
cd workers  && npm run build && npm run start:dev   # Workers (requires REDIS_URL)

# 4. Branch, commit, push; CI runs on push/PR (see GITHUB_ACTIONS.md)
```

## 2. Environment files and ports

| File | Package | Created from |
| --- | --- | --- |
| `backend/.env` | API | `backend/.env.example` |
| `frontend/.env` | PWA | `frontend/.env.example` |
| `workers/.env` | Worker + cron scripts | `workers/.env.example` |

`.env` files are git-ignored; every variable is documented in
[ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md).

Local port map (source of truth in the repo):

| Service | Port | Source |
| --- | --- | --- |
| API | `10000` | `PORT=10000` in `backend/.env.example`; default in `backend/src/main.ts` |
| Frontend dev server | `3000` | `frontend/vite.config.ts` (`server.port: 3000`, `preview.port: 3000`) |
| PostgreSQL | `5432` | Standard; the Docker container in INSTALLATION.md maps 5432 |
| Redis | `6379` | Standard; the Docker container in INSTALLATION.md maps 6379 |

Important local override: `backend/.env.example` ships `FRONTEND_URL=http://localhost:5173`
and `CORS_ORIGINS=http://localhost:5173,...`. Because the Vite dev server listens on 3000,
set in your local `backend/.env`:

```env
FRONTEND_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

CORS matters twice: for API requests from the browser, and for the `Origin` check the API
performs on `POST /api/v1/auth/refresh` and `POST /api/v1/auth/logout`
(`assertOrigin` in `backend/src/auth/auth.controller.ts` rejects origins not listed in
`CORS_ORIGINS`).

## 3. Migrations: `prisma migrate dev` vs `prisma migrate deploy`

| Command | Use when | What it does |
| --- | --- | --- |
| `npx prisma migrate dev --name <name>` | You changed `prisma/schema.prisma` and need a new migration | Diffs the schema against the shadow database, writes `prisma/migrations/<timestamp>_<name>/migration.sql`, applies it, regenerates the client |
| `npx prisma migrate deploy` (`npm run prisma:deploy`) | You pulled commits that added migrations, or you are deploying | Applies every pending committed migration exactly once, in order; never resets or destructively edits the database |

Production only ever runs `migrate deploy` (the Render `preDeployCommand`). Follow the
backward-compatible expand/backfill/contract pattern when authoring migrations so deploys
stay safe while the old release still serves traffic
([DATABASE_SETUP.md](DATABASE_SETUP.md)).

## 4. Seeding and the admin account

```bash
cd backend && npm run prisma:seed
```

The seed is idempotent (upserts by email/slug). It creates:

- Users: `admin@kindora.com` (role ADMIN), `organizer@kindora.com`, `donor@kindora.com`
- 12 campaign categories (education, health, water, environment, emergency, children,
  community, animals, sports, arts, tech, housing)
- A verified organization (Habab Water Initiative) and six sample campaigns, one USD
- Ledger-consistent donation history (every seeded donation posts a balanced
  double-entry transaction), a matching pool, a settled withdrawal, a circle,
  notifications and 14 days of platform stats

Admin login:

| Email | Password |
| --- | --- |
| `admin@kindora.com` | the value of `SEED_ADMIN_PASSWORD` from `backend/.env` (no default exists — seeding refuses without it) |

**Change the password.** `SEED_ADMIN_PASSWORD` is required before seeding — no default
password exists (the historical fixed credential was removed in the v1.0.14 completion
patch). Password rules: at least 10 characters, one uppercase letter, one digit. Never
reuse a development password on any shared, screenshot-published, or internet-reachable
database. For production guidance see [DATABASE_SETUP.md](DATABASE_SETUP.md).

## 5. Redis: optional locally

- **API without `REDIS_URL`:** boots normally. `QueueService.enqueue` logs
  `[inline-drop] <queue>.<job> (REDIS_URL not configured) data=...` and returns - emails,
  push, analytics, media, fraud scoring, reconciliation and recurring cycles simply do not
  run. Caching and distributed locks are disabled (the `RedisService` reports
  `availability=false` and its get/set/lock calls become no-ops).
  `GET /api/v1/health/redis` then returns `503 {"status":"degraded","component":"redis","configured":false}`.
- **Worker without `REDIS_URL`:** refuses to start
  (`FATAL: REDIS_URL is not set. KINDORA workers consume BullMQ queues and take Redis locks;
  the process cannot start without Redis.`) and exits 1.

For donation-flow work without Redis this is acceptable; for testing emails, analytics or
cron scripts, run Redis locally (`REDIS_URL=redis://localhost:6379`) as described in
[REDIS_SETUP.md](REDIS_SETUP.md).

## 6. `PROVIDER_MODE=mock`: offline donation flows

`PROVIDER_MODE` selects the payment adapter set
(`backend/src/payments/payments.service.ts`):

| Value | Behaviour |
| --- | --- |
| `live` (default) | Real HTTP calls to Paystack, Flutterwave, Stripe and PayPal; a provider without its secret key reports `enabled: false` |
| `mock` | Every adapter is swapped for the deterministic in-process `MockProviderService` |

In mock mode:

- `initialize` returns a redirect straight back to your callback URL with
  `mock=1&reference=<publicRef>` - no network, no provider keys needed.
- `verify` always reports `succeeded` with zero fee; webhook verification accepts any JSON
  body carrying a `reference`.
- The full money path still runs for real: donation -> guarded `PENDING -> SUCCEEDED`
  transition -> double-entry ledger posting -> campaign counters -> matching pool ->
  notifications. This is exactly what CI's integration job exercises
  (`PROVIDER_MODE: mock` in `.github/workflows/ci.yml`).
- In the workers, `fraud.score-donation` skips scoring when `PROVIDER_MODE=mock`.

Rules:

1. Use `PROVIDER_MODE=mock` for offline development and tests.
2. **Never enable mock mode in production** - it marks every donation as succeeded with zero
   fees. `render.yaml` pins `PROVIDER_MODE=live` for deployed services.
3. The frontend is unchanged - it only ever sees redirect URLs and status polls.

To exercise a real provider sandbox locally instead, set `PROVIDER_MODE=live` plus that
provider's test keys in `backend/.env` ([PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md)).

### 6.1 End-to-end mock donation walkthrough

1. Ensure `PROVIDER_MODE=mock` in `backend/.env` and the API is running.
2. Donate on any campaign at `http://localhost:3000`.
3. The mock "provider" redirects back to `/donate/status?ref=KDO-...`; the status page polls
   `GET /api/v1/donations/status/MOCK/KDO-...`, which reports succeeded.
4. Confirm the balanced ledger transaction in the admin transactions view (admin login from
   section 4), and a `WebhookEvent` row if you POST a mock webhook.

## 7. Testing commands

| Package | Command | What it runs |
| --- | --- | --- |
| backend | `npm test` | Jest (all `*.spec.ts`, excluding `test/`) |
| backend | `npm run test:unit` | Unit tests only (ledger, payments, auth, money) |
| backend | `npm run test:integration` | `RUN_INTEGRATION=1 jest --runInBand --config test/jest-e2e.json` - full money path via supertest against a real PostgreSQL (`DATABASE_URL` must point at a disposable database) |
| backend | `npm run test:cov` | Jest with coverage |
| frontend | `npm test` / `npm run test:watch` | Vitest unit tests (`tests/unit/`) |
| frontend | `npm run e2e` | Playwright tests against a **demo build** (`VITE_DEMO_MODE=1`, exactly like CI) |
| workers | `npm run typecheck` | Typecheck without emitting |

Integration tests need a PostgreSQL they may reset - use a dedicated database (CI uses
`kindora_test` on a `postgres:16` container), never your seeded dev database if you care
about its contents.

## 8. Lint and format commands

| Package | Command | Purpose |
| --- | --- | --- |
| backend | `npm run lint` | ESLint with `--fix` over `{src,test}/**/*.ts` |
| backend | `npm run lint:check` | ESLint check only (CI runs this non-blocking, `|| true`) |
| backend | `npm run format` | Prettier over `src/**/*.ts` |
| frontend | `npm run lint` | ESLint over `src` (`--max-warnings 200`) |
| workers | `npm run lint:check` | ESLint over the package |
| all | `npm run typecheck` | `tsc --noEmit` (hard CI gate) |

## 9. Demo mode (`VITE_DEMO_MODE=1`)

Demo mode is a **frontend-only** switch: `frontend/src/lib/demo/adapter.ts` checks
`import.meta.env.VITE_DEMO_MODE === '1' || ... === 'true'` and, when enabled, intercepts the
API layer so the app renders simulated data from an in-memory adapter
(`frontend/src/lib/demo/data.ts`) instead of calling the backend.

What it is for:

- Offline UI previews and design work without a running API.
- The Playwright e2e suite: CI builds the frontend with `VITE_DEMO_MODE=1` and runs
  `npm run e2e` against it (`ci.yml`, `e2e` job, pull requests only).

What it is not:

- It is **not** a staging environment: nothing is stored, no real money moves, uploads are
  disabled, and the data is fake.

Warning: **`VITE_DEMO_MODE` must never be set in production.** A demo build looks fully
functional while persisting nothing; a visitor donating on a demo deployment would see
success screens backed by no data. Keep the variable unset/empty in Netlify's production
and `develop` deploy contexts (only the local `.env` and the CI e2e job set it), and verify
before go-live with the check in [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).
`VITE_` variables are compile-time constants - changing them requires a rebuild/redeploy.

## 10. Hot reload notes

| Package | Command | Mechanism |
| --- | --- | --- |
| backend | `npm run start:dev` | `nest start --watch` - recompiles and restarts on change |
| frontend | `npm run dev` | Vite dev server with HMR on port 3000 |
| workers | `npm run start:dev` | `ts-node src/index.ts` - no watch; restart manually after edits |

- `frontend/.env` is read at dev-server start; restart Vite after editing it.
- Only `VITE_`-prefixed variables reach the browser bundle.
- The API serves JSON only; `main.ts` configures Helmet with CSP disabled for the API
  (CSP is enforced at the Netlify edge instead).

## 11. Running cron scripts locally

Cron scripts are built outputs (`dist/cron/*.js`), so build first:

```bash
cd workers && npm run build && npm run cron:daily-analytics
```

Available scripts (see [CRON_JOBS.md](CRON_JOBS.md) for behaviour and schedules):

`cron:daily-analytics`, `cron:campaign-reminders`, `cron:recurring-donations`,
`cron:weekly-reports`, `cron:db-maintenance`, `cron:reconciliation-digest` (alias
`cron:reconciliation`). Each script needs `DATABASE_URL` (and `REDIS_URL` for the
distributed lock `kindora:lock:cron:<name>`); without Redis available the lock call
returns null and the script may run concurrently - acceptable locally, never in production.

## 12. Troubleshooting (quick)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Browser console CORS error against `http://localhost:10000` | `CORS_ORIGINS` in `backend/.env` does not include port 3000 | Set `CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000`, restart API |
| `POST /api/v1/auth/refresh` -> 401 "Origin not allowed" | Same as above - refresh/logout check the `Origin` header | Same fix |
| Worker exits immediately: `FATAL: REDIS_URL is not set` | `workers/.env` missing/empty `REDIS_URL` | Set `REDIS_URL=redis://localhost:6379` |
| `health/database` returns 503 | Postgres not running or `DATABASE_URL` wrong | Start the container, verify the URL |
| Donation never completes in mock mode | Frontend pointing at the wrong API | `frontend/.env` must set `VITE_API_URL=http://localhost:10000`; restart Vite |
| `TypeError: Do not know how to serialize a BigInt` in your own scripts | `JSON.stringify` on BigInt | Use `String(value)`; the API has a global BigInt serializer interceptor |

More: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

Related: [INSTALLATION.md](INSTALLATION.md) | [DATABASE_SETUP.md](DATABASE_SETUP.md) | [REDIS_SETUP.md](REDIS_SETUP.md) | [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md)
