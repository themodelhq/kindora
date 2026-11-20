# Troubleshooting

Symptom -> cause -> fix reference for KINDORA deployments and operations.

Related: [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) | [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)

---

## 1. Frontend / Netlify

| Symptom | Cause | Fix |
| --- | --- | --- |
| 404 when refreshing a nested route (`/campaigns/<slug>`, `/donate`) or opening a shared WhatsApp link | SPA redirect missing/not applied - Netlify serves the file system, not the router | Ensure the site's base directory is `frontend` and `frontend/netlify.toml` is deployed (redirect `/* -> /index.html`, status 200). Retrigger a deploy after editing - [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) |
| Blank page + console CSP violation against the API | CSP `connect-src` does not include your API host | Update `connect-src` in `frontend/netlify.toml` to the real API domain (and provider hosts); redeploy - [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) section 5 |
| PWA does not offer install | Not HTTPS, manifest missing, or `sw.js` blocked | Verify HTTPS, `GET /manifest.webmanifest` returns 200 with `must-revalidate`, DevTools shows an active service worker; icons 192/512 as in `vite.config.ts` |
| PWA shows stale UI after deploy | HTML/`sw.js` cached by something outside Netlify | Confirm `Cache-Control: public, max-age=0, must-revalidate` on `/index.html` and `/sw.js`; hard-reload - the SW is `autoUpdate` and self-heals once headers are right |
| Demo data visible on production | Build made with `VITE_DEMO_MODE=1` | Remove the variable from Netlify (all deploy contexts), rebuild and deploy. Demo mode is for local previews and the CI e2e build only - [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) section 3 |
| Build fails with type errors | `npm run build` includes `tsc --noEmit` | Fix types locally (`npm run typecheck`); CI runs the same gate - [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md) |
| API calls fail from the deployed site but work locally | `VITE_API_URL` wrong (still localhost) or changed after the build | Set `VITE_API_URL=https://api.kindora.com` and **redeploy** - `VITE_` vars are compile-time |

## 2. CORS and authentication

| Symptom | Cause | Fix |
| --- | --- | --- |
| Browser console: CORS policy blocked | Browser origin missing from `CORS_ORIGINS` | Add the exact origin (scheme + host + port) to `CORS_ORIGINS` on `kindora-api`, e.g. `https://kindora.com,https://www.kindora.com`; the service restarts/redeploys with the change. Both apex and www must be listed (redirects) |
| `POST /api/v1/auth/refresh` -> 401 "Origin not allowed" | `assertOrigin` rejects origins outside `CORS_ORIGINS` (CSRF defence on refresh/logout) | Same fix as CORS above - [SECURITY.md](SECURITY.md) sections 1/9 |
| 401 loop: API keeps returning 401 after login | Refresh cookie not being sent: cookie is `SameSite=None; Secure` on the API domain, so the frontend **must** call the API over HTTPS with `withCredentials: true`; localhost dev needs `CORS_ORIGINS=http://localhost:3000,...` and the local `lax` cookie behaviour | Check the request actually carries the `kindora_refresh` cookie (DevTools -> Network); verify HTTPS on the API domain, `credentials: true` in CORS, and that no proxy strips cookies - [SECURITY.md](SECURITY.md) section 1 |
| Every user logged out after a deploy | `JWT_SECRET` was changed between deploys | Expected consequence of rotation; set `JWT_SECRET` once (Blueprint `generateValue: true`) and keep it stable - [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) section 5 |
| All sessions die at once per user | Refresh-token **reuse detection** fired (a revoked token was replayed) | Sign in again; if recurring for one user, check for a stolen cookie / duplicated tab behaviour - `AUTH_REFRESH_REUSE_DETECTED` rows in `AuditLog` explain the revocation - [SECURITY.md](SECURITY.md) section 1 |
| 429 responses | Rate limits: 120/min global, 10/min auth register+login, 5/min password flows, 20/min donation creation | Expected behaviour; back off or raise limits deliberately in code (`ThrottlerModule` / `@Throttle`), not config - [SECURITY.md](SECURITY.md) section 3 |

## 3. Webhooks and payment signatures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `POST /api/v1/payments/<provider>/webhook` returns 400 "Invalid signature" | Wrong/missing secret env var, or the body was re-serialized by a proxy (signature is over the **raw** body) | Verify: `PAYSTACK_SECRET_KEY` (HMAC SHA512), `FLUTTERWAVE_WEBHOOK_HASH` (= dashboard secret hash), `STRIPE_WEBHOOK_SECRET` (`whsec_...`), `PAYPAL_WEBHOOK_ID`. Keep the route free of body-transforming middleware; `main.ts` preserves `rawBody`. Diagnose via `WebhookEvent` rows with status `FAILED` - [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) |
| Provider dashboard shows webhook successes but donations stay PENDING | Signature OK but reference mismatch, or unexpected event type | Compare the `WebhookEvent.reference` with the donation's `publicRef`; the reconciliation digest (04:00 UTC) also lists stale donations - [CRON_JOBS.md](CRON_JOBS.md) |
| Duplicate ledger postings suspected | Impossible by design: unique `LedgerTransaction.reference` + PENDING-guarded state machine + `WebhookEvent (provider,eventId)` dedupe | Verify by querying `LedgerTransaction` by reference; reproduce before reporting as a bug - [SECURITY.md](SECURITY.md) section 5 |

## 4. Donations stuck in PENDING

| Symptom | Cause | Fix |
| --- | --- | --- |
| Donation stays `PENDING` after payment; status page keeps polling | Webhook URL misconfigured (or unreachable) **and** the provider's event never verified | 1) Check the provider dashboard's event log for delivery attempts/HTTP codes. 2) Check `WebhookEvent` rows: none -> URL/DNS problem; `FAILED` -> signature secret mismatch. 3) Confirm the webhook URL is exactly `https://api.kindora.com/api/v1/payments/<provider>/webhook` - [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) section 2 |
| Donation succeeded but user sees pending | Status page cached/pointing at the wrong API | The status page polls `GET /api/v1/donations/status/<provider>/<publicRef>`, which re-verifies server-side and applies the outcome idempotently; confirm `VITE_API_URL` is the production API and there are no CSP/CORS errors - [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) section 1 |
| Stale PENDING donations piling up | Webhooks down for a while | Run a reconciliation pass: trigger `kindora-reconciliation-digest` (Render "Run now") or the `payments.reconcile` job; the digest lists references to resolve via the backend verifyStatus flow - [CRON_JOBS.md](CRON_JOBS.md) section 2.6, [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) section 6 |

## 5. Redis and queues

| Symptom | Cause | Fix |
| --- | --- | --- |
| API log spammed with `[inline-drop] <queue>.<job> (REDIS_URL not configured)` | `REDIS_URL` unset on `kindora-api` - jobs are dropped, not queued | Set `REDIS_URL` (Blueprint wires it from `kindora-redis`); in production this is a money-path problem (emails, recurring cycles, digests). Wire an alert on this log line - [REDIS_SETUP.md](REDIS_SETUP.md) section 4 |
| `GET /api/v1/health/redis` -> 503 `"configured":false` | `REDIS_URL` unset | Same fix as above |
| `GET /api/v1/health/redis` -> 503 `"configured":true` | Redis unreachable (wrong URL/password/TLS) | `redis-cli -u "$REDIS_URL" ping`; external providers need `rediss://`; check same-region placement |
| Worker exits on boot: `FATAL: REDIS_URL is not set ...` | Missing env var on `kindora-worker` | Set `REDIS_URL` on the worker - it is mandatory - and redeploy - [REDIS_SETUP.md](REDIS_SETUP.md) section 4.2 |
| `redis-cli CONFIG GET maxmemory-policy` is not `noeviction` | Key Value created outside the Blueprint | Set the policy to `noeviction` - evictions would silently delete queued jobs and locks - [REDIS_SETUP.md](REDIS_SETUP.md) section 2 |
| Queue depth growing unbounded | Consumer blocked or a downstream dependency down | Follow the backlog runbook: identify failing dependency in worker logs (SMTP/storage/backend), fix, rely on BullMQ retries; inspect with `redis-cli LLEN bull:<queue>:waiting` and `...:failed` - [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md) section 4 |
| `CRITICAL: [worker:<queue>] job ... permanently failed after 5/5 attempts` | Dead letter after exhausted retries | Fix the root cause, then re-enqueue the affected work (reconciliation and analytics recompute are idempotent) - [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) section 6.4 |

## 6. Database and migrations

| Symptom | Cause | Fix |
| --- | --- | --- |
| `GET /api/v1/health/database` -> 503 "degraded" | Migrations not run yet, or `DATABASE_URL` unreachable | Check the deploy log ran the `preDeployCommand` (`npx prisma migrate deploy`); verify the URL (internal host for co-located services); test with `psql "$DATABASE_URL" -c 'SELECT 1'` - [DATABASE_SETUP.md](DATABASE_SETUP.md) |
| Prisma error P1001 (can't reach the database) | DB down, wrong host, wrong password, or region mismatch | Confirm `kindora-db` is Live; use the internal hostname for same-region services; the external hostname requires TLS (`?sslmode=require`) and the exact password (URL-encoded) - [DATABASE_SETUP.md](DATABASE_SETUP.md) section 3 |
| `prisma migrate deploy` fails on deploy | A failed migration row in `_prisma_migrations`, or schema edited outside migrations | Read the exact failing statement in the deploy log; after fixing, `npx prisma migrate resolve --rolled-back <name>` and deploy a forward-fix migration. Never `db push` against production - [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) section 7.3 |
| Connection pool timeouts at peak | API + worker + crons sharing one DB plan | Check connection count on Render DB metrics; keep transactions short; upgrade the DB plan before scaling instances - [DATABASE_SETUP.md](DATABASE_SETUP.md) section 6 |
| Seed duplicate-key error | Running the seed is normally safe (upserts) - a raw-key conflict means data changed outside the seed assumptions | Inspect the conflicting row (the error names the unique field, e.g. `email`, `slug`, `publicRef`); remove or align the row, then re-run `npm run prisma:seed`. The seed skips existing donations/references by design, so conflicts indicate external edits |

## 7. Storage

| Symptom | Cause | Fix |
| --- | --- | --- |
| `POST /api/v1/storage/uploads` (or `/presign`) returns 503 "Object storage is not configured" | `STORAGE_ENDPOINT`, `STORAGE_BUCKET` or `STORAGE_ACCESS_KEY` empty | Set the `STORAGE_*` variables on `kindora-api` - storage is optional per deployment by design - [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) section 2 |
| Browser CORS error on the presigned PUT (no API error) | Bucket CORS policy missing or origin mismatch | Configure the bucket CORS for `PUT`/`GET` from `https://kindora.com` and `https://www.kindora.com` (exact scheme+host); expose `ETag` - [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) section 5 |
| Upload succeeds but the image does not render | `STORAGE_PUBLIC_BASE_URL` wrong or the public path is not actually public | Fix the base URL (HTTPS) and the bucket's public-read/CDN settings for public kinds; `img-src ... https:` in the CSP already allows any HTTPS host |
| `GET /api/v1/storage/documents/<key>` rejects a key | Only `document/` (or `documents/`) keys are allowed; `..` traversal is blocked | Use document-kind keys; private kinds are fetched via presigned GET by design - [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) section 3 |
| Worker logs `[media] ... pending-external-processing`, no thumbnails | Expected: the workers package ships without a storage SDK; media processing is an honest stub | Implement the documented pipeline (fetch -> sharp -> upload variant) or accept the stub; malware scanning remains an external requirement (ClamAV sidecar/job) - [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) sections 6-7 |

## 8. Email

| Symptom | Cause | Fix |
| --- | --- | --- |
| Emails never send; `EmailLog` rows show `SKIPPED_NO_SMTP` | SMTP variables unset on the **worker** (or the email-sending crons) | Set `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`EMAIL_FROM_ADDRESS` on `kindora-worker`, `kindora-weekly-reports`, `kindora-reconciliation-digest`; already-skipped sends must be re-triggered - [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) section 3 |
| Emails never send; no `EmailLog` rows at all | Backend has no `REDIS_URL` - jobs are `[inline-drop]`ped and never reach the worker | Set `REDIS_URL` on `kindora-api` - [REDIS_SETUP.md](REDIS_SETUP.md) section 4 |
| Emails send but land in spam / rejected | Sending domain not authorized | Publish SPF/DKIM (and DMARC) for the sending domain at your SMTP provider; verify with `dig TXT` - [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md) section 7 |
| SMTP errors in worker logs (auth/connection) | Wrong credentials/port/TLS mode | 587 + `SMTP_SECURE=false` (STARTTLS) vs 465 + `SMTP_SECURE=true`; re-check provider credentials |
| Verification / password-reset email not arriving locally | No SMTP locally (expected skip) or `REDIS_URL` unset on the API | Use `PROVIDER_MODE=mock` + the test flow for local work, or configure SMTP + Redis; note `dev/complete-verification` is **mock-only** and must never be enabled in production - [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) section 6, [SECURITY.md](SECURITY.md) section 10 |

## 9. Throttling and misc

| Symptom | Cause | Fix |
| --- | --- | --- |
| 429 Too Many Requests on login/register/forgot-password/donations | Endpoint rate limits (10/min auth, 5/min password flows, 20/min donations) on top of the 120/min global guard | Expected; back off. Raise limits deliberately in code (`@Throttle`) if the product needs it - [SECURITY.md](SECURITY.md) section 3 |
| `TypeError: Do not know how to serialize a BigInt` in your own scripts | `JSON.stringify` on API data with BigInt fields | Use `String(value)` or a BigInt-aware replacer; the API itself serializes BigInts to strings via `BigIntSerializerInterceptor` - [SECURITY.md](SECURITY.md) section 6 |
| Amounts look 100x off | Mixing major/minor units | All internal amounts are **minor units** (BigInt). Flutterwave/PayPal take major units in some fields - the adapters convert; never convert twice - [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) |
| Cron run exits 1 in Render | Job work threw (DB/Redis/data error) or lock release failed | Read the cron logs (`[cron:<name>] failed after ...`); rerun via dashboard "Run now" - all jobs are idempotent - [CRON_JOBS.md](CRON_JOBS.md) |
| Cron log: `lock held by another instance — exiting 0` | Overlap with a previous/parallel run | Normal - the `kindora:lock:cron:<name>` Redis lock guarantees single execution; no action |
| Recurring charge appears twice for one cycle | Should be prevented by the durable `IdempotencyKey` lock + schedule advance | Verify rather than assume: compare `RecurringDonation.lastChargeAt`/`chargeCount` with the created donations; gather references before reporting - [CRON_JOBS.md](CRON_JOBS.md) section 2.3 |

## 10. Local development quick hits

| Symptom | Cause | Fix |
| --- | --- | --- |
| Donation never completes in mock mode | Frontend pointing at the wrong API, or `PROVIDER_MODE` mismatch | `frontend/.env` needs `VITE_API_URL=http://localhost:10000`; `backend/.env` needs `PROVIDER_MODE=mock`; restart both - [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) section 6 |
| CORS error against `http://localhost:10000` in local dev | `CORS_ORIGINS` still has the 5173 defaults | Set `CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000` (Vite listens on 3000) |
| Worker exits immediately with the `FATAL: REDIS_URL is not set` message | Redis not running or `workers/.env` empty | Start the Redis container and set `REDIS_URL=redis://localhost:6379` |
| `health/redis` 503 with `"configured":false` locally | Working without Redis (acceptable locally) | Expected: queue jobs are `[inline-drop]`ped; run the Redis container when you need emails/analytics |
| Integration tests fail to connect | `DATABASE_URL` not pointing at a disposable Postgres | Use a dedicated test database (CI pattern: `kindora_test` on `postgres:16`) - [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) section 7 |

## 11. Escalation pointers

- Money-path anomalies (stuck PENDING, suspected duplicates, webhook failures): start with
  `WebhookEvent` and `LedgerTransaction` rows, then
  [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) and
  [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) section 6.
- Full outage: follow the disaster-recovery runbook
  ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) section 6) - restore, redeploy,
  verify `/api/v1/health*`, then a reconciliation pass.
- Local-only issues: [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) section 12.

Related: [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [REDIS_SETUP.md](REDIS_SETUP.md) | [CRON_JOBS.md](CRON_JOBS.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)
