# KINDORA Documentation Index

Deployment and operations documentation for KINDORA, a global crowdfunding and
social-impact platform: verified campaigns, guest and account donations through
Paystack / Flutterwave / Stripe / PayPal, sponsor matching pools, giving circles,
an organization portal, and a public double-entry impact ledger behind every
money movement.

All facts in these guides are derived from the repository itself: `README.md`,
`render.yaml`, `.github/workflows/ci.yml`, `frontend/netlify.toml`,
`frontend/.env.example`, `frontend/vite.config.ts`, `backend/.env.example`,
`backend/package.json`, `backend/prisma/schema.prisma`, `backend/src/main.ts`,
`backend/src/health/health.controller.ts`, `backend/src/common/queue.service.ts`,
`backend/src/payments/*`, `backend/src/payouts/*`, `backend/src/internal/*`,
`backend/src/auth/auth.controller.ts`,
`backend/src/ledger/ledger.service.ts`, and `workers/`.

Related: [../README.md](../README.md) (repository overview) | [FINAL_REPORT.md](FINAL_REPORT.md)

---

## 0. Release security documentation

### 0.1 v1.0.7 payout execution integrity

| Document | Purpose |
| --- | --- |
| [PAYOUT_ARCHITECTURE_V1.0.7.md](PAYOUT_ARCHITECTURE_V1.0.7.md) | Complete payout execution architecture: state machines, initiation -> outbox -> verification -> reconciliation pipeline, fail-closed rules, beneficiary identity, idempotency identities, executor separation |
| [PROVIDER_INTEGRATION_V1.0.7.md](PROVIDER_INTEGRATION_V1.0.7.md) | Per-provider (Paystack, Flutterwave) endpoint tables, status classification, error mapping; explicit Stripe-payouts-unavailable section |
| [MANUAL_REVIEW_PROCEDURES_V1.0.7.md](MANUAL_REVIEW_PROCEDURES_V1.0.7.md) | Operator runbook: case categories, triage, admin API calls with fresh MFA, evidence + independent-reviewer rules |
| [KINDORA_v1.0.7_RELEASE_NOTES.md](KINDORA_v1.0.7_RELEASE_NOTES.md) | The eight critical issues fixed vs v1.0.6, new env vars, migration 0004, breaking changes, STAGING READY classification |
| [KINDORA_v1.0.7_TEST_REPORT.md](KINDORA_v1.0.7_TEST_REPORT.md) | Executed (255 jest / 52 vitest) vs NOT RUN (PostgreSQL integration, provider sandboxes, DB-level tests) verification |

### 0.2 v1.0.4 security documentation (payout lockdown)

| Document | Purpose |
| --- | --- |
| [PAYOUT_STATE_MACHINE_V1.0.4.md](PAYOUT_STATE_MACHINE_V1.0.4.md) | Canonical payout state machine: ownership, permitted transitions, critical restrictions |
| [DUAL_APPROVAL_SECURITY.md](DUAL_APPROVAL_SECURITY.md) | Immutable approval history, separation of duties, threshold policy |
| [PAYOUT_RETRY_AND_RECONCILIATION.md](PAYOUT_RETRY_AND_RECONCILIATION.md) | Attempt registry, idempotency, ambiguous-transfer handling, safe retry, reconciliation model |
| [ADMIN_FRESH_MFA_POLICY.md](ADMIN_FRESH_MFA_POLICY.md) | Fresh-MFA step-up: protected operations, protocol, fail-closed posture |
| [MANUAL_PAYOUT_EVIDENCE_POLICY.md](MANUAL_PAYOUT_EVIDENCE_POLICY.md) | Registered private evidence files replacing arbitrary URLs |
| [DEPENDENCY_SECURITY_REPORT.md](DEPENDENCY_SECURITY_REPORT.md) | Advisory remediation (nodemailer/zod/sharp) + accepted-risk register |
| [RENDER_DEPLOYMENT_GUIDE.md](RENDER_DEPLOYMENT_GUIDE.md) | v1.0.4 Render deployment runbook |
| [NETLIFY_DEPLOYMENT_GUIDE.md](NETLIFY_DEPLOYMENT_GUIDE.md) | v1.0.4 Netlify deployment runbook |
| [PRODUCTION_ENVIRONMENT_VARIABLES.md](PRODUCTION_ENVIRONMENT_VARIABLES.md) | Complete env-var reference incl. the v1.0.4 additions |
| [DATABASE_MIGRATION_GUIDE.md](DATABASE_MIGRATION_GUIDE.md) | Migration policy + 0003_payout_lockdown anatomy |
| [PAYOUT_OPERATIONS_GUIDE.md](PAYOUT_OPERATIONS_GUIDE.md) | Operator runbook: the three-admin payout workflow with fresh MFA |
| [FINANCIAL_RECONCILIATION_GUIDE.md](FINANCIAL_RECONCILIATION_GUIDE.md) | Reconciliation result triage + exactly-once guarantees |
| [KINDORA_v1.0.4_TEST_REPORT.md](KINDORA_v1.0.4_TEST_REPORT.md) | Executed vs blocked vs pending verification |
| [KINDORA_v1.0.4_SECURITY_AUDIT.md](KINDORA_v1.0.4_SECURITY_AUDIT.md) | Finding-by-finding remediation audit |
| [KINDORA_v1.0.4_RELEASE_NOTES.md](KINDORA_v1.0.4_RELEASE_NOTES.md) | Release summary + breaking changes |
| [PRODUCTION_READINESS_CHECKLIST.md](PRODUCTION_READINESS_CHECKLIST.md) | Control checklist + deployment verification steps |

---

## 1. Architecture at a glance

KINDORA is a three-package monorepo deployed on two platforms:

| Piece | Stack | Deployed to | Directory |
| --- | --- | --- | --- |
| Web app (PWA) | React 18, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand | Netlify | `frontend/` |
| REST API | NestJS 11, Prisma 6, PostgreSQL, BullMQ | Render | `backend/` |
| Background workers | BullMQ workers + cron scripts | Render Background Worker + 6 Render Cron Jobs | `workers/` |

### 1.1 Deployment topology (ASCII)

```
                        +--------------------------------------+
                        |               GitHub                 |
                        |  push / PR -> KINDORA CI (5 jobs)    |
                        |  main -> production, develop preview |
                        +------------------+-------------------+
                                           | auto-deploy on main
                    +----------------------+----------------------+
                    |                                             |
          +---------v-----------+                       +---------v-----------+
          |       Netlify       |                       |       Render        |
          |    kindora.com      |                       |   api.kindora.com   |
          |  React PWA (Vite)   |                       |    kindora-api      |
          |  frontend/dist      |                       |  NestJS, /api/v1/*  |
          |  netlify.toml:      |                       |  healthCheckPath    |
          |  SPA redirect + CSP |                       |  /api/v1/health     |
          +---------+-----------+                       +---+------------+----+
                    |                                       |            |
                    |  HTTPS, CORS allowlist,               |            |
                    |  credentials (refresh cookie)         |            |
                    +-------------------------------------->|            |
                                                            |            |
                     +--------------------------------------v---+   +----v---------------+
                     |  kindora-db (PostgreSQL, basic-256mb)    |   | kindora-redis      |
                     |  Prisma migrations (pre-deploy)          |   | (Key Value,        |
                     |  37 models incl. double-entry ledger     |   |  noeviction)       |
                     |  Donation / LedgerTransaction / ...      |   | BullMQ 8 queues,   |
                     +--------------------------------------^---+   | cache, cron locks  |
                                                            |       +----^---------------+
                                                            |            |
                                             +--------------+------------+--------------+
                                             |  kindora-worker (Background Worker)      |
                                             |  consumes all 8 BullMQ queues            |
                                             +------------------------------------------+
                                             |  6 Render Cron Jobs (root dir workers/)  |
                                             |  daily-analytics, campaign-reminders,    |
                                             |  recurring-donations, weekly-reports,    |
                                             |  database-maintenance,                   |
                                             |  reconciliation-digest                   |
                                             +------------------------------------------+

        Paystack / Flutterwave / Stripe / PayPal ---signed webhooks---> kindora-api
        Browser ---presigned PUT---> S3-compatible object storage <---SDK--- kindora-api
```

### 1.2 Request flow for money (summary)

1. The browser creates a donation (`POST /api/v1/donations`, optional `Idempotency-Key`).
2. The API initializes the payment server-side (provider secret keys never reach the browser)
   and returns a redirect URL to the provider checkout.
3. The payer completes payment; the provider redirects to `${FRONTEND_URL}/donate/status?ref=...`.
4. The status page polls `GET /api/v1/donations/status/<provider>/<publicRef>`, which re-verifies
   with the provider server-side; the provider also sends a signature-verified webhook to
   `POST /api/v1/payments/<provider>/webhook`.
5. Whichever signal arrives first wins a guarded, exactly-once state transition
   (`PENDING -> SUCCEEDED`) and a balanced double-entry ledger posting inside the same
   database transaction. Campaign counters and matching pools update atomically.
6. Post-commit side effects (emails, push, analytics, fraud scoring) are enqueued onto
   BullMQ queues and consumed by `kindora-worker`.

## 2. Documentation index

| File | Contents |
| --- | --- |
| [INSTALLATION.md](INSTALLATION.md) | Prerequisites, clone, per-package install, verify with builds |
| [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) | Daily dev loop, env files, migrations, seed admin, mock provider mode, demo mode, tests |
| [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | Frontend deployment: build settings, VITE_* vars, SPA redirects, CSP, PWA checks |
| [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | Blueprint deploy of API, PostgreSQL, Redis, worker and 6 cron jobs; sync:false secrets |
| [DATABASE_SETUP.md](DATABASE_SETUP.md) | PostgreSQL provisioning, connection strings, migration strategy, seeding, pooling, indexes |
| [REDIS_SETUP.md](REDIS_SETUP.md) | Key Value service, REDIS_URL wiring, graceful degradation without Redis, noeviction |
| [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md) | DNS records for kindora.com / www / api, TLS, canonical redirects, where domains appear in config |
| [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | Full reference of every backend / frontend / workers variable |
| [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | Paystack / Flutterwave / Stripe / PayPal setup, webhook URLs, sandbox testing, refunds |
| [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) | S3-compatible storage, presigned uploads, bucket CORS, public vs private keys, scanning |
| [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) | Worker package, queue/job matrix, retries and backoff, dead-letter monitoring, scaling |
| [CRON_JOBS.md](CRON_JOBS.md) | The 6 scheduled jobs, render.yaml schedules, idempotency and duplicate safety |
| [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md) | CI workflow jobs, branch strategy, deploy gating, rollback guidance |
| [SECURITY.md](SECURITY.md) | Auth design, rate limits, webhook signatures, ledger invariants, headers/CSP, secret rules |
| [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) | Backups, restores, RPO/RTO, secret rotation, disaster recovery runbook |
| [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md) | Ordered go-live checklist |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Symptom / cause / fix reference for deployments and operations |

## 3. Quick start (local development)

Prerequisites: Node 20+, PostgreSQL 14+ (or a hosted dev database), optional Redis, Git.

```bash
# 1. Backend API
cd backend
cp .env.example .env                     # set DATABASE_URL; see LOCAL_DEVELOPMENT.md
npm install
npx prisma migrate deploy                # or: npx prisma migrate dev
npm run prisma:seed                      # demo content + admin user
npm run start:dev                        # http://localhost:10000

# 2. Frontend PWA
cd ../frontend
cp .env.example .env                     # VITE_API_URL=http://localhost:10000
npm install
npm run dev                              # http://localhost:3000

# 3. Workers (optional locally; requires REDIS_URL)
cd ../workers
npm install && npm run build && npm run start:dev
```

Seeded admin login: `admin@kindora.com` with the password from the `SEED_ADMIN_PASSWORD`
environment variable — no default password exists, seeding refuses without it (the
historical fixed credential was removed in the v1.0.14 completion patch). Change it
immediately in any real deployment (see [DATABASE_SETUP.md](DATABASE_SETUP.md)).

Without Redis the API still runs: queue jobs are logged as `[inline-drop]` and skipped,
caching and distributed locks are disabled. Notifications require SMTP + Redis in
production (see [REDIS_SETUP.md](REDIS_SETUP.md)).

## 4. Deployment summary (Netlify + Render)

1. Push this repository to GitHub.
2. **Render:** Dashboard -> New -> **Blueprint** -> select the repo. Render provisions
   `kindora-api`, `kindora-db`, `kindora-redis`, `kindora-worker` and the six cron jobs
   from `render.yaml`; you are prompted for the `sync: false` secrets.
   Follow [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md).
3. **Netlify:** Add new site -> import the same repo -> set **Base directory** `frontend`;
   build command and publish directory are read from `frontend/netlify.toml`
   (`npm ci && npm run build` -> `dist`). Set the `VITE_*` environment variables.
   Follow [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md).
4. Point `kindora.com` at Netlify and `api.kindora.com` at Render
   ([DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md)).
5. Configure payment webhooks to
   `https://api.kindora.com/api/v1/payments/<provider>/webhook`
   ([PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md)).
6. Work through [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md) before opening
   donations to the public.

## 5. Money-safety design (summary)

- All amounts are **BigInt minor units** (kobo/cents); floats never touch balances.
- Every donation success, match, payout and refund posts a **balanced double-entry ledger
  transaction** (debits == credits per currency, enforced).
- Webhooks verify **provider signatures over the raw body**; state changes are guarded by
  conditional updates (exactly-once application), with idempotency keys on donation creation.
- Campaign balances are derived from the ledger; withdrawal availability subtracts in-flight
  payouts server-side. A client can never confirm a payment or change a balance.

Details: [SECURITY.md](SECURITY.md), [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md).

## 6. Conventions used in these guides

- Commands are shown in fenced code blocks with real values from the repository
  (ports, schedules, paths). Substitute your own domain where `kindora.com` appears.
- Environment variables are tabulated with required/optional and dev/prod values;
  the authoritative source for each variable is
  [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md).
- Cross-references point at sibling files by filename so each guide stays self-contained.
