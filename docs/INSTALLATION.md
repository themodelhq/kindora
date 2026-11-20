# Installation

Step-by-step setup of the KINDORA monorepo on a local machine: prerequisites, cloning,
installing each package, and verifying the installation with the same builds CI runs.

Related: [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) | [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## 1. Prerequisites

| Tool | Version | Why | Verify with |
| --- | --- | --- | --- |
| Node.js | 20 or later; **22 recommended** (CI pins 22, `netlify.toml` sets `NODE_VERSION = "22"`) | Runtime for all three packages (`engines.node >= 20` in every `package.json`) | `node -v` |
| npm | 10+ | `npm ci` installs from the committed lockfiles | `npm -v` |
| PostgreSQL | 14 or later | Primary datastore (CI uses the `postgres:16` image; any 14+ server works) | `psql --version` |
| Redis | 7.x (optional locally) | BullMQ queues, caching and distributed locks. The API runs without it; workers require it | `redis-cli --version` |
| Git | any recent version | Clone the repository | `git --version` |

Notes:

- PostgreSQL can be a local install, a Docker container, or a hosted dev database; only
  `DATABASE_URL` changes. KINDORA does not use database-specific extensions, so any
  PostgreSQL 14+ server is sufficient.
- Redis is optional for quick frontend/API work: without `REDIS_URL` the API logs every
  queue job as `[inline-drop]` and moves on (see [REDIS_SETUP.md](REDIS_SETUP.md)).
  The background worker, however, refuses to start without Redis.
- A modern browser with DevTools is needed to exercise the PWA and the payment mock flow.

## 2. Clone the repository

```bash
git clone <your-repo-url> kindora
cd kindora
```

The repository layout you should see:

```
kindora/
├── frontend/          # Vite React PWA (netlify.toml included)
├── backend/           # NestJS API (Prisma schema + migrations, seed)
├── workers/           # BullMQ processors + cron jobs
├── docs/              # 18 deployment & operations guides (this directory)
├── brand/             # logo and hero assets
├── .github/workflows/ # CI: builds, unit tests, integration tests on Postgres
└── render.yaml        # One-click Render Blueprint (API + DB + Redis + worker + 6 crons)
```

## 3. Install dependencies (all three packages)

```bash
cd backend  && npm install
cd ../frontend && npm install
cd ../workers  && npm install
```

CI and both hosting platforms use `npm ci` (lockfile-exact installs). For day-to-day local
development `npm install` is fine; use `npm ci` when you want your tree to match the
lockfiles exactly:

```bash
cd backend  && npm ci
cd ../frontend && npm ci
cd ../workers  && npm ci
```

The `workers` package lists `sharp` (native module) and Prisma engines in its
`allowScripts` block; if your npm configuration blocks postinstall scripts, allow build
scripts for `sharp`, `prisma`, `@prisma/client` and `@prisma/engines`. The workers
`postinstall` script runs `prisma generate --schema prisma/schema.prisma` automatically.

## 4. Generate the Prisma client

The backend needs a generated Prisma client before TypeScript compiles:

```bash
cd backend
npm run prisma:generate      # prisma generate
```

The workers package generates its own client from `workers/prisma/schema.prisma` during
install and build; no separate step is needed unless you want editor autocomplete while
editing worker code.

## 5. Provision local PostgreSQL and Redis

Any PostgreSQL 14+ instance works. Two common options:

### 5.1 Docker (one container each)

```bash
docker run -d --name kindora-postgres \
  -e POSTGRES_USER=kindora -e POSTGRES_PASSWORD=kindora -e POSTGRES_DB=kindora \
  -p 5432:5432 postgres:16

docker run -d --name kindora-redis -p 6379:6379 redis:7
```

Resulting local connection strings:

- `DATABASE_URL=postgresql://kindora:kindora@localhost:5432/kindora`
- `REDIS_URL=redis://localhost:6379`

Manage them later with `docker stop kindora-postgres kindora-redis` and
`docker start kindora-postgres kindora-redis`.

### 5.2 Local services or a hosted dev database

Use your installed PostgreSQL/Redis directly, or point `DATABASE_URL` at a hosted dev
database. Record the connection strings; you will paste them into the `.env` files next.

## 6. Configure environment files

Each package ships a `.env.example`. Copy it and edit (never commit a real `.env`):

```bash
cd backend  && cp .env.example .env
cd ../frontend && cp .env.example .env
cd ../workers  && cp .env.example .env
```

Minimum local values (full reference: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)):

```env
# backend/.env (minimum edits)
DATABASE_URL=postgresql://kindora:kindora@localhost:5432/kindora
REDIS_URL=redis://localhost:6379          # optional locally; empty is allowed
PROVIDER_MODE=mock                        # offline donation flow, no provider keys
FRONTEND_URL=http://localhost:3000        # Vite dev server port (see below)
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

Why the `FRONTEND_URL` / `CORS_ORIGINS` override: `backend/.env.example` ships
`http://localhost:5173` defaults, but the Vite dev server listens on **port 3000**
(`frontend/vite.config.ts`, `server.port: 3000`). Point both values at port 3000 so CORS
and the refresh-cookie origin checks pass. The API itself listens on **port 10000**
(`PORT=10000` in `backend/.env.example`, the same default in `backend/src/main.ts`).

`frontend/.env.example` defaults are already correct for local development
(`VITE_API_URL=http://localhost:10000`, `VITE_APP_URL=http://localhost:3000`, and
`VITE_DEMO_MODE=1` for the offline UI preview). Leave `VITE_DEMO_MODE=1` for local UI
work and e2e tests; it must be unset/empty in production builds
([NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md)).

`workers/.env` minimum: `DATABASE_URL`, `REDIS_URL=redis://localhost:6379`,
`FRONTEND_URL=http://localhost:3000`. The worker exits on boot without `REDIS_URL`
([REDIS_SETUP.md](REDIS_SETUP.md)).

## 7. Run migrations and seed

```bash
cd backend
npx prisma migrate deploy     # applies committed migrations from prisma/migrations/
npm run prisma:seed           # idempotent demo content + users
```

- During development you will usually create new migrations with
  `npx prisma migrate dev --name <name>` instead; see the `migrate dev` vs
  `migrate deploy` explanation in [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) and the
  production strategy in [DATABASE_SETUP.md](DATABASE_SETUP.md).
- The seed (`ts-node --transpile-only prisma/seed.ts`) is idempotent: safe to run
  repeatedly. It creates the admin/organizer/donor users, 12 categories, a verified
  organization, sample campaigns with ledger-consistent donation history, a matching
  pool, a settled withdrawal, a circle and platform stats.

Seeded logins (all three share the same password):

| Email | Role | Password |
| --- | --- | --- |
| `admin@kindora.com` | ADMIN | the `SEED_ADMIN_PASSWORD` env value (no default exists — seeding refuses without it) |
| `organizer@kindora.com` | USER (organization owner) | same |
| `donor@kindora.com` | USER | same |

`SEED_ADMIN_PASSWORD` MUST be set in `backend/.env` before seeding — no default password
exists (the historical fixed credential was removed in the v1.0.14 completion patch).
Never reuse one environment's password on another
([DATABASE_SETUP.md](DATABASE_SETUP.md), [SECURITY.md](SECURITY.md)).

## 8. Start the three packages

Use three terminals:

```bash
# Terminal 1 - API (http://localhost:10000)
cd backend && npm run start:dev        # nest start --watch

# Terminal 2 - Frontend PWA (http://localhost:3000)
cd frontend && npm run dev             # vite dev server, HMR

# Terminal 3 - Workers (requires Redis)
cd workers && npm run build && npm run start:dev
```

Expected worker boot log:

```text
[worker] booting KINDORA background worker...
[worker] redis connection verified
[worker] online — queues: email, push, notifications, analytics, media, fraud, payments, reports
```

## 9. Verify the installation with builds and health checks

### 9.1 Health endpoints

```bash
curl http://localhost:10000/api/v1/health
# {"status":"ok","service":"kindora-api","version":"1.0.0","uptimeSeconds":...,"timestamp":"..."}

curl http://localhost:10000/api/v1/health/database
# {"status":"ok","component":"database"}

curl http://localhost:10000/api/v1/health/redis
# {"status":"ok","component":"redis","configured":true}
# (503 {"status":"degraded","component":"redis","configured":false} when REDIS_URL is unset - expected without Redis)
```

### 9.2 Per-package builds (the same gates CI runs)

```bash
# Backend: typecheck + unit tests + compile
cd backend
npm run typecheck          # tsc --noEmit
npm run test:unit          # jest unit tests (ledger, payments, auth, money)
npm run build              # nest build -> dist/

# Frontend: typecheck + vitest + production build
cd ../frontend
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm run build              # tsc --noEmit && vite build -> dist/

# Workers: typecheck + compile
cd ../workers
npm run typecheck          # tsc -p tsconfig.json --noEmit
npm run build              # tsc -p tsconfig.json -> dist/
```

All four builds finishing cleanly means the installation matches what
[CI](GITHUB_ACTIONS.md) and the deployment platforms expect.

### 9.3 Smoke test the money path (no provider account needed)

With `PROVIDER_MODE=mock` in `backend/.env`, donate on any seeded campaign at
`http://localhost:3000`; the mock provider returns you to `/donate/status?ref=KDO-...`
and the donation completes through the real state machine and ledger. Details:
[LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).

## 10. What next

- Daily workflow, hot reload, seeding and mock mode: [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md)
- Deploying the frontend to Netlify: [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md)
- Deploying the API, database, Redis, worker and crons to Render: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)
- Environment variable reference: [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)

Related: [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) | [DATABASE_SETUP.md](DATABASE_SETUP.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
