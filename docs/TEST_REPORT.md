# KINDORA v1.0.1 — Test Report

**Generated:** 2026-11-13 (hardening run)
**Environment:** Linux sandbox, Node v24.22.2, embedded user-space PostgreSQL 18.6 (port 55432), no Redis (queue/lock degradation path exercised deliberately), `PROVIDER_MODE=mock`.

Every number below was produced by an actual command execution during this hardening run. Nothing is copied from a previous report. Where an environment limitation prevented execution, that is stated explicitly.

---

## 1. Command matrix and results

| # | Command | Scope | Result |
|---|---------|-------|--------|
| 1 | `npx eslint "{src,test}/**/*.ts"` (backend) | lint | **0 errors**, 0 warnings after cleanup (2 unused-import warnings fixed) |
| 2 | `npx tsc --noEmit` (backend) | typecheck | **exit 0** |
| 3 | `npm run build` (`nest build`) (backend) | production build | **success** |
| 4 | `npx jest --testPathIgnorePatterns="/test/"` (backend) | unit tests | **7 suites, 104/104 passed, 0 failed, 0 skipped** |
| 5 | `npx prisma migrate deploy` against real PostgreSQL 18.6 | migrations | **0001_init + 0002_hardening applied cleanly** |
| 6 | `SEED_ADMIN_PASSWORD=Ci-Admin-Password-123 npm run prisma:seed` | seed (prod-safe mode) | **admin + categories only; demo data correctly skipped (SEED_DEMO unset)** |
| 7 | `RUN_INTEGRATION=1 npx jest --runInBand --config test/jest-e2e.json` (backend, real Postgres) | integration tests | **5 suites, 44/44 passed, 0 failed** |
| 8 | `npx eslint src` (frontend) | lint | **0 errors**, 9 pre-existing warnings (all in untouched files) |
| 9 | `npx tsc --noEmit` (frontend) | typecheck | **exit 0** |
| 10 | `npx vitest run --config vitest.config.ts` (frontend) | unit tests | **5 files, 52/52 passed** |
| 11 | `npm run build` (frontend, production) | production build | **success** (PWA assets emitted: sw.js, workbox) |
| 12 | `npm run lint:check` && `npm run typecheck` && `npm run build` (workers) | lint/typecheck/build | **all exit 0** |
| 13 | `python3 -c yaml.safe_load(...)` for `render.yaml` and `.github/workflows/ci.yml` | config validity | **both valid** (render.yaml: 9 services + 1 database) |
| 14 | Production fail-fast boot probes (4 scenarios, real DB) | startup validation | **all 4 behave as specified** (see §4) |

## 2. Integration test inventory (44 tests, executed against real PostgreSQL)

### 2.1 money-path.e2e-spec.ts — 12 passed
Full donor→organizer→admin journey with the mock provider:
- health endpoints respond (database up, redis degraded without REDIS_URL)
- registers donor and organizer, completes mock verification, acquires tokens
- creates and submits a campaign as the verified organizer
- admin approves the campaign; admin stats + reconciliation reachable
- donor donates 2,500,000 + 125,000 tip via the MOCK provider
- server-side verify drives PENDING → SUCCEEDED with a receipt number
- **duplicate verify + mock webhook replay do NOT double-post (balance stays 2,500,000)**
- campaign denormalised counter is ledger-consistent (raisedAmount 2,500,000)
- withdrawal flow: request 1,000,000 → admin approve → mark-paid (with payoutProvider) → available 1,500,000
- public transparency feed shows the ledger transactions (DONATION + WITHDRAWAL types)
- donor can list own donations and notifications
- impact summary reports successful donations

### 2.2 auth.e2e-spec.ts — 16 passed
- register 201 without passwordHash leak; duplicate 400
- login sets httpOnly `kindora_refresh` cookie (body carries accessToken only)
- /auth/me with Bearer 200 / without token 401
- **cookie-only silent refresh: EMPTY body + cookie → 200 with rotated cookie** (regression test for the fixed 400)
- refresh without any token → 401
- reuse of the rotated refresh token → 401 (family revocation)
- two consecutive cookie refreshes each rotate; replaying the first cookie is rejected
- **refresh with `Sec-Fetch-Site: cross-site` → 401 (CSRF defence)**
- cookie logout revokes the session (later refresh with same cookie → 401)
- body-token logout revokes + clears cookie
- wrong password 401, never issues a cookie
- forgot-password enumeration safety + per-route throttle smoke

### 2.3 withdrawals.e2e-spec.ts — 9 passed
- **donors (non-managers) get 403 on available-balance and payout creation** (IDOR fix)
- organizer sees the full ledger balance available for payout
- non-entitled viewers only see MASKED bank details (`****6789`); entitled viewer sees full destination
- organizer cannot call admin routes (roles guard)
- **requester-self-approval forbidden even for admins** (separation of duties)
- second-approver confirmation flow works; self-second-approval forbidden
- **mark-paid without payoutProvider/providerTransferRef → 400; duplicate settlement → 409**
- available balance reflects the posted payout (reservation released, liability debited)
- **concurrent withdrawal requests cannot overdraw: exactly one of two parallel 800k requests succeeds against a 1,000,000 balance** (row-locked reservation)

### 2.4 webhooks.e2e-spec.ts — 4 passed
- **unknown event type (`payout.settled`) is acknowledged 200 and changes NO donation/ledger state** (default-deny allowlist)
- invalid signature → 400, and no `signatureValid=true` WebhookEvent row is recorded
- charge.success applied exactly once; concurrent duplicate deliveries absorbed; ledger posts once
- refund.processed → donation REFUNDED, compensating ledger entries exist (REFUND txn), raisedAmount decreases

### 2.5 storage.e2e-spec.ts — 3 passed
- 503 when object storage is not configured
- **authorization matrix: non-owner authenticated user → 403; unknown/untracked key → 404 even for admin (fail closed); admin access → 200 with signed URL + `PRIVILEGED_DOCUMENT_ACCESS` audit row; owner access not audit-logged; quarantined sensitive document blocked for owner until scanned**
- 401 without a token

## 3. Frontend unit tests (52) and workers

- frontend: 5 files — money (14), utils (14), demo-adapter (6), auth-store incl. **bootstrap-order regression tests** (refresh-first, failure clears state without calling /auth/me), withdrawal-form validation (10).
- workers package: no dedicated unit test runner is configured; verification is typecheck + build + lint (all green). The recurring-charge and media pipelines are exercised in deployments via queue jobs; their DB flows mirror the backend paths covered by the integration suite.

## 4. Production startup validation (executed, real DB)

| Scenario | Expected | Observed |
|---|---|---|
| `NODE_ENV=production`, no `JWT_SECRET` | refuse to start | **Refusing to start: production configuration is unsafe** (exit before listen) |
| `NODE_ENV=production`, `PROVIDER_MODE=mock` | refuse to start | **Refusing to start** |
| `NODE_ENV=production`, live mode, zero provider keys | refuse to start | **Refusing to start** |
| Valid production config (`PROVIDER_MODE=live`, Paystack dummy key) | boot + dev route unmounted | **health 200; `POST /auth/dev/complete-verification` → 404 (route not mounted); mock donations unreachable** |

## 5. Migration safety

- `0002_hardening` was generated by `prisma migrate diff` (original v1.0.0 schema → hardened schema) and applied to a live PostgreSQL 18.6 instance: **forward-only DDL only** (new enums, new columns, new table, new foreign keys). No destructive statements, no data rewrites. Verified by `prisma migrate deploy` exit 0.

## 6. Known limitations (honest disclosure)

1. **Live provider network paths are not exercised.** No Paystack/Flutterwave/Stripe/PayPal credentials exist in this environment. All provider-side behaviour is verified through the deterministic mock adapter plus unit tests of signature verification (HMAC-SHA512, verif-hash, Stripe SDK, PayPal parse hardening). Actual API calls (`verify`, `refund`, `charge_authorization`) are implemented but unproven against the real services. They are exercised by CI only when real sandbox credentials are configured (documented in DEPLOYMENT_GUIDE.md §9).
2. **Playwright E2E (browser) tests were not executed in this environment** (no browser binaries / no display pipeline). The four invalid selectors and the demo-mode build-scoping bug were fixed in source; the `e2e` CI job (PR-only) is the execution gate.
3. **Playwright/Chromium download and ClamAV are unavailable here**: malware scanning runs in fail-safe mode (sensitive documents stay quarantined; public images are re-encoded) unless `MALWARE_SCAN_ENDPOINT` is configured.
4. **CI execution itself was not observed** — the workflow is rewritten and locally validated (YAML parse + every command executed at least once locally), but no GitHub Actions run was triggered from this environment. First push will prove it end to end.

## 7. Previous report claims — correction record

| Claim in v1.0.0 FINAL_REPORT.md | Truth | Correction |
|---|---|---|
| `scripts/e2e-smoke.mjs PASS` | **false** — the script never existed | reference removed; the money-path coverage now lives in `backend/test/money-path.e2e-spec.ts` (executed) |
| "ESLint all three packages 0 errors" | not reproducible (lint steps were `|| true`) | lint is now a mandatory CI stage; 0 errors verified locally |
| "Browser verification zero console errors PASS" | unsupported claim | Playwright specs fixed; execution delegated to CI (disclosed above) |
| "164 automated tests" | unverifiable counting | real counts in this document: **104 backend unit + 44 integration + 52 frontend = 200 executed in this environment**, plus 4 browser suites in CI |
| "admin@kindora.org / Admin123456!" (README) | wrong domain and wrong password | README corrected; no default password exists anymore |
