# KINDORA v1.0.4 — Production Environment Variables

Source of truth: `render.yaml` (repository root). Startup validation lives in
`backend/src/common/config/configuration.ts` (`assertProductionSafety`). In production
(`NODE_ENV=production`) the API **refuses to boot** when configuration is unsafe — the
deploy fails instead of running unprotected. Non-production environments never throw.

Conventions: **required** = service will not boot or will not function without it;
`sync: false` = prompted securely at Render blueprint deploy time; `generateValue` =
Render auto-generates a strong random value.

## 1. Core infrastructure

| Variable | Set on | Required | Example / value | What it does | If wrong |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | API, worker, all crons | Yes | `production` (fixed in blueprint) | Activates production validation + fail-closed behaviour | Anything else disables startup safety checks |
| `DATABASE_URL` | API, worker, all crons | Yes | injected from `kindora-db` (`fromDatabase.connectionString`) | PostgreSQL connection | **Refuses to boot** when missing; 503 on `/api/v1/health/database` when unreachable |
| `REDIS_URL` | API, worker, all crons | Yes in practice | injected from `kindora-redis` (`fromService.connectionString`), e.g. `redis://red-xxx:6379` | Cache, distributed locks, MFA challenge store | If **set but malformed**: startup validation fails (`validateRedisUrl` — protocol must be `redis://`/`rediss://`, valid host, port 1–65535, numeric db path, decodable credentials; errors are credential-free). If **unreachable/unset**: app boots degraded — caching and locks disabled and **all fresh-MFA payout operations fail closed with 503** |
| `REDIS_REQUIRE_TLS` | API | No | `false` (blueprint) — set `true` when your Redis endpoint supports TLS | When `true`, `REDIS_URL` must use `rediss://` or startup fails | `true` + plain `redis://` = refuses to boot |
| `JWT_SECRET` | API | Yes | `generateValue: true` | Access-token signing key | **Refuses to boot** when missing or equal to the dev default (`dev-only-secret-change-me`) |
| `SESSION_SECRET` | API | Yes | `generateValue: true` | Session/cookie material | Generated automatically |

## 2. App identity / runtime

| Variable | Set on | Required | Example / value | What it does | If wrong |
| --- | --- | --- | --- | --- | --- |
| `APP_NAME` | API | No | `KINDORA` | Display name | Cosmetic |
| `API_PREFIX` | API | No | `api/v1` (fixed) | Global route prefix | Endpoints move; Netlify CSP/monitors must match |
| `PORT` | API | No | Render-injected | Listen port | Render injects automatically |
| `FRONTEND_URL` | API, worker, some crons | Yes | `https://app.kindora.com` (`sync: false`) | Base URL for links in emails/notifications | Links point at localhost |
| `BACKEND_URL` | API | Yes | `https://api.kindora.com` (`sync: false`) | Public API origin | Wrong links/callbacks |
| `CORS_ORIGINS` | API | Yes | `https://app.kindora.com` (`sync: false`, comma-separated) | Exact browser origins allowed by CORS | Empty → **cookie CSRF checks fail closed**; wrong origin → browser requests blocked |
| `JWT_ACCESS_TTL` | API | No | `900` (seconds) | Access-token lifetime | Long values widen the stolen-token window |
| `JWT_REFRESH_TTL_DAYS` | API | No | `30` | Refresh-token lifetime | — |
| `DEFAULT_CURRENCY` | API | No | `NGN` | Default money currency | Mismatch with provider payouts |
| `PLATFORM_FEE_PERCENT` | API | No | `0` | Platform fee on donations | Fee ledger entries change |

## 3. Payments

| Variable | Set on | Required | Example / value | What it does | If wrong |
| --- | --- | --- | --- | --- | --- |
| `PROVIDER_MODE` | API, worker, recurring-donations cron | Yes | `live` (fixed in blueprint) | Selects real vs mock provider adapters | `mock` in production = **refuses to boot** (disables payment verification and webhook signature checks); `live` with **zero** provider keys below = **refuses to boot** |
| `PAYSTACK_SECRET_KEY` | API, worker, recurring-donations cron | Yes (NGN payouts) | `sk_live_...` (`sync: false`) | Paystack payments + transfer verification | Payout verification for PAYSTACK attempts fails |
| `FLUTTERWAVE_SECRET_KEY` | API | No | `FLWSECK-...` (`sync: false`) | Flutterwave payments + transfer verification | FLW payout verification unavailable |
| `FLUTTERWAVE_WEBHOOK_HASH` | API | No | secret hash (`sync: false`) | Flutterwave webhook signature verification | FLW webhooks rejected/unverified |
| `STRIPE_SECRET_KEY` | API | No | `sk_live_...` (`sync: false`) | Stripe card payments | Stripe donations unavailable |
| `STRIPE_WEBHOOK_SECRET` | API | No | `whsec_...` (`sync: false`) | Stripe webhook signature verification | Stripe webhooks rejected |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | API | No | (`sync: false`) | PayPal OAuth | PayPal unavailable |
| `PAYPAL_WEBHOOK_ID` | API | No | (`sync: false`) | PayPal webhook verification | PayPal webhooks unverifiable |
| `PAYPAL_ENV` | API | Yes if PayPal used | `live` or `sandbox` (`sync: false` — deliberate) | PayPal endpoint selection | Unset silently behaves as `sandbox` — an operator must consciously choose `live` after onboarding |

## 4. Payout lockdown (v1.0.4)

| Variable | Set on | Required | Example / value | What it does | If wrong |
| --- | --- | --- | --- | --- | --- |
| `WITHDRAWAL_DUAL_APPROVAL_MODE` | API (read from shared config; keep identical across services) | Yes | `ALL` (blueprint default) | `ALL` = **every** payout requires two distinct administrators plus a separate executor. `THRESHOLD` = only payouts ≥ threshold require it. There is **no configuration that disables dual approval** | Any value other than `ALL`/`THRESHOLD` (case-insensitive) = **refuses to boot** |
| `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR` | API (same rule) | Required when mode = `THRESHOLD` | `0` under `ALL`; e.g. `5000000` (= ₦50,000.00) under `THRESHOLD` | Amount in minor units above which dual approval applies | Zero/negative/non-integer/missing while mode = `THRESHOLD` = **refuses to boot** (it would silently disable dual approval) |
| `MFA_ENCRYPTION_KEY` | API | No (recommended) | strong random string (`sync: false`) | Dedicated key for encrypting TOTP secrets at rest (AES-256-GCM). When unset, the key is scrypt-derived from `JWT_SECRET` with domain separation (`kindora-mfa-v1`) | Unset + later `JWT_SECRET` rotation = enrolled MFA credentials become undecryptable; admins must re-enroll before payout ops |
| `ADMIN_EMAILS` | worker, weekly-reports cron, reconciliation-digest cron | Yes for digest/report delivery | `ops@kindora.com,cfo@kindora.com` (`sync: false`, comma-separated, empty entries dropped) | Recipients of the daily reconciliation digest (failed webhooks 24h + stale PENDING donations >30 min) and weekly reports | Set but invalid → emails bounce; empty → digest is computed but **skipped** (warning logged) and nobody sees payment anomalies |

## 5. Storage (S3-compatible; payout evidence requires it)

| Variable | Set on | Required | Example / value | What it does | If wrong |
| --- | --- | --- | --- | --- | --- |
| `STORAGE_ENDPOINT` | API, worker | Yes | `https://s3.us-east-1.amazonaws.com` or object-store endpoint (`sync: false`) | Document/`PAYOUT_EVIDENCE` upload target | Manual settlement impossible (evidence upload fails) |
| `STORAGE_BUCKET` | API, worker | Yes | `kindora-prod` (`sync: false`) | Bucket name | Uploads fail |
| `STORAGE_REGION` | API, worker | No | `us-east-1` (fixed) | Region | — |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | API, worker | Yes | (`sync: false`) | Object-store credentials | Uploads fail |
| `STORAGE_FORCE_PATH_STYLE` | API, worker | No | `true` (fixed) | Path-style addressing (needed for most S3-compatible stores) | — |
| `STORAGE_PUBLIC_BASE_URL` | API | No | `https://cdn.kindora.com` (`sync: false`) | Public base for public media URLs | Public assets get wrong URLs |
| `STORAGE_MAX_UPLOAD_MB` | API | No | `15` (fixed) | Upload size cap | — |

## 6. Email / push / AI / observability / scanning

| Variable | Set on | Required | Example / value | What it does | If wrong |
| --- | --- | --- | --- | --- | --- |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | API, worker, email crons | Yes | host (`sync: false`), `587`, `false` | Outbound email (verification, digest, reports) | Auth emails never send |
| `SMTP_USER` / `SMTP_PASSWORD` | API, worker, email crons | Yes | (`sync: false`) | SMTP credentials | Auth emails never send |
| `EMAIL_FROM_ADDRESS` | API, worker, email crons | Yes | `no-reply@kindora.com` (`sync: false`) | From header | Deliverability issues |
| `EMAIL_FROM_NAME` | API | No | `KINDORA` (fixed) | Display name | Cosmetic |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | API, worker | No | (`sync: false`) | Web-push for notifications | Push notifications disabled |
| `AI_PROVIDER_API_KEY` / `AI_PROVIDER_BASE_URL` / `AI_PROVIDER_MODEL` | API | No | (`sync: false`) | AI description assist | AI features degrade |
| `SENTRY_DSN` | API | No | `https://...` (`sync: false`) | Error reporting | No error telemetry |
| `MALWARE_SCAN_ENDPOINT` | worker | No | scanner URL (`sync: false`) | Malware-scanning bridge for uploads | When empty, sensitive documents **stay quarantined** (fail-safe) and public images are re-encoded instead — payout evidence stays unusable until a scanner is configured |

## 7. Fail-closed summary (what refuses to start / degrade)

`assertProductionSafety` throws (deploy fails, old release stays live) when:

1. `JWT_SECRET` missing or dev default.
2. `DATABASE_URL` missing.
3. `REDIS_URL` set but invalid per `validateRedisUrl` (protocol, host, port, db path,
   credentials, malformed query; `REDIS_REQUIRE_TLS=true` demands `rediss://`).
4. `WITHDRAWAL_DUAL_APPROVAL_MODE` not `ALL`/`THRESHOLD`.
5. `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR` not a positive integer while mode is
   `THRESHOLD`.
6. `PROVIDER_MODE=mock`.
7. `PROVIDER_MODE=live` with no provider secret configured.

At runtime (degraded, not crashed):

- Redis down/unset → MFA issuance/consumption return **503** and every guarded payout
  endpoint rejects; `/api/v1/health/redis` reports degraded. Payout operations are
  impossible by design — there is no bypass path.
- Malware scanner unset → evidence files remain quarantined; settlements using them are
  rejected until the scan verdict is CLEAN.
- `CORS_ORIGINS` empty → cookie-based CSRF checks fail closed; browsers are rejected.

Keep API and workers on the **same** values for `PROVIDER_MODE`,
`WITHDRAWAL_DUAL_APPROVAL_MODE`, and `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR` —
`render.yaml` intentionally shares them; do not introduce per-service divergence.
