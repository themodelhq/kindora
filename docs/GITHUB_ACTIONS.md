# GitHub Actions CI

What `.github/workflows/ci.yml` runs, the branch strategy that connects CI to the Netlify
and Render deployment flow, and how to roll back a bad release.

Workflow file: `.github/workflows/ci.yml` (name: `KINDORA CI`).

Related: [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [DATABASE_SETUP.md](DATABASE_SETUP.md) | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)

---

## 1. Triggers and concurrency

```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

CI runs on pushes to `main` and `develop` and on pull requests targeting them. The
per-ref concurrency group cancels superseded runs on the same branch, keeping Actions
minutes low.

All jobs use `actions/checkout@v4` and `actions/setup-node@v4` with `node-version: 22`
and npm caching keyed on the relevant `package-lock.json`
(`cache-dependency-path: frontend|backend/workers/package-lock.json`).

## 2. Jobs

| # | Job | Environment | Steps | Purpose |
| --- | --- | --- | --- | --- |
| 1 | **frontend** ("Frontend (build + tests)") | `ubuntu-latest`, Node 22, working dir `frontend` | `npm ci` -> `npm run lint:check || true` -> `npm run typecheck` -> `npm test` (vitest) -> `npm run build` -> upload the `frontend-dist` artifact (5-day retention) | Typecheck, unit tests and a real production build of the PWA (build includes `tsc --noEmit`) |
| 2 | **backend** ("Backend (build + unit tests)") | `ubuntu-latest`, Node 22, working dir `backend` | `npm ci` -> `npx prisma generate` -> `npm run lint:check || true` -> `npm run typecheck` -> `npm run test:unit` -> `npm run build` -> **validate migrations**: `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` | Typecheck, unit tests, compile, and confirm the schema/migration state is coherent |
| 3 | **backend-integration** ("Backend (integration, PostgreSQL)") | `ubuntu-latest` + **`postgres:16` service container** (`POSTGRES_USER: kindora`, `POSTGRES_PASSWORD: kindora`, `POSTGRES_DB: kindora_test`, port 5432, `pg_isready` health check) | `npm ci` -> `npx prisma generate` -> **`npx prisma migrate deploy`** -> `npm run test:integration` (supertest, `--runInBand`) | **Money-path tests against real PostgreSQL** with env `DATABASE_URL=postgresql://kindora:kindora@localhost:5432/kindora_test`, `JWT_SECRET=ci-test-secret`, `PROVIDER_MODE=mock`, `REDIS_URL=""`, `RUN_INTEGRATION=1` |
| 4 | **workers** ("Workers (build)") | `ubuntu-latest`, Node 22, working dir `workers` | `npm ci` -> `npm run typecheck` -> `npm run build` | Compile the worker package (Prisma client generated via the package's postinstall) |
| 5 | **e2e** ("E2E (demo build)") | `ubuntu-latest`, **only on `pull_request`**, `needs: frontend`, working dir `frontend` | `npm ci` -> `npx playwright install chromium --with-deps` -> `npm run build` -> `npm run e2e` with `VITE_DEMO_MODE: "1"` | Playwright smoke tests against the demo build (no backend needed) |

Notes:

- The `backend-integration` job is the gate that protects the ledger/donation code: it
  applies the **real committed migrations** to a fresh PostgreSQL 16 before testing the
  full money path (donation -> state machine -> ledger -> counters).
- Lint steps are non-blocking (`|| true`) - the hard gates are `typecheck`, tests, and
  `build`.
- CI itself needs **no secrets**: the frontend build uses public defaults, the
  integration job sets its mock/test env inline, and no payment keys, SMTP credentials or
  database secrets are involved. E2E uses the demo build, so `VITE_DEMO_MODE=1` there is
  expected and safe (CI-only; never in deployed environments).

## 3. Branch strategy

| Branch | CI effect | Deployment effect |
| --- | --- | --- |
| `develop` | Runs on push + PRs into `develop` | Netlify branch deploy -> preview URL `<branch>--<site>.netlify.app` |
| `main` | Runs on push + PRs into `main` | **Production**: Netlify production deploy + Render auto-deploy (`autoDeploy: true` on `kindora-api`, `kindora-worker` and the cron services) |
| Feature branches | PR checks (including the e2e job) | Netlify deploy preview per PR |

Flow: feature branch -> PR into `develop` (all checks green, e2e runs) -> merge to
`develop` (preview) -> PR `develop` -> `main` -> merge to `main` (production deploys fire
on both platforms).

## 4. How CI gates deployments

- **Netlify**: keep "wait for CI" enabled (Site configuration -> Build & deploy ->
  Deploy contexts). A red `main` build is not published; deploy previews for PRs still
  build independently for review.
- **Render**: `autoDeploy: true` deploys the pushed commit. Make it truly CI-gated by
  enabling branch protection on `main` requiring the five checks before merge - nothing
  then reaches Render untested. ([RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md).)

### Optional deploy hooks

The checked-in workflow does not deploy directly. If you want CI-triggered deployments,
add a step consuming repository secrets (Settings -> Secrets and variables -> Actions):

| Secret | Purpose | Where to obtain |
| --- | --- | --- |
| `NETLIFY_DEPLOY_HOOK` | Trigger a site deploy from a workflow step | Netlify: Site settings -> Build hooks |
| `RENDER_DEPLOY_HOOK` | Trigger a service deploy from a workflow step | Render: service -> Deploy hooks |

Both are plain URLs acting as credentials - store them only as repository secrets.

## 5. Rollback guidance

### 5.1 Netlify

1. Site -> **Deploys** -> find the last known-good production deploy.
2. **Rollback to this deploy** - instant, no rebuild.
3. Frontend and backend releases are independent; roll back whichever side shipped the
   defect. ([NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md).)

### 5.2 Render

1. Service (`kindora-api` / `kindora-worker` / cron) -> **Events** tab.
2. Locate the previous successful deploy -> **Rollback** - redeploys that build.
3. If a migration accompanied the bad release, read
   [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md): `prisma migrate deploy` already
   applied it. Use `npx prisma migrate resolve --rolled-back <name>` only if the
   migration itself failed midway, and prefer a forward-fix migration over manual schema
   surgery.

### 5.3 Database

Code rollbacks never roll back migrations. Follow the expand/backfill/contract discipline
in [DATABASE_SETUP.md](DATABASE_SETUP.md); for real incidents use the restore procedures
in [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).

## 6. Reproducing CI locally

Before pushing (and especially before hotfix merges to `main`), run the same gates:

```bash
# frontend job
cd frontend && npm ci && npm run typecheck && npm test && npm run build

# backend job
cd ../backend && npm ci && npx prisma generate && npm run typecheck && npm run test:unit && npm run build
# migration validation (CI runs the same diff)
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /dev/null && echo OK

# backend-integration job (use a disposable Postgres)
DATABASE_URL='postgresql://kindora:kindora@localhost:5432/kindora_test' \
JWT_SECRET=ci-test-secret PROVIDER_MODE=mock REDIS_URL='' RUN_INTEGRATION=1 \
  npm run test:integration

# workers job
cd ../workers && npm ci && npm run typecheck && npm run build

# e2e job (PRs)
cd ../frontend && VITE_DEMO_MODE=1 npm run build && npm run e2e
```

## 7. Extending CI

- New checks belong in the job matching the package (frontend/backend/workers) so the
  caches and working directories stay correct.
- Keep the migration validation step in sync with the schema (`prisma migrate diff` from
  empty to the schema datamodel) - it catches drift between `schema.prisma` and
  committed migrations early.
- Integration tests requiring new services (e.g. Redis for queue tests) should add
  service containers with health checks like the postgres block, and stay opt-in via
  env flags such as `RUN_INTEGRATION`.

Related: [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md) (this file) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)
