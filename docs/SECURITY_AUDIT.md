# KINDORA v1.0.1 — Security Audit Report

Scope: full security review and remediation of the KINDORA crowdfunding platform (backend NestJS API, frontend PWA, background workers, CI/CD, deployment configuration). Every finding below was identified by code audit during this hardening run and either **fixed in source** or explicitly disclosed. Tests cited in §4 were executed against a real PostgreSQL 18.6 instance (see TEST_REPORT.md).

Severity scale: CRITICAL (exploitable, money/data compromise) → HIGH (privilege/integrity risk) → MEDIUM (defence-in-depth) → LOW (hygiene).

---

## 1. Vulnerabilities discovered and remediated

### 1.1 Private document access — IDOR (CRITICAL — fixed)
- **Was:** `GET /storage/documents/*` issued a signed URL for ANY `document/…` key to ANY authenticated user. The service comment documented the gap as deliberate. There was no file registry, so key-guessing/leakage exposed KYC, identity, medical and financial documents. No audit trail existed.
- **Now:**
  - New `StoredFile` registry model (ownership, kind, visibility, scan lifecycle) — every upload intent is registered; **unknown keys fail closed (404) even for admins**.
  - Ownership enforced: uploader, campaign/organization managers, or ADMIN only (403 otherwise, no entitlement leak).
  - Sensitive kinds (DOCUMENT/IDENTITY/EXPENSE_EVIDENCE) require a CLEAN scan verdict before download; without a scanner they stay QUARANTINED (fail-safe).
  - Every privileged (non-owner) access writes an immutable `PRIVILEGED_DOCUMENT_ACCESS` audit record (actor, key, owner, org/campaign/kyc context).
  - Admin reviewer endpoint `GET /admin/files/:id/download-url` issues audited signed URLs.
  - KYC submissions now validate that document fields are storage keys from the submitter's own uploads — an attacker cannot make the admin review console fetch arbitrary or third-party content.
  - **Latent Express 5 bug found by the new e2e suite:** wildcard params arrive as arrays (path-to-regexp v8), silently corrupting key checks (`document,x,y.pdf`). Fixed by normalising the splat; the e2e authorization matrix now proves it.

### 1.2 Withdrawal authorization and integrity (CRITICAL — fixed)
- **Was:** `GET /withdrawals/:id` had zero ownership checks (any authenticated user could read any withdrawal incl. full bank details); `GET /withdrawals/available/:campaignId` was equally open; creation was check-then-act (two concurrent requests could reserve more than the balance); `reject` could overwrite `PAID` via TOCTOU; PAID required nothing but an admin button click.
- **Now:**
  - Ownership on every read/write path (requester / org member / ADMIN); bank details masked (`****last4`) for non-entitled viewers.
  - **Atomic reservations:** creation runs in a transaction that `SELECT … FOR UPDATE`-locks the campaign row and re-computes availability (ledger balance minus ALL reservation-holding states: PENDING, UNDER_REVIEW, APPROVED, PROCESSING, REQUIRES_INFORMATION) before inserting. Proven by the concurrent-overdraw e2e test (two 800k requests vs 1,000,000 → exactly one succeeds).
  - **Explicit state machine** with atomic conditional transitions: `PENDING → UNDER_REVIEW → APPROVED → PROCESSING → PAID`, side states REJECTED / FAILED / CANCELLED / REQUIRES_INFORMATION; rejected/cancelled releases reservations automatically (aggregate-based).
  - **Payout reconciliation:** settlement requires `payoutProvider` + `providerTransferRef` (server-side validated), records `payoutProviderTxnId`, `evidenceUrl`, `paidById` (payer identity preserved separately from approver); duplicate settlement is impossible (unique ledger reference `withdrawal:<id>` → P2002 → 409, proven by e2e).
  - **Dual approval** for payouts at/above `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR` (second, distinct approver recorded). Self-approval forbidden even for admins (proven by e2e).
  - New endpoints: under-review, require-info, second-approval, mark-processing, mark-failed, reconcile, cancel (requester).

### 1.3 Payment webhook integrity (CRITICAL — fixed)
- **Was:** no event-type allowlist (every non-"failed" event → donation SUCCESS — Stripe `checkout.session.expired`, refunds and disputes would all have credited campaigns); no provider-side verification (webhook payload trusted as ground truth); no amount/currency comparison; cross-provider completion possible (a validly-signed Paystack event could complete a Flutterwave donation); `PROVIDER_MODE=mock` silently disabled signature verification on all four public webhook endpoints; MOCK provider selectable in live mode → free donations.
- **Now:**
  - **Explicit per-provider allowlists** (default-deny): only recognised SUCCESS events may trigger completion; TERMINAL_FAILURE / REFUND / DISPUTE routed to dedicated handlers; unknown events recorded (`IGNORED_UNRECOGNIZED`) and acknowledged 200 without touching money state.
  - **Authoritative verification:** the webhook is only a trigger — before any mutation the provider API is queried; the donation completes only when the provider reports `succeeded` AND the amount equals `amount + tip` exactly AND the currency matches. Live-provider successes without an amount are rejected (`AMOUNT_UNAVAILABLE`). Flutterwave `charge.completed` additionally gates on `data.status === 'successful'` (it fires for failed charges too). PayPal requires the capture (not order approval).
  - **Provider equality** enforced in the webhook controller AND again inside `applySuccess` (defence in depth): cross-provider completion is impossible.
  - Public status endpoint derives the provider from the donation record — knowing a publicRef is no longer enough to flip a PENDING donation to FAILED.
  - **Mock hard-gating:** production startup refuses `PROVIDER_MODE=mock`; `adapterFor` never resolves MOCK in live mode; the dev-verification route is not even mounted in production binaries (404 verified).
  - **Idempotency:** DB-unique `(provider,eventId)` with P2002-tolerant duplicate absorption (concurrent duplicate deliveries are exactly-once); Paystack now derives a deterministic eventId (sha256 of the signed body) so replays dedupe at the webhook layer too; every delivery transitions to PROCESSED/processedAt with a `handledAction` for observability.
  - Unknown references are acknowledged (200, `REFERENCE_NOT_FOUND`) instead of 500 — no provider retry storms.

### 1.4 Authentication lifecycle (CRITICAL — fixed)
- **Was:** `cookie-parser` was not installed or registered — the entire httpOnly-cookie refresh flow was dead code (session restoration impossible; server-side logout revocation never happened). `TokenDto.refreshToken` lacked `@IsOptional()` so every empty-body refresh 400'd. CSRF was Origin-check-only with a bypass when `CORS_ORIGINS` was empty. No throttle on `/auth/refresh`. `trust proxy` unset (all users shared one throttle bucket behind Render's proxy) while a spoofable `X-Forwarded-For` was trusted for audit metadata. JWT secret had a hardcoded fallback with no production guard. The dev email-verification route shipped in production binaries (runtime-gated only).
- **Now:**
  - cookie-parser installed + registered in `main.ts` and the test harness, before auth controllers.
  - TokenDto optional — empty-body cookie refresh works (e2e regression test).
  - CSRF layers: Origin allowlist (fail-closed in production when CORS_ORIGINS empty) + `Sec-Fetch-Site: cross-site` rejection (e2e-proven).
  - Throttles: refresh 30/min, logout 10/min added; `trust proxy = 1` set; client XFF no longer trusted for session/audit metadata.
  - **Production fail-fast** (`configuration.ts`): refuses to boot when JWT_SECRET is missing/default, DATABASE_URL missing, PROVIDER_MODE=mock, or live mode has zero provider keys. All four scenarios executed and verified.
  - Dev-verification controller mounted only when the build is mock-mode.
  - Frontend bootstrap fixed: refresh-first session restore (reload/restart keeps users signed in), route guards gate on `bootstrapped` (no login-redirect race), interceptor uses an exact-match skip list (single-flight refresh retained), logout always clears local state (`onSettled`).

### 1.5 Seeding / default credentials (HIGH — fixed)
- **Was:** hardcoded default admin password `Kindora-Admin-2026!` in source, no production gating, demo data unconditional; README documented wrong credentials (`admin@kindora.org / Admin123456!`).
- **Now:** seed refuses in production without `SEED_FORCE=1`; **no default password exists** (`SEED_ADMIN_PASSWORD` required, strength-checked); demo campaigns/donations/ledger rows require explicit `SEED_DEMO=1`; new `npm run bootstrap:admin` is the only production admin path (strong password policy, refuses overwriting existing users/admins, audit-logged `ADMIN_BOOTSTRAP`); README corrected.

### 1.6 Uploads and media (HIGH — fixed)
- **Was:** 15MB ceiling was advisory only (client-side; presigned PUT carried no size condition); `STORAGE_MAX_UPLOAD_MB` was dead config; `publicUrl` was returned for PRIVATE kinds; `/storage/process` accepted arbitrary client URLs (SSRF primitive) and any user could queue other users' keys; media worker was an honest stub.
- **Now:** presigned POST policy with `content-length-range` (object storage itself rejects oversized objects); post-upload `HeadObject` verification (size + content type) with REJECTED transitions; private kinds never receive public URLs; `/storage/process` restricted to the caller's own registered keys with the URL field removed; media worker performs real sharp re-encode/thumbnail/metadata-strip and a fail-safe scan lifecycle (`UPLOADED → QUARANTINED → SCANNING → APPROVED | REJECTED | FAILED | EXPIRED` semantics with `ScanVerdict`).

### 1.7 CI/CD integrity (HIGH — fixed)
- **Was:** two `|| true` lint stages (frontend's referenced a non-existent script — lint had never run); e2e job doubly broken (demo mode baked at build time but env var set only on the test step; four invalid Playwright selectors); no security scanning.
- **Now:** every stage mandatory (zero `|| true`); five jobs (frontend, backend, integration with postgres:16 + seeded admin, workers, e2e) plus a **security job** (`npm audit --audit-level=critical` × 3 packages); e2e build scoped correctly; selectors fixed; npm caching added.

## 2. Preserved and verified-sound (unchanged by design)

- Opaque (non-JWT) refresh tokens, SHA-256-hashed at rest, rotation + reuse detection with family revocation, revocation on logout/password change/reset — all re-proven by the new e2e suite.
- In-memory-only access token on the frontend (XSS-resilient) with single-flight refresh.
- Double-entry ledger invariants (balanced postings, unique references, immutable entries).
- Global guard chain (Throttler → JwtAuth → Roles), bcrypt cost 12, enumeration-safe password reset, hashed single-use email/reset tokens.
- Security headers/CSP/cache discipline on Netlify (HSTS added in v1.0.1).

## 3. Residual risks (disclosed, not silently accepted)

1. **Live provider integrations are unverified** (no credentials in this environment). Refund execution, charge_authorization recurring charges and provider verification are implemented but need sandbox credentials + CI execution (DEPLOYMENT_GUIDE.md §9).
2. **No malware scanner** is bundled: sensitive documents remain quarantined until `MALWARE_SCAN_ENDPOINT` (e.g. ClamAV REST bridge) is configured — fail-safe, but KYC review throughput depends on admins until then.
3. **Per-account brute-force lockout** is not implemented (only IP+route throttles); progressive backoff/CAPTCHA is recommended before public launch.
4. **Throttler store is in-memory** (per-instance); with multiple API replicas the rate limits are per-instance. A shared Redis store is recommended when horizontally scaling.
5. Browser E2E execution happens in CI (no browser in this environment).

## 4. Tests proving the remediation

44 integration tests on real PostgreSQL + 104 backend unit tests + 52 frontend tests, all passing. The security-critical subset: IDOR matrix (withdrawals + storage), concurrent overdraw prevention, webhook exactly-once + default-deny + refund compensation, cookie rotation/reuse/CSRF/logout revocation, production fail-fast (4 scenarios), seeded-admin-only bootstrap. Full inventory in TEST_REPORT.md.
