# Environment Variables Reference

Every environment variable used by the three KINDORA packages: which service consumes it,
whether it is public or secret, required or optional, where to obtain the value, and the
dev-vs-production difference.

Sources of truth: `backend/.env.example`, `frontend/.env.example`, `render.yaml`, and
`backend/src/common/config/configuration.ts` (the parsed config tree).

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md)

---

Legend: **secret** = never expose to the browser, git, or logs; store only in service
environment variables. "prod required" = required for a production deployment; local
development may leave it empty.

## 1. Backend API (`backend/.env` -> Render `kindora-api`)

### 1.1 Core

| Variable | Public/Secret | Required | Dev value | Prod value | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | public | yes | `development` | `production` | Set by you / `render.yaml` |
| `PORT` | public | no | `10000` | `10000` | Render default; `main.ts` defaults to 10000 |
| `APP_NAME` | public | no | `KINDORA` | `KINDORA` | Cosmetic |
| `API_PREFIX` | public | no | `api/v1` | `api/v1` | Leave default (global prefix in `main.ts`) |
| `BACKEND_URL` | public | yes | `http://localhost:10000` | `https://api.kindora.com` | Your API domain |
| `FRONTEND_URL` | public | yes | `http://localhost:3000` (override the 5173 example default) | `https://kindora.com` | Your frontend domain; used for payment callbacks and email links |
| `CORS_ORIGINS` | public | yes | `http://localhost:3000,http://127.0.0.1:3000` | `https://kindora.com,https://www.kindora.com` | Exact browser origins, comma-separated; also guards auth refresh/logout `Origin` checks |
| `PROVIDER_MODE` | public | yes | `mock` (offline dev/tests) | `live` (pinned by `render.yaml`) | See [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md); mock must never run in production |

### 1.2 Datastores

| Variable | Public/Secret | Required | Dev value | Prod value | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | **secret** | yes | `postgresql://kindora:kindora@localhost:5432/kindora` | Render **internal** connection string (Blueprint wires it) | [DATABASE_SETUP.md](DATABASE_SETUP.md) |
| `REDIS_URL` | **secret** | prod: yes (dev: optional) | `redis://localhost:6379` or empty | Render Key Value connection string (Blueprint wires it) | [REDIS_SETUP.md](REDIS_SETUP.md) |

### 1.3 Auth

| Variable | Public/Secret | Required | Dev value | Prod value | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `JWT_SECRET` | **secret** | yes | long random string | `generateValue: true` in `render.yaml`, or `openssl rand -hex 32` | Rotating it logs out every user ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)) |
| `JWT_ACCESS_TTL` | public | no | `900` | `900` | Access token lifetime in seconds (15 minutes) |
| `JWT_REFRESH_TTL_DAYS` | public | no | `30` | `30` | Refresh token / cookie lifetime in days |
| `SESSION_SECRET` | **secret** | yes | long random string | `generateValue: true` in `render.yaml` | Session layer; treat like `JWT_SECRET` |

### 1.4 Money / fees

| Variable | Public/Secret | Required | Dev value | Prod value | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `DEFAULT_CURRENCY` | public | yes | `NGN` | `NGN` | Platform currency; amounts stored in minor units |
| `PLATFORM_FEE_PERCENT` | public | no | `0` | `0` (set by `render.yaml`) | Withdrawal fee percent; 0 = free platform / tip-based model |

### 1.5 Object storage (S3-compatible) - [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md)

| Variable | Public/Secret | Required | Dev value | Prod value | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `STORAGE_ENDPOINT` | public | for uploads | empty | provider endpoint URL | Render Object Storage / Cloudflare R2 / Backblaze B2 / MinIO dashboard |
| `STORAGE_BUCKET` | public | for uploads | empty | bucket name | Same dashboard |
| `STORAGE_REGION` | public | no | `us-east-1` | provider region (Blueprint default `us-east-1`) | Provider docs |
| `STORAGE_ACCESS_KEY` | **secret** | for uploads | empty | access key ID | Provider access keys page |
| `STORAGE_SECRET_KEY` | **secret** | for uploads | empty | secret access key | Same page |
| `STORAGE_FORCE_PATH_STYLE` | public | no | `true` | `true` | Path-style addressing for MinIO/R2/B2/Render (Blueprint sets `true`) |
| `STORAGE_PUBLIC_BASE_URL` | public | for public files | empty | `https://<bucket-cdn-domain>` | Public base used to serve campaign media |
| `STORAGE_MAX_UPLOAD_MB` | public | no | `15` | `15` | Campaign image cap (also hardcoded 15 MB ceiling in `storage.service.ts`) |

### 1.6 Email (SMTP) - any provider

| Variable | Public/Secret | Required | Dev value | Prod value | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `EMAIL_PROVIDER` | public | no | `smtp` | `smtp` | Fixed (`configuration.ts` default) |
| `SMTP_HOST` | public | prod: yes | empty | provider SMTP host | Provider dashboard (SMTP credentials) |
| `SMTP_PORT` | public | no | `587` | `587` (Blueprint sets 587) | 587 STARTTLS; 465 implicit TLS (pair with `SMTP_SECURE=true`) |
| `SMTP_USER` | **secret** | prod: yes | empty | SMTP username | Provider dashboard |
| `SMTP_PASSWORD` | **secret** | prod: yes | empty | SMTP password | Provider dashboard |
| `SMTP_SECURE` | public | no | `false` | `false` (587) / `true` (465) | Provider docs |
| `EMAIL_FROM_ADDRESS` | public | prod: yes | `no-reply@kindora.com` | verified sender on your domain | Domain verification at the provider ([DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md)) |
| `EMAIL_FROM_NAME` | public | no | `KINDORA` | `KINDORA` | Cosmetic |

### 1.7 SMS (optional)

| Variable | Public/Secret | Required | Where to obtain |
| --- | --- | --- | --- |
| `SMS_PROVIDER_API_KEY` | **secret** | no | Any SMS gateway exposing a REST API |
| `SMS_SENDER_ID` | public | no | `KINDORA` (sender ID approval depends on provider/country) |

### 1.8 Payment providers - [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md)

| Variable | Public/Secret | Required | Where to obtain |
| --- | --- | --- | --- |
| `PAYSTACK_SECRET_KEY` | **secret** | for Paystack | https://dashboard.paystack.com -> Settings -> API Keys (secret key `sk_...`; also the webhook HMAC secret) |
| `FLUTTERWAVE_SECRET_KEY` | **secret** | for Flutterwave | https://dashboard.flutterwave.com -> Settings -> API (secret key) |
| `FLUTTERWAVE_WEBHOOK_HASH` | **secret** | for Flutterwave webhooks | A random string you generate; set it BOTH as this env var and as the *secret hash* in the Flutterwave webhook settings (compared against the `verif-hash` header) |
| `STRIPE_SECRET_KEY` | **secret** | for Stripe | https://dashboard.stripe.com -> Developers -> API keys (full or restricted secret key with Checkout Session permissions; `sk_test_...` / `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | **secret** | for Stripe webhooks | Webhook endpoint page -> Signing secret (`whsec_...`) |
| `PAYPAL_CLIENT_ID` | secret (server-side only) | for PayPal | https://developer.paypal.com -> Apps & Credentials -> app Client ID |
| `PAYPAL_CLIENT_SECRET` | **secret** | for PayPal | Same app -> Secret |
| `PAYPAL_WEBHOOK_ID` | **secret** | for PayPal webhooks | Webhook page -> Webhook ID |
| `PAYPAL_ENV` | public | no | `sandbox` (default everywhere) or `live`. `render.yaml` sets `sandbox` - **add `live` manually when going live** |

### 1.9 Push notifications (Web Push / VAPID)

| Variable | Public/Secret | Required | Where to obtain |
| --- | --- | --- | --- |
| `VAPID_PUBLIC_KEY` | public (served to clients by the API) | for web push | `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | **secret** | for web push | Same command output |
| `VAPID_SUBJECT` | public | no | `mailto:<contact@your-domain>` |

### 1.10 AI assistant (optional)

| Variable | Public/Secret | Required | Where to obtain |
| --- | --- | --- | --- |
| `AI_PROVIDER_API_KEY` | **secret** | for AI features | Any OpenAI-compatible provider |
| `AI_PROVIDER_BASE_URL` | public | no | Default `https://api.openai.com/v1` |
| `AI_PROVIDER_MODEL` | public | no | Default `gpt-4o-mini` |

### 1.11 Monitoring

| Variable | Public/Secret | Required | Where to obtain |
| --- | --- | --- | --- |
| `SENTRY_DSN` | **secret** | no | Sentry project settings (frontend CSP already allows `https://*.sentry.io`) |

## 2. Frontend (`frontend/.env` -> Netlify)

All `VITE_` variables are **public by construction**: Vite inlines them into the JavaScript
bundle at build time and every visitor can read them. Only build-safe values belong here.

| Variable | Public/Secret | Required | Dev value | Prod value | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `VITE_APP_NAME` | public | yes | `KINDORA` | `KINDORA` | - |
| `VITE_APP_URL` | public | yes | `http://localhost:3000` | `https://kindora.com` | Your canonical frontend URL |
| `VITE_API_URL` | public | yes | `http://localhost:10000` | `https://api.kindora.com` | Your API URL |
| `VITE_ENVIRONMENT` | public | no | `development` | `production` | Build label |
| `VITE_DEFAULT_CURRENCY` | public | yes | `NGN` | `NGN` | Match backend `DEFAULT_CURRENCY` |
| `VITE_DEFAULT_LANGUAGE` | public | yes | `en` | `en` | - |
| `VITE_DEMO_MODE` | public | no | `1` (offline UI preview / e2e only) | **must be unset/empty** | See the warning below and [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) |

Changing any `VITE_` variable requires a rebuild/redeploy.

### Warning: never put secrets in VITE_ variables

Everything prefixed `VITE_` ships to every visitor's browser. Provider secret keys,
database URLs, SMTP passwords, JWT secrets and storage secret keys must **never** appear
in frontend env files or Netlify environment variables. All provider calls are made
server-side by the API; the frontend only ever holds the API URL. The frontend CSP
(`netlify.toml`) reflects exactly which hosts the browser is allowed to talk to.

## 3. Workers (`workers/.env` -> Render `kindora-worker` + cron jobs)

| Variable | Public/Secret | Required | Dev value | Prod value | Where to obtain |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | public | yes | `development` | `production` | `render.yaml` |
| `DATABASE_URL` | **secret** | yes | same as backend dev | Render internal connection string (Blueprint wires it) | Same database as the API |
| `REDIS_URL` | **secret** | **yes - the worker exits without it** | `redis://localhost:6379` | Blueprint-wired Key Value string | [REDIS_SETUP.md](REDIS_SETUP.md) |
| `FRONTEND_URL` | public | yes | `http://localhost:3000` | `https://kindora.com` | Links inside emails/push; `workers/src/lib/env.ts` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | user/pass **secret** | prod: yes | as backend | as backend | Same SMTP provider |
| `EMAIL_FROM_ADDRESS` | public | prod: yes | `no-reply@kindora.com` | verified sender | Provider dashboard |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | private key **secret** | for push | as backend | as backend (Blueprint sets on worker) | `npx web-push generate-vapid-keys` |
| `ADMIN_EMAILS` | public | for digests/alerts | empty | comma-separated admin addresses | Your ops team; consumed by weekly reports, reconciliation digest and `payments.reconcile` (`workers/src/lib/env.ts`) |

Cron-specific extras (per `render.yaml`):

| Cron | Additional variables beyond `NODE_ENV`/`DATABASE_URL`/`REDIS_URL` |
| --- | --- |
| `kindora-daily-analytics` | none |
| `kindora-campaign-reminders` | `FRONTEND_URL` |
| `kindora-recurring-donations` | none |
| `kindora-weekly-reports` | `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS`, `ADMIN_EMAILS` |
| `kindora-database-maintenance` | none |
| `kindora-reconciliation-digest` | `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS`, `ADMIN_EMAILS` |

## 4. Handling `.env` files safely

- `.env`, `.env.local` and `.env.*.local` are git-ignored - keep it that way; never
  force-add environment files.
- `.env.example` files are the committed templates; update them (not your real `.env`)
  when a new variable lands, and keep `ENVIRONMENT_VARIABLES.md` in sync.
- On Render/Netlify, secrets live only in service environment variables. `render.yaml`
  uses `sync: false` for secrets so they are entered in the dashboard, never committed;
  `generateValue: true` creates strong `JWT_SECRET` / `SESSION_SECRET` values.
- If a secret leaks (log, screenshot, git history): rotate it at the provider first, then
  update the service env var; for `JWT_SECRET` rotation consequences (all users logged
  out) see [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).
- Dev-vs-prod discipline: `PROVIDER_MODE=mock` and `VITE_DEMO_MODE=1` are local/CI
  conveniences that must never reach a production deployment
  ([LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md), [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md)).

Related: [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) | [REDIS_SETUP.md](REDIS_SETUP.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)

## v1.0.1 additions

| Variable | Package | Default | Purpose |
| --- | --- | --- | --- |
| `SEED_ADMIN_PASSWORD` | backend | *(none — required)* | Password for `npm run prisma:seed`; no default exists (seed refuses without it, strength-checked ≥12 chars with upper+digit). Dev/test only. |
| `SEED_DEMO` | backend | *(unset)* | Set to `1` to insert demonstration campaigns/donations; production seed refuses without `SEED_FORCE=1` anyway. |
| `SEED_FORCE` | backend | *(unset)* | Only for deliberately seeding a production DB — strongly discouraged. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_FIRST_NAME` / `ADMIN_LAST_NAME` | backend | *(none — required)* | Production administrator creation via `npm run bootstrap:admin` (fails if any admin exists; audited). |
| `ADMIN_ALLOW_NON_PROD` | backend | *(unset)* | Permits bootstrap:admin outside NODE_ENV=production (local testing only). |
| `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR` | backend | `0` | Payouts at/above this minor-unit amount require a second, distinct administrator approval. |
| `MALWARE_SCAN_ENDPOINT` | workers | *(unset)* | HTTP malware-scan bridge (e.g. ClamAV REST). Unset ⇒ sensitive documents stay QUARANTINED (fail-safe), public images re-encoded instead. |
| `STORAGE_MAX_UPLOAD_MB` | backend | `15` | Enforced at the storage boundary via presigned POST `content-length-range` + post-upload HeadObject check. |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL_DAYS` | backend | `900` / `30` | Now surfaced in render.yaml (were implicit before). |
| `PAYPAL_ENV` | backend | `sandbox` | Now operator-controlled in render.yaml (`sync: false`) — set `live` after PayPal production onboarding. |

## v1.0.7 additions (payout execution integrity)

Consumed by `backend/src/common/config/configuration.ts` (the `payouts` config tree and
production startup validation) and the payout services under `backend/src/payouts/` and
`workers/src/`. Details: [PAYOUT_ARCHITECTURE_V1.0.7.md](PAYOUT_ARCHITECTURE_V1.0.7.md).

| Variable | Package | Default | Purpose |
| --- | --- | --- | --- |
| `PAYOUT_SUPPORTED_PROVIDERS` | backend | `PAYSTACK,FLUTTERWAVE` | Active payout provider set (comma-separated, uppercased). Only genuinely implemented providers may be listed: production startup validation REFUSES TO START when the value names anything besides `PAYSTACK` / `FLUTTERWAVE` / `MOCK`, or when it lists a provider without its matching secret key (`PAYSTACK_SECRET_KEY` / `FLUTTERWAVE_SECRET_KEY`). Stripe payouts are disabled in v1.0.7 (donations remain supported); Stripe must not appear in this list. |
| `PAYOUT_UNKNOWN_ESCALATION_MINUTES` | backend | `120` | How long an ambiguous (`SUBMISSION_PENDING`) or `UNKNOWN` payout attempt may stay unresolved before it escalates to `MANUAL_REVIEW` with an OPEN manual review case. Lower values escalate normal provider latency into manual review — keep the default unless you have measured transfer latency. |
| `PAYOUT_OUTBOX_SWEEP_SECONDS` | backend | `30` | Interval of the in-process payout outbox sweeper (crash-recovery floor for deployments without Redis/workers). Values below `5` DISABLE the sweeper — never set below 5 in an environment that can initiate payouts. |
| `WORKER_INGEST_TOKEN` | backend + workers | *(unset — required for worker-driven payouts)* | Shared secret for the worker -> backend internal payout endpoints (`POST /api/v1/internal/payouts/*`, header `x-worker-token`). The backend fails CLOSED (503) when the token is unset, closing the internal surface; set the SAME strong value on the API and the worker service. Unset means the backend in-process sweeper owns payout recovery (queue jobs are acknowledged by the worker with a warning). Secret: never expose to the browser, git, or logs. |

Production validation notes: all four variables are read at startup; `PAYOUT_SUPPORTED_PROVIDERS`
misconfigurations (unimplemented provider names, or a provider listed without its secret key)
throw before the application binds its port, so a broken payout configuration can never boot
silently. The other three degrade safely: the escalation window and sweep interval fall back
to their defaults, and a missing `WORKER_INGEST_TOKEN` closes the worker ingest surface
instead of opening it.


---

## v1.0.8 addendum — payout authorization & recovery

| Variable | Service | Default | Meaning |
| --- | --- | --- | --- |
| `PAYOUT_OUTBOX_LEASE_MINUTES` | backend | `10` | Outbox lease window (minutes). A claimed `IN_FLIGHT` intent is owned only until the lease expires; recovery reclaims expired leases through the SAFE path (provider lookup by submission reference BEFORE any resubmission). |
| `PAYOUT_FLW_MOBILE_MONEY_ENABLED` | backend | `false` | Flutterwave mobile-money payout channel gate. DISABLED by default; set `true` ONLY after the Flutterwave mobile-money sandbox verification suite has passed for every supported corridor. |

---

## v1.0.10 addendum — provider sandbox verification variables

The v1.0.10 release classifies provider sandbox verification as BLOCKED when these
sandbox credentials are absent from the deployment environment (the release report
records the variable NAMES only — values are never stored in the repository):

| Variable | Purpose |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | Paystack secret key (sandbox for staging verification). Required for the Paystack payout sandbox suite: authentication, initiation, duplicate-reference behaviour, lookup, exact-reference verification, not-found/ambiguous handling, recovery after worker interruption. |
| `FLUTTERWAVE_SECRET_KEY` | Flutterwave secret key (sandbox for staging verification). Required for the Flutterwave payout sandbox suite: authentication, initiation, paginated reference lookup, empty/contradictory-pagination handling, exact-reference verification, not-found/ambiguous handling, recovery after worker interruption. |

With these unset, the pipeline runs in mock mode only and the release remains
STAGING READY. Provide the sandbox credentials, deploy to staging with
`PROVIDER_MODE` unset (live adapters are selected by the configured keys), and run
the staging verification checklist in `docs/DEPLOYMENT_GUIDE.md` before any
production classification. Never commit real keys.
