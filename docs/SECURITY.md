# Security

KINDORA's security design: authentication and sessions, authorization, rate limits,
payment webhook verification, ledger invariants and exactly-once money application,
idempotency keys, storage access rules, browser hardening and CSP, the mock-only dev
verification hook (and why it must never be enabled in production), data-protection
notes, the audit trail, and secret management rules.

Code references: `backend/src/auth/auth.service.ts`, `backend/src/auth/auth.controller.ts`,
`backend/src/app.module.ts`, `backend/src/main.ts`,
`backend/src/payments/webhooks.controller.ts`, `backend/src/ledger/ledger.service.ts`,
`backend/src/storage/storage.service.ts`, `frontend/netlify.toml`,
`frontend/src/stores/auth-store.ts`, `frontend/src/lib/http.ts`.

Related: [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) | [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md)

---

## 1. Authentication design

| Element | Implementation |
| --- | --- |
| Password hashing | `bcryptjs` with **12 rounds** (`BCRYPT_ROUNDS = 12`, `auth.service.ts`) |
| Password policy | Minimum 10 characters, at least one uppercase letter and one digit (DTO validators on register and reset) |
| Access token | JWT, **15 minutes** (`JWT_ACCESS_TTL=900`), kept **in memory only** in the frontend store (`frontend/src/stores/auth-store.ts`) - never `localStorage`/`sessionStorage`; gone on page reload |
| Refresh token | 48-byte random token, stored **hashed** in the `Session` table; delivered as an `httpOnly` cookie |
| Refresh cookie | `kindora_refresh`: `httpOnly: true`, `secure: true` + `sameSite: 'none'` in production (`lax` in dev), `path: /api/v1/auth`, `maxAge` = `JWT_REFRESH_TTL_DAYS` (30 days). It is scoped to the **API domain** and the auth path - the frontend JavaScript never reads or stores it |
| Rotation | Every `POST /api/v1/auth/refresh` issues a **new** refresh token and revokes the presented one (single-use tokens; the old `Session` row gets `revokedAt`) |
| Reuse detection | Presenting a **revoked** refresh token is treated as theft: **all active sessions for that user are revoked** (the token family dies) and an `AuditLog` row `AUTH_REFRESH_REUSE_DETECTED` is written |
| Origin checks | `refresh` and `logout` call `assertOrigin`: an `Origin` header outside `CORS_ORIGINS` is rejected with 401 ("Origin not allowed") - CSRF defence-in-depth; header-less server-to-server calls pass |
| Email verification | `AuthToken` rows (`VERIFY_EMAIL`, hashed token, 24h expiry), consumed on use |
| Password reset | `AuthToken` (`PASSWORD_RESET`, 1h expiry); on success the password is re-hashed (bcrypt 12) and **all active sessions are revoked** |
| Account enumeration | `forgotPassword` always reports success; invalid logins use a uniform "Invalid email or password" |
| Axios wiring | The frontend `http.ts` client sets `withCredentials: true`, attaches the Bearer token from memory, and on a 401 (non-auth route) retries once via a single-flight `POST /auth/refresh` |

### Why the access token lives in memory only

A short (15-minute) access token stored in memory cannot be stolen by XSS reading
`localStorage`, and its blast radius expires within minutes. The long-lived credential is
the refresh token, which the browser holds in an `httpOnly` cookie JavaScript cannot read.
`SameSite=None; Secure` is required because the cookie lives on the API domain while the
app runs on the frontend domain - which is exactly why the explicit `Origin` allowlist
check exists on refresh/logout. Combined with rotation and reuse detection, a stolen
refresh cookie can at most mint one access token before the whole family is revoked. The
cost is a refresh call on page reload - an acceptable trade for a money-handling app.

## 2. Authorization

- **Global guards** (registered in `app.module.ts`, order matters): `ThrottlerGuard`
  (rate limiting), then `JwtAuthGuard` (all routes require a valid JWT unless marked
  `@Public()`), then `RolesGuard` (role checks).
- **`@Public()` decorator** opts individual routes out of JWT auth (health endpoints,
  login/register, donation creation, status poll, provider webhooks).
- **`@Roles('ADMIN')`** on the admin controller: campaign moderation, user suspension,
  refunds, KYC review, reconciliation views - all ADMIN-only; `UserRole` is
  `USER | ORG_ADMIN | ADMIN`.
- Route handlers never trust client-side identity: the current user comes from the JWT
  (`@CurrentUser()`), and money state changes only through guarded server-side paths.

## 3. Rate limits (@nestjs/throttler)

Global guard: **120 requests / minute per IP**
(`ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])`).

Endpoint-specific overrides (`@Throttle`):

| Endpoint | Limit |
| --- | --- |
| `POST /api/v1/auth/register` | 10/min |
| `POST /api/v1/auth/login` | 10/min |
| `POST /api/v1/auth/forgot-password` | 5/min |
| `POST /api/v1/auth/reset-password` | 5/min |
| `POST /api/v1/donations` | 20/min |

Exceeded clients receive `429`; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 4. Payment webhook signature verification

`WebhooksController` (`/api/v1/payments/{provider}/webhook`) requires a **valid signature
over the raw request body** (`rawBody: true` at app creation) before anything is
processed. Invalid signatures: a `WebhookEvent` row with `status: FAILED` and
`error: 'signature verification failed'` is recorded, and the request is rejected with
400 - never processed. Valid payloads are stored for audit with duplicate detection
(`provider` + `eventId` unique per provider).

| Provider | Method | Secret (env var) |
| --- | --- | --- |
| Paystack | HMAC **SHA512** of the raw body, constant-time hex compare, header `x-paystack-signature`; no event id -> state-machine dedupe | `PAYSTACK_SECRET_KEY` |
| Flutterwave | Constant-time compare of the `verif-hash` header against the configured secret hash; event id = transaction id | `FLUTTERWAVE_WEBHOOK_HASH` |
| Stripe | Official SDK `webhooks.constructEvent(rawBody, stripe-signature, secret)`; event id = `event.id` | `STRIPE_WEBHOOK_SECRET` |
| PayPal | Official **verification API** (`/v1/notifications/verify-webhook-signature`) using the transmission headers + webhook ID; event id = payload event id | `PAYPAL_WEBHOOK_ID` + client credentials |

A missing secret is treated exactly like a bad signature (`valid: false`) - an
unconfigured provider cannot be spoofed. Full provider setup:
[PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md).

## 5. Ledger invariants and exactly-once donation application

`LedgerService` (`backend/src/ledger/ledger.service.ts`) enforces on **every** post:

1. **Balance**: sum(DEBIT) == sum(CREDIT) **per currency** within a transaction -
   imbalance throws and the transaction rolls back.
2. **Exactly-once**: every transaction `reference` is unique - `donation:<donationId>`,
   `match:<poolId>:<donationId>`, `withdrawal:<withdrawalId>`, `refund:<refundId>` - so
   the same economic event can never be posted twice.
3. **Immutability**: posted `LedgerEntry` rows have no update or delete code paths.

System account codes (`LEDGER_CODES`):

| Code | Type | Meaning |
| --- | --- | --- |
| `1100:CLEARING:<currency>` | ASSET | Provider clearing (money at the provider) |
| `2000:CAMPAIGN:<campaignId>:<currency>` | LIABILITY | Campaign payable |
| `4000:PLATFORM_REVENUE:<currency>` | REVENUE | Platform tips & fees |
| `2400:MATCH_POOL:<poolId>` | LIABILITY | Sponsor matching pool funds held |
| `5000:PROVIDER_FEES:<currency>` | EXPENSE | Provider fee accounting |

Exactly-once donation application (`donation-payment.service.ts`): the success path runs
in one interactive transaction - guarded `updateMany` (`WHERE status = 'PENDING'`), ledger
posting, matching-pool application (bounded by remaining pool funds), campaign counters -
so a webhook, a status-verification poll and a worker retry racing on the same donation
can only ever apply the outcome once, and the ledger posting lands inside the **same
transaction** as the state change. Withdrawal availability subtracts in-flight payouts
(`PENDING`/`APPROVED`/`PROCESSING`) server-side: a client can never confirm a payment or
change a balance. Zero-amount entries are skipped; balances are signed by account type
(ASSET/EXPENSE debit-positive, LIABILITY/REVENUE/EQUITY credit-positive).

## 6. Money as BigInt minor units

- All monetary amounts are **integers in minor units** (kobo/cents) stored as PostgreSQL
  `bigint` and handled in TypeScript as `BigInt` (`schema.prisma` header: floats never
  touch balances).
- Provider responses reporting major-unit values (Flutterwave `app_fee`, PayPal amounts)
  are converted explicitly; totals are never derived from floating point.
- A global `BigIntSerializerInterceptor` serializes BigInt to strings in JSON responses,
  so clients receive exact values (`"amount": "2500000"`).

## 7. Idempotency keys

- `POST /api/v1/donations` accepts an `Idempotency-Key` header; keys are persisted in the
  `IdempotencyKey` table (unique key + expiry), so double-clicks and network retries
  cannot create duplicate donation intents.
- Webhooks are deduplicated at two layers: `WebhookEvent` unique `(provider, eventId)`
  rows and the PENDING-guarded state machine.
- Cron jobs use durable `IdempotencyKey` rows plus Redis `SET NX PX` locks
  ([CRON_JOBS.md](CRON_JOBS.md)).
- Expired idempotency keys are purged by the weekly `kindora-database-maintenance`.

## 8. Storage access rules

| Object class | Rule |
| --- | --- |
| `campaign-image/`, `avatar/`, `campaign-media/` | Public via `STORAGE_PUBLIC_BASE_URL`; never sensitive |
| `document/` | Private; presigned GET (300 s) via `/api/v1/storage/documents/*` (authenticated; traversal rejected) |
| `identity/` (KYC) | Private; staff tooling fetches via **separately issued, short-lived GET presigns** only - never public URLs; admin surfaces expose metadata, not document URLs |
| Upload authorization | Presigned PUTs are authenticated API calls; content types and extensions are whitelisted; keys are server-generated (`<kind>/<userId>/<random>-<name>`) |
| Malware scanning | External requirement (ClamAV sidecar/function) - see [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) |

## 9. Security headers and CSP

### API (`backend/src/main.ts`)

- Helmet enabled with CSP disabled (the API serves JSON only; CSP is enforced at the
  frontend edge); `crossOriginResourcePolicy: cross-origin` so presign/webhook flows work.
- Global prefix `api/v1`; JSON body limit 2 MB; `rawBody` preserved for signatures.
- CORS: explicit allowlist from `CORS_ORIGINS`, `credentials: true`, fixed method and
  header lists (`Content-Type`, `Authorization`, `Idempotency-Key`, `X-Request-Id`) - no
  wildcard origins.
- Global `ValidationPipe`: `whitelist` (unknown DTO fields stripped), `transform: true`.
- Graceful shutdown hooks so in-flight requests finish on redeploys.

### Frontend (`frontend/netlify.toml`, all routes)

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'`; `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob: https:`; `font-src 'self' data:`; `connect-src 'self' https://api.kindora.com https://*.paystack.co https://api.flutterwave.com https://api.stripe.com https://api-m.paypal.com https://api-m.sandbox.paypal.com https://*.sentry.io`; `frame-src https://*.paystack.co https://api.flutterwave.com https://js.stripe.com https://www.paypal.com https://api-m.sandbox.paypal.com`; `worker-src 'self' blob:`; `manifest-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests` |

Extension guidance (adding API/provider hosts): [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md).

## 10. Test-only verification hook - PROVIDER_MODE=mock only

`POST /api/v1/auth/dev/complete-verification` (`devCompleteVerification` in
`auth.controller.ts` / `auth.service.ts`) completes email verification without the email
round-trip. It exists so automated tests and offline demos can activate accounts without
an SMTP inbox.

**This hook is PROVIDER_MODE=mock-only and must never be enabled in production.**

- The service checks `providerMode` and throws `403 ForbiddenException('Not available
  outside mock mode')` in any `live` configuration - the block is hard-coded, not a
  config switch.
- `PROVIDER_MODE=mock` replaces all payment adapters with the deterministic mock and is
  intended exclusively for automated tests, CI (`ci.yml` sets `PROVIDER_MODE: mock`) and
  offline local development.
- `render.yaml` pins `PROVIDER_MODE=live` for deployed services; never change that value
  in production. If mock mode ever ran in production: every "donation" would succeed with
  zero fees, and this verification-bypass endpoint would be callable. Verify
  `PROVIDER_MODE=live` on the go-live checklist ([PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)).

## 11. Data protection notes (NDPR / GDPR)

- **Lawful, minimal PII**: guest donors provide name/email only for the receipt; public
  donor lists never expose guest emails; anonymous donations display as anonymous. KYC
  stores only `idNumberLast4`, never full document numbers.
- **Data subject rights** (access/erasure): user deletion is modelled (`UserStatus.DELETED`
  instead of hard deletes, preserving ledger integrity); export/erasure requests are
  handled with admin tooling plus the audit trail. Ledger and donation rows are financial
  records - retention follows financial-record rules, while PII fields (emails, names) can
  be minimized/redacted.
- **Transfers & hosting**: choose provider regions (Render, object storage) compatible
  with your users' jurisdictions; document them in your privacy policy.
- **Security of processing**: encryption in transit (TLS everywhere), hashed tokens,
  bcrypt(12) passwords, least-privilege service credentials, audit logging.
- Nigeria NDPR/GDPR-style obligations (registration where applicable, breach
  notification, DPO contact) are organizational tasks - wire the published contact
  addresses from [DOMAIN_AND_DNS_SETUP.md](DOMAIN_AND_DNS_SETUP.md) into your policy pages.

## 12. Audit trail and reporting

- `AuditLog` rows record authentication events (register, login, refresh-reuse detection),
  admin actions (refunds with amount/reason, KYC decisions, moderation) with actor, IP and
  metadata - the backbone for incident review.
- `WebhookEvent` records every webhook attempt (valid/invalid, `RECEIVED`/`DUPLICATE`/
  `FAILED`), `EmailLog` records every send/skip, `FraudSignal` records advisory fraud
  flags. `Sentry` (optional DSN) captures server errors.
- Publish a security contact (e.g. `mailto:security@kindora.com` or
  `/.well-known/security.txt`). Do not open public issues for vulnerabilities; include
  reproduction steps and affected endpoints. Treat money-path reports (payment spoofing,
  ledger imbalance, auth bypass) as production incidents.

## 13. Secret management rules

- Secrets live **only** in service environment variables (Render/Netlify dashboards);
  `render.yaml` marks them `sync: false` so they are entered at deploy time, and
  `generateValue: true` creates `JWT_SECRET` / `SESSION_SECRET`.
- Never commit real `.env` files (git-ignored); update `.env.example` templates only.
- Never put secrets in `VITE_` variables (browser-exposed) or in client-side code.
- Rotation playbook and consequences (JWT rotation logs everyone out; provider key
  rotation ordering): [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).
- `DATABASE_URL`, `REDIS_URL`, SMTP and storage keys are all secrets; scope network access
  to the services that need them ([REDIS_SETUP.md](REDIS_SETUP.md)).

Related: [PAYMENT_INTEGRATION.md](PAYMENT_INTEGRATION.md) | [CRON_JOBS.md](CRON_JOBS.md) | [STORAGE_CONFIGURATION.md](STORAGE_CONFIGURATION.md) | [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)

## 18. v1.0.9 payout security addendum — duplicate payout prevention

v1.0.9 closes the remaining payout-side authorization gaps. The controls, in the order an attacker meets them:

1. **Explicit provider lookup outcomes.** A provider lookup returns `FOUND | NOT_FOUND | AMBIGUOUS | ERROR`. NOT_FOUND is produced ONLY by the documented, authoritative not-found response shape of each provider (Paystack: HTTP 404 + `{status:false, message:"Transfer not found"}`; Flutterwave: a successful reference-filtered query with a well-formed empty list). 401/403 → ERROR (intervention), 429/5xx/timeout/reset/malformed/empty/missing-fields → AMBIGUOUS. An ambiguous lookup can therefore never trigger a second transfer — it preserves the reservation and schedules a controlled lookup retry.
2. **Durable settlement-path coordination.** `PayoutSettlementGuard` (one row per withdrawal, PostgreSQL-only — Redis is never consulted for financial correctness) makes manual settlement and provider submission mutually exclusive. Claims are atomic conditional upserts inside the transaction that already holds the withdrawal row lock; `SETTLED` is terminal. The v1.0.8 pre-transaction unresolved check (TOCTOU) was moved INSIDE the settlement transaction, together with checks for pending outbox events and active leases.
3. **Persisted-executor separation.** Submission and final reconciliation validate the approval cycle with the attempt's PERSISTED `initiatedById` (`requireExecutor: true`); a missing or colliding executor invalidates the cycle — no submission, no settlement.
4. **Immutable manual approval snapshots.** Manual settlement is a two-step protocol: authorize the intent (binds a canonical SHA-256 snapshot — withdrawal, requester, amount, currency, destination binding, destination version, channel, MANUAL_SETTLEMENT designation, cycle, both approvers, both approval ids and timestamps — onto BOTH approvals) then settle with the snapshot recomputed and constant-time compared. Legacy withdrawals are never grandfathered.
5. **Database barriers.** Partial UNIQUE index: at most ONE unresolved payout attempt per withdrawal. UNIQUE idempotency keys, provider references, request fingerprints and ledger references. Violations abort the offending transaction.
6. **Recovery discipline.** Expired leases trigger provider reconciliation FIRST; only an authoritative not-found re-arms the SAME attempt with the SAME stable idempotency key and provider reference.
7. **Observability.** Worker-token-protected security metrics (ambiguous/error lookups, expired-lease reclaims, blocked settlements/submissions, prevented duplicates) plus immutable audit events carry full authorization context — never secrets, never full beneficiary PII.

See `docs/PAYOUT_ARCHITECTURE_V1.0.9.md` for the layer-by-layer prevention model and `docs/INCIDENT_RUNBOOK_AMBIGUOUS_PAYOUT.md` for operational response.

---

## v1.0.10 — provider reference integrity, reconciliation lockdown & payout concurrency

The v1.0.10 hardening release closes the four v1.0.9 review findings without
redesigning any control:

1. **Provider lookup identity.** A FOUND lookup result now requires EXACT
   requested-reference identity on the provider's own record — Paystack adopts
   only records whose `data.reference` equals the requested merchant reference
   (id/code-only records are AMBIGUOUS); Flutterwave verifies the list match
   through the detailed record (exact reference + same id) and treats list/detail
   contradictions as AMBIGUOUS. A transfer id, transfer code or database id is
   never a substitute for the logical reference in reference-based recovery.
2. **Flutterwave absence proof.** An empty paginated list without validated,
   internally consistent pagination metadata (required result count, well-typed
   fields, no contradiction with the returned records, no truncation) is
   AMBIGUOUS — the contradictory `{content:[], meta:{total:1}}` class can never
   classify as NOT_FOUND, so it can never arm a duplicate submission.
3. **Locked executor identity.** The final reconciliation locks the payout
   attempt row with an explicit column list that includes `initiatedById` and
   passes THAT identity (read under the row lock) to the approval-cycle
   validator — stale pre-transaction objects, worker payloads and caller-supplied
   identities can never authorize settlement; a missing or colliding locked
   executor blocks settlement with an auditable event.
4. **Concurrency proof.** The seven deterministic payout-concurrency scenarios
   (A–G) on REAL PostgreSQL 17 + Redis 7.2.5 prove manual settlement and
   automated provider submission cannot both settle the same withdrawal — with
   workers crashing, requests in flight, leases expired, ambiguous lookups and
   duplicate workers — always exactly one settlement and one ledger posting.

Reference: `PAYOUT_ARCHITECTURE_V1.0.10.md`, `PROVIDER_INTEGRATION_V1.0.10.md`,
`OUTBOX_RECOVERY_V1.0.10.md`, `MANUAL_SETTLEMENT_PROCEDURES_V1.0.10.md`,
`KINDORA_v1.0.10_TEST_REPORT.md`.
