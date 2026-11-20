# KINDORA v1.0.1 — Production Hardening Report

**Baseline:** KINDORA v1.0.0 (supplied source, SHA-256 `e11d73f30c14ac02a0df8f4d581527328a5c1ebb10f9edfd031306594518cc21`, preserved unmodified in `KINDORA_v1.0.0_ORIGINAL_BACKUP.zip`).
**Result:** KINDORA v1.0.1 — Production Hardened Edition (`KINDORA_v1.0.1_PRODUCTION_HARDENED.zip`).
**Approach:** production hardening, not a redesign. The v1.0.0 architecture (NestJS + Prisma + PostgreSQL API, React/Vite PWA on Netlify, BullMQ workers + cron on Render), branding, features, routes and integrations are preserved; every fix in this report is additive or corrective inside that architecture.

---

## 1. Problems identified in the supplied source (audit summary)

A four-track audit of the supplied v1.0.0 source found 54 tracked issues. The critical set, each confirmed in code before repair:

| Area | Severity | Problem (v1.0.0) |
|---|---|---|
| Storage | CRITICAL | Any authenticated user could mint signed URLs for any `document/` key (IDOR); no file registry; no audit; public URLs returned for private kinds |
| Withdrawals | CRITICAL | `GET /withdrawals/:id` leaked bank details without ownership checks; `available/:campaignId` open; check-then-act creation allowed concurrent overdraw; `reject` could overwrite `PAID` (TOCTOU); PAID via bare button click; no dual approval |
| Webhooks | CRITICAL | No event allowlist (expired checkouts/refunds/disputes could credit campaigns); webhook payload trusted without provider verification; no amount/currency check; cross-provider completion possible; `PROVIDER_MODE=mock` disabled signature verification; MOCK provider selectable in live mode (free donations) |
| Auth | CRITICAL | cookie-parser missing (cookie flow dead code; logout never revoked); empty-body refresh 400'd; weak CSRF; no refresh throttle; spoofable XFF trusted; JWT secret fallback without prod guard; dev verification route in prod binaries; frontend bootstrapped `/auth/me` before refresh → reload logged users out |
| Seed | HIGH | Hardcoded admin password, no prod gating, unconditional demo data, wrong README credentials |
| Uploads/media | HIGH | Size ceiling advisory-only; media worker a stub; `/storage/process` SSRF primitive |
| Recurring | CRITICAL | Schedule advanced without charging anyone; `providerAuthRef` never captured anywhere |
| CI | HIGH | Two `|| true` lint stages (frontend lint script didn't exist — never ran); e2e job doubly broken (build-time demo mode + 4 invalid selectors); no security scan; phantom `scripts/e2e-smoke.mjs` claim |
| Ledger | MEDIUM | Provider fees captured but never posted; refund didn't reverse matching; account-creation race rolled back money movements; WebhookEvents never PROCESSED |
| Deploy | MEDIUM | Starter plans for a financial platform; `PAYPAL_ENV=sandbox` hardcoded; CSP blocked pre-DNS API calls; no HSTS; health checks liveness-only |

## 2. Fixes implemented (by priority-zero order)

### 2.1 Private document access & IDOR (§3.1)
New `StoredFile` registry (ownership/kind/visibility/scan lifecycle); authorization matrix (owner → campaign/org managers → ADMIN) with fail-closed 404 for untracked keys; masked vs full destinations n/a here but audited privileged access (`PRIVILEGED_DOCUMENT_ACCESS`) with actor/key/owner/context; admin reviewer endpoint; KYC submissions restricted to the submitter's own registered storage keys. Storage controller normalises Express 5 wildcard arrays (latent routing bug found and fixed by the new e2e suite).

### 2.2 Withdrawal security (§3.2)
Resource ownership on all endpoints; field-level masking of bank details; transactional creation with `SELECT … FOR UPDATE` row locks and availability re-check (atomic reservations incl. every reservation-holding state); explicit atomic state machine (PENDING → UNDER_REVIEW → APPROVED → PROCESSING → PAID + REJECTED/FAILED/CANCELLED/REQUIRES_INFORMATION); payout settlement requires `payoutProvider` + `providerTransferRef` (+ optional txn id/evidence), records `paidById` separately from the approver, forbids payer==requester, enforces configurable dual approval (`WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR`), duplicate settlement → 409; reconciliation endpoint attaches evidence; requester cancel added.

### 2.3 Webhook & payment security (§4)
Per-provider event allowlists (default-deny); authoritative provider verification with exact amount (`amount+tip`) and currency equality; provider equality checks at two layers; Flutterwave `data.status` gate; PayPal capture-level verification; mock adapter hard-gated (startup refusal in production; dev route unmounted — verified 404); webhook-level dedupe with P2002 tolerance + derived Paystack eventIds; `PROCESSED`/`handledAction` lifecycle; unknown-reference acknowledgement; public status endpoint derives provider from the donation record.

### 2.4 Authentication restoration (§5)
cookie-parser installed/registered (backend + tests); optional token DTO; CSRF via Origin allowlist (fail-closed in prod) + `Sec-Fetch-Site` rejection; throttles on refresh/logout; `trust proxy 1` + no client-XFF trust; production fail-fast validation (JWT_SECRET/DATABASE_URL/mock-mode/zero-providers — all four refusal scenarios executed); frontend refresh-first bootstrap, bootstrapped-gated route guards, exact-match interceptor skip list, logout always clears state. Refresh rotation + reuse detection preserved from v1.0.0.

### 2.5 Seeding (§6)
Production-refusing seed (`SEED_FORCE` guard), mandatory strong `SEED_ADMIN_PASSWORD`, demo data behind `SEED_DEMO=1`, new `npm run bootstrap:admin` (fail-safe, audited `ADMIN_BOOTSTRAP`), README credentials corrected.

### 2.6 Recurring donations (§7)
Real Paystack off-session charging with per-cycle idempotency; schedule advances only on confirmed success; failure bookkeeping (`failureCount`, `lastFailure*`) with donor/organizer notifications and PAUSE at 3 failures; `providerAuthRef` captured from provider verification and persisted on donations; non-Paystack schedules explicitly skipped with donor notices (no fake charges).

### 2.7 Uploads & media (§8)
Presigned POST with `content-length-range` (storage-side size enforcement) wired to `STORAGE_MAX_UPLOAD_MB`; post-upload HeadObject verification (size + content type) with rejection transitions; private/public visibility separation (no public URLs for private kinds); `UPLOADED → QUARANTINED → SCANNING → APPROVED/REJECTED/FAILED` lifecycle with fail-safe malware posture (`MALWARE_SCAN_ENDPOINT` integration; sensitive kinds stay quarantined without a scanner); media worker performs real sharp re-encoding (WebP 1600/q82 + 480px thumb, EXIF stripped) with transient/permanent failure distinction.

### 2.8 Financial Control Centre (§9)
New `financial` module: per-currency summary with filters; payment reconciliation with anomaly classification; withdrawal reconciliation (needsReconciliation/missing evidence/outstanding reservations); read-only ledger integrity checks (balanced transactions, campaign counter identity, totalCharged consistency); audited CSV reports (daily closing, campaign balances, withdrawals, refunds, platform fees); audit history viewer. Frontend: currency-tabbed dashboard + reconciliation workbench.

### 2.9 Ledger integrity (§10)
Provider-fee postings (`fee:donation:<id>`); match reversals on full refunds; refund processor shared by admin and webhook paths (proportional split for partial refunds); account-creation race tolerance; availability includes all reservation states; counters decremented under guard.

### 2.10 CI/CD and tests (§11)
ci.yml fully rewritten: zero `|| true`, mandatory lint (frontend `lint:check` script added), typecheck, unit, integration (postgres:16 + migrate deploy + seeded admin), prisma validate, three production builds, fixed e2e job (VITE_DEMO_MODE at build time, selectors fixed), new security job (`npm audit --audit-level=critical` ×3), npm caching. New integration suites: webhooks (4), withdrawals (9), storage (3) + hardened money-path (12) + auth cookie flows (16). Phantom `scripts/e2e-smoke.mjs` claim removed.

### 2.11 Deployment hardening (§12)
render.yaml: standard plans for API/worker, `region: oregon` pinned across all 9 services, `PAYPAL_ENV` operator-controlled (`sync: false`), missing env vars added (JWT TTLs, DEFAULT_CURRENCY, dual-approval threshold, STORAGE_MAX_UPLOAD_MB, VAPID_SUBJECT, MALWARE_SCAN_ENDPOINT for the worker, PAYSTACK key for the recurring cron), fail-fast startup documented, `/health/database` monitoring guidance. netlify.toml: CSP `connect-src` extended with `https://*.onrender.com` (pre-DNS deployability), HSTS added, API never cached; service worker stays NetworkOnly for `/api/`.

## 3. Database changes (forward-only migration `0002_hardening`)

Generated by `prisma migrate diff` from the v1.0.0 schema; applied cleanly to PostgreSQL 18.6. **No destructive statements; no data rewrites; existing rows untouched.**

- New enums: `FileVisibility`, `StoredFileKind`, `StoredFileStatus`, `ScanVerdict`
- New table: `StoredFile` (registry: key unique, ownership, campaign/org/withdrawal/kyc links, scan lifecycle)
- `Withdrawal`: + `payoutProvider`, `payoutProviderTxnId`, `evidenceUrl`, `paidById`, `secondApprovedById/At`, `reconciledAt/ById`; enum + `UNDER_REVIEW`, `CANCELLED`, `REQUIRES_INFORMATION`
- `Donation`: + `providerFeeMinor`, `providerAuthRef`
- `WebhookEvent`: + `handledAction`
- `RecurringDonation`: + `failureCount`, `lastFailureAt`, `lastFailureReason`

Migration/rollback strategy: forward-only deploys via `prisma migrate deploy` (preDeployCommand); a failed migration blocks the release from starting (Render rollback). Rollback plan documented in RECOVERY_GUIDE.md (point-release redeploy of v1.0.0 artifacts is safe because every added column is nullable or defaulted).

## 4. Files changed / added (summary)

- **Backend:** payments (interface, event-classification, 4 providers + mock, webhooks controller, donation-payment, payments service, refund-processor NEW), ledger service, withdrawals (service/controller/DTO rewritten), storage (service/controller/DTO rewritten, types NEW), auth (controller/module/dev-controller NEW, main.ts, configuration fail-fast), users (KYC key validation), admin (refund delegation, reviewer endpoint), financial module (NEW, 4 files), donations (DTO/service), prisma schema + migrations + seed + bootstrap-admin (NEW)
- **Workers:** recurring-donations (rewritten), media processor (rewritten), env/templates/email/index updates, schema re-sync
- **Frontend:** auth store/http/guards bootstrap fixes, logout hardening, withdrawal admin UI (dual-approval-aware mark-paid dialog, new state actions), organizer cancel + upload media tab with scan status, presigned-POST upload helper (NEW), donation status accuracy, financial centre pages (NEW), financial hooks (NEW)
- **CI:** ci.yml rewritten; package.json script additions (lint:check, bootstrap:admin, seed:demo)
- **Config:** render.yaml, netlify.toml, backend/.env.example
- **Docs:** 6 new reports + FINAL_REPORT truth pass (see §7)

## 5. Verification results (real numbers)

Executed in this environment (see TEST_REPORT.md for the complete command matrix):

| Gate | Result |
|---|---|
| Backend lint / typecheck / build | 0 errors / exit 0 / success |
| Backend unit tests | **104/104 passed** |
| Backend integration (real PostgreSQL 18.6, migrations deployed) | **44/44 passed** (money-path 12, auth 16, withdrawals 9, webhooks 4, storage 3) |
| `prisma migrate deploy` | 0001 + 0002 applied cleanly |
| Frontend lint / typecheck / unit / build | 0 errors / exit 0 / **52/52** / success |
| Workers lint / typecheck / build | all exit 0 |
| render.yaml + ci.yml YAML validity | valid |
| Production fail-fast (4 scenarios) | refuses without JWT_SECRET; refuses mock mode; refuses zero providers; valid config boots with dev route 404 |

## 6. Remaining limitations (honest)

1. Live provider network paths (verify/refund/charge_authorization) are implemented but need real sandbox credentials to be exercised — integration points documented, mock-mode tests prove the surrounding state machines.
2. Playwright browser suites fixed but executed only in CI (no browser here).
3. Malware scanning requires an external `MALWARE_SCAN_ENDPOINT` (fail-safe quarantine otherwise).
4. CI itself runs on first push (workflow validated locally, not observed in Actions).

## 7. Companion reports

`SECURITY_AUDIT.md` (vulnerability-by-vulnerability), `FINANCIAL_INTEGRITY_REPORT.md` (ledger/payment/reservation guarantees), `TEST_REPORT.md` (executed command matrix), `DEPLOYMENT_GUIDE.md`, `RECOVERY_GUIDE.md`, plus the corrected legacy `FINAL_REPORT.md`.
