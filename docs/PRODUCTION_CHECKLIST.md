# Production Checklist

Ordered go-live checklist for KINDORA. Work top to bottom; do not open donations to the
public until every box is checked. Each item links to the doc with the how-to.

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [SECURITY.md](SECURITY.md) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## 1. DNS and domains

- [ ] `kindora.com` apex resolves to Netlify (`A` records `75.2.60.5` and `99.83.190.103`,
      or ALIAS/ANAME to `apex.loadbalancer.netlify.com`, or full Netlify DNS delegation) -
      [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md)
- [ ] `CNAME www -> your-site.netlify.app` added; Netlify marks the domain verified
- [ ] `CNAME api -> your-render-service.onrender.com` added; Render marks
      `api.kindora.com` verified
- [ ] HTTPS certificates active on `kindora.com`, `www.kindora.com` and `api.kindora.com`;
      Force HTTPS enabled on Netlify
- [ ] One canonical frontend host chosen; the other host 301-redirects to it;
      `VITE_APP_URL` equals the canonical host
- [ ] Deep-link test passed: `https://kindora.com/campaigns/<slug>` opens and survives a
      refresh

## 2. Environment variables

- [ ] All Netlify `VITE_*` variables set (`VITE_APP_NAME`, `VITE_APP_URL`,
      `VITE_API_URL=https://api.kindora.com`, `VITE_ENVIRONMENT=production`,
      `VITE_DEFAULT_CURRENCY=NGN`, `VITE_DEFAULT_LANGUAGE=en`) - [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md)
- [ ] `VITE_DEMO_MODE` unset/empty on Netlify (all deploy contexts); no demo data in the
      live bundle
- [ ] No secrets in any `VITE_` variable
- [ ] All Render `sync: false` variables filled on `kindora-api` (section 4 of
      [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md)), `kindora-worker`, and the crons that
      need extras
- [ ] `JWT_SECRET` / `SESSION_SECRET` generated (Blueprint `generateValue: true` or
      `openssl rand -hex 32`); never rotated casually afterwards
- [ ] `CORS_ORIGINS` = exact production origins only
      (`https://kindora.com,https://www.kindora.com`) - no localhost values remain
- [ ] `PROVIDER_MODE=live` confirmed on the API (mock is dev/test-only and enables the
      verification-bypass hook) - [SECURITY.md](SECURITY.md)

## 3. Database migrations and seed

- [ ] Blueprint/manual deploy ran `npx prisma migrate deploy` green (check the API deploy
      log); `_prisma_migrations` has no failed rows - [DATABASE_SETUP.md](DATABASE_SETUP.md)
- [ ] `GET /api/v1/health/database` returns 200
- [ ] Production seeded only if intended: run with `SEED_ADMIN_PASSWORD` set, ideally
      **before** opening donations; unwanted seed campaigns deleted
- [ ] Admin password rotated immediately after seeding: log in as `admin@kindora.com` with
      the supplied `SEED_ADMIN_PASSWORD` value and change it; confirm the supplied value no
      longer works
- [ ] Internal connection string used by API/worker/crons; external string used only from
      your workstation

## 4. SMTP and email deliverability

- [ ] `SMTP_HOST` / `SMTP_PORT` (587) / `SMTP_USER` / `SMTP_PASSWORD` /
      `EMAIL_FROM_ADDRESS` set on the API, the worker, `kindora-weekly-reports` and
      `kindora-reconciliation-digest`
- [ ] Sending domain verified at the provider; SPF/DKIM (and DMARC) records published -
      [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md)
- [ ] Test receipt delivered (sandbox donation) and `EmailLog` shows `SENT` (not
      `SKIPPED_NO_SMTP`)

## 5. Storage bucket

- [ ] S3-compatible bucket created; `STORAGE_ENDPOINT`, `STORAGE_BUCKET`,
      `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_PUBLIC_BASE_URL` set on the
      API - [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md)
- [ ] Bucket CORS allows `PUT` from the production frontend origins
      (`https://kindora.com`, `https://www.kindora.com`)
- [ ] Campaign image upload verified end-to-end (presign -> direct PUT -> public URL
      renders over HTTPS)
- [ ] `document/` / `identity/` keys confirmed private (no public URLs; presigned GET
      only); malware-scanning plan documented as an external requirement

## 6. Payment providers (sandbox -> live)

- [ ] Sandbox E2E passed for every enabled provider (test cards, decline path, webhook
      duplicate, ledger balance) - [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md)
- [ ] Live keys set: `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `STRIPE_SECRET_KEY`,
      `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`
- [ ] `PAYPAL_ENV=live` added (default everywhere is sandbox)
- [ ] Webhooks registered on the **live** dashboards:
      `https://api.kindora.com/api/v1/payments/paystack/webhook`,
      `https://api.kindora.com/api/v1/payments/flutterwave/webhook`,
      `https://api.kindora.com/api/v1/payments/stripe/webhook`,
      `https://api.kindora.com/api/v1/payments/paypal/webhook`
- [ ] Signature secrets set and matching the live dashboards: Paystack secret key (HMAC
      SHA512), `FLUTTERWAVE_WEBHOOK_HASH` (= dashboard secret hash), `STRIPE_WEBHOOK_SECRET`
      (`whsec_...`), `PAYPAL_WEBHOOK_ID`
- [ ] Callback/return URL `https://kindora.com/donate/status` configured per provider
- [ ] One small **real** transaction tested end-to-end on the primary provider and
      confirmed/refunded on the provider dashboard
- [ ] `WebhookEvent` rows show `RECEIVED` (not `FAILED`) for the live test

## 7. VAPID keys (web push)

- [ ] `npx web-push generate-vapid-keys` run once; `VAPID_PUBLIC_KEY` and
      `VAPID_PRIVATE_KEY` set on the API and the worker; `VAPID_SUBJECT` =
      `mailto:<contact@your-domain>`
- [ ] A test push delivered after subscribing from the PWA

## 8. Monitoring and alerting

- [ ] `SENTRY_DSN` set on the API (frontend CSP already allows `https://*.sentry.io`);
      a test error visible in Sentry
- [ ] Uptime monitors on `/api/v1/health`, `/api/v1/health/database`, `/api/v1/health/redis`
      (the latter must report `"configured":true`)
- [ ] Alert rule on `[inline-drop]` API log lines (means `REDIS_URL` is missing/broken and
      background work is being dropped) - [REDIS_SETUP.md](REDIS_SETUP.md)
- [ ] Alert on worker `CRITICAL: ... permanently failed` log lines (dead letters) -
      [BACKGROUND_WORKERS.md](BACKGROUND_WORKERS.md)
- [ ] `ADMIN_EMAILS` set on worker + weekly-reports + reconciliation-digest; the 04:00 UTC
      reconciliation digest email confirmed deliverable
- [ ] Log retention/notification channel for Render services agreed with the team

## 9. Cron jobs and worker

- [ ] All six crons Live with the render.yaml schedules (daily-analytics 02:30 UTC,
      campaign-reminders hourly :05, recurring-donations every 15 min, weekly-reports
      Mon 07:00, database-maintenance Sun 03:00, reconciliation-digest daily 04:00) -
      [CRON_JOBS.md](CRON_JOBS.md)
- [ ] One manual "Run now" executed per cron; every run exits 0
- [ ] Worker boot log shows `[worker] redis connection verified` and
      `[worker] online — queues: email, push, notifications, analytics, media, fraud, payments, reports`

## 10. Load smoke test

- [ ] Home + campaign list at realistic concurrency (e.g. 50 virtual users for 5 minutes):
      no 5xx, acceptable p95
- [ ] Donation creation under load respects rate limits (429s expected beyond 20/min/IP)
      and idempotency keys deduplicate retries
- [ ] Queue depths return to baseline after the test; no `CRITICAL` worker lines
- [ ] DB connection count within plan limits - [DATABASE_SETUP.md](DATABASE_SETUP.md)

## 11. Rollback plan

- [ ] Rollback rehearsed: current good Render deploy ID and Netlify deploy ID recorded;
      team knows the **Events -> Rollback** / **Deploys -> Rollback** paths -
      [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)
- [ ] Migration rollback policy understood (forward-fix, never destructive) and
      `prisma migrate resolve` documented
- [ ] PITR/automated backups **enabled on the paid database plan**; first manual
      `pg_dump` taken and restorability verified
- [ ] Incident contacts and escalation path published internally

## 12. Final end-to-end verification

- [ ] Fresh guest donation on production with a small real transaction: donate -> checkout
      -> status page shows succeeded -> receipt email received
- [ ] Ledger: admin transactions shows the balanced `donation:<id>` transaction; campaign
      payable increased by the amount
- [ ] `WebhookEvent` row `RECEIVED` - the donation finalized by webhook, not only the
      status poll
- [ ] Security headers present on the frontend (`curl -I https://kindora.com`); no
      console CSP/CORS errors
- [ ] `GET https://api.kindora.com/api/v1/health/redis` -> 200 with `"configured":true`
- [ ] All checklist items above green - then open donations to the public

Related: [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) | [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) | [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md) | [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [SECURITY.md](SECURITY.md) | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)
